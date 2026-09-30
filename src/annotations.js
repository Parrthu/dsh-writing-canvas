/**
 * 批注存储。
 *
 * 批注是「对话流 + 画布」之间最短的那条反馈回路：用户在画布里选中一段文字，
 * 说要改什么，Agent 读到这条批注再动手。硬约束第 8 条要求「用户未确认的批注
 * 不改变正文」，所以批注与正文分开存放，只有状态为 resolved 才代表已处理。
 *
 * 位置漂移问题（真实存在，不能假装没有）：批注记录的是相对于**某个版本**的
 * 字符区间，正文一改区间就可能失效。因此每条批注同时保存原文片段 quote，
 * 读取时若区间对不上就按 quote 重新定位；再找不到就标记 anchorLost，
 * 界面显示「需重新标注」，而不是悄悄指到错误的位置。
 *
 * @module dsh-writing-canvas/annotations
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** 允许的批注种类。 */
export const ANNOTATION_KINDS = [
  'comment',
  'rewrite',
  'expand',
  'shorten',
  'polish',
  'continue',
  'ask',
];

/** 允许的状态。 */
export const ANNOTATION_STATUSES = ['open', 'resolved', 'dismissed'];

/** 生成一个短 id。 */
function newId() {
  return `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

/** 原子写 JSON。 */
async function writeJsonAtomic(filePath, value) {
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(tmp, filePath);
}

/**
 * 在正文里按 quote 重新定位一段文字。
 * @param content - 当前正文。
 * @param quote - 原文片段。
 * @param hintStart - 原区间起点（优先从这附近找）。
 * @returns { start, end } 或 null。
 */
function locateQuote(content, quote, hintStart) {
  if (typeof quote !== 'string' || quote === '') return null;
  const index = content.indexOf(quote);
  if (index === -1) return null;
  if (typeof hintStart !== 'number') return { start: index, end: index + quote.length };

  // 有多个候选时，取离原位置最近的那个。
  let best = index;
  let cursor = index;
  for (;;) {
    const next = content.indexOf(quote, cursor + 1);
    if (next === -1) break;
    if (Math.abs(next - hintStart) < Math.abs(best - hintStart)) best = next;
    cursor = next;
  }
  return { start: best, end: best + quote.length };
}

/**
 * 单个工作区之上的批注存储。
 */
export class AnnotationStore {
  /**
   * @param workspacePath - 工作区绝对路径。
   * @param stateDir - 相对工作区的状态目录名。
   */
  constructor(workspacePath, stateDir) {
    this.workspacePath = workspacePath;
    this.stateDir = stateDir;
    /** 每个文档一条写入链，避免并发写坏文件。 */
    this.chains = new Map();
  }

  /** 某个文档的批注文件路径。 */
  #file(docId) {
    return join(this.workspacePath, this.stateDir, 'docs', docId, 'annotations.json');
  }

  /** 串行化同一文档的写入。 */
  #enqueue(docId, task) {
    const previous = this.chains.get(docId) ?? Promise.resolve();
    const next = previous.then(task, task);
    this.chains.set(
      docId,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  }

  /** 读取原始记录。 */
  async #read(docId) {
    const file = this.#file(docId);
    if (!existsSync(file)) return { version: 1, items: [] };
    try {
      const parsed = JSON.parse(await readFile(file, 'utf8'));
      return { version: 1, items: Array.isArray(parsed?.items) ? parsed.items : [] };
    } catch {
      // 文件损坏时不让整条链路失败，返回空并保留错误可见性。
      return { version: 1, items: [], corrupted: true };
    }
  }

  /**
   * 列出批注；给定 content 时顺带把区间重新对齐到当前正文。
   * @param docId - 文档标识。
   * @param content - 当前正文（可选）。
   * @returns 批注数组。
   */
  async list(docId, content) {
    const { items, corrupted } = await this.#read(docId);
    const decorated = items.map((item) => {
      if (typeof content !== 'string') return { ...item, anchorLost: false };
      const current = content.slice(item.range?.start ?? 0, item.range?.end ?? 0);
      if (current === item.quote) return { ...item, anchorLost: false };
      const relocated = locateQuote(content, item.quote, item.range?.start);
      if (relocated === null) return { ...item, anchorLost: true };
      return { ...item, range: relocated, anchorLost: false };
    });
    return corrupted === true ? decorated : decorated;
  }

  /**
   * 新建批注。
   * @param docId - 文档标识。
   * @param input - { quote, range, kind, instruction, author, anchorVersion }
   * @returns 新建的批注。
   */
  async create(docId, input) {
    return this.#enqueue(docId, async () => {
      const file = this.#file(docId);
      await mkdir(join(this.workspacePath, this.stateDir, 'docs', docId), { recursive: true });
      const { items } = await this.#read(docId);
      const at = new Date().toISOString();
      const kind = ANNOTATION_KINDS.includes(input.kind) ? input.kind : 'comment';
      const annotation = {
        id: newId(),
        createdAt: at,
        updatedAt: at,
        author: input.author === 'agent' ? 'agent' : 'user',
        kind,
        quote: typeof input.quote === 'string' ? input.quote : '',
        range: {
          start: Number.isInteger(input.range?.start) ? input.range.start : 0,
          end: Number.isInteger(input.range?.end) ? input.range.end : 0,
        },
        anchorVersion: Number.isInteger(input.anchorVersion) ? input.anchorVersion : null,
        instruction: typeof input.instruction === 'string' ? input.instruction : '',
        status: 'open',
        thread: [],
        resolution: null,
      };
      items.push(annotation);
      await writeJsonAtomic(file, { version: 1, items });
      return annotation;
    });
  }

  /**
   * 更新批注（状态、追加回复、更新指示）。
   * @param docId - 文档标识。
   * @param id - 批注 id。
   * @param patch - { status?, reply?, instruction? }
   * @returns 更新后的批注，找不到时 null。
   */
  async update(docId, id, patch) {
    return this.#enqueue(docId, async () => {
      const file = this.#file(docId);
      const { items } = await this.#read(docId);
      const index = items.findIndex((item) => item.id === id);
      if (index === -1) return null;
      const current = items[index];
      const at = new Date().toISOString();
      const next = { ...current, updatedAt: at };

      if (typeof patch.status === 'string' && ANNOTATION_STATUSES.includes(patch.status)) {
        next.status = patch.status;
        if (patch.status === 'resolved') {
          next.resolution = {
            version: Number.isInteger(patch.resolvedVersion) ? patch.resolvedVersion : null,
            note: typeof patch.resolutionNote === 'string' ? patch.resolutionNote : '',
            at,
          };
        }
      }
      if (typeof patch.instruction === 'string') next.instruction = patch.instruction;
      if (typeof patch.reply === 'string' && patch.reply !== '') {
        next.thread = [
          ...(Array.isArray(current.thread) ? current.thread : []),
          { author: patch.author === 'agent' ? 'agent' : 'user', text: patch.reply, at },
        ];
      }

      items[index] = next;
      await writeJsonAtomic(file, { version: 1, items });
      return next;
    });
  }

  /**
   * 删除批注。
   * @param docId - 文档标识。
   * @param id - 批注 id。
   * @returns 是否删除成功。
   */
  async remove(docId, id) {
    return this.#enqueue(docId, async () => {
      const file = this.#file(docId);
      const { items } = await this.#read(docId);
      const next = items.filter((item) => item.id !== id);
      if (next.length === items.length) return false;
      await writeJsonAtomic(file, { version: 1, items: next });
      return true;
    });
  }
}
