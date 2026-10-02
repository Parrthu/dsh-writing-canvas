/**
 * 修改建议存储。
 *
 * 这是「建议通道」与「执行通道」的分离点，也是 ChatGPT Canvas 调研里最重要的一条教训：
 * 直接把 AI 的改写写进正文，用户就失去了对自己文字的最终控制权。
 *
 * 因此：
 *   - Agent 只能**提议**（create），绝不改动正文
 *   - 只有用户显式接受（accept）时，才把 proposed 写进正文并生成新版本
 *   - 拒绝（reject）只改状态，正文一字不动
 *
 * 位置漂移与批注同样处理：区间对不上时按 original 重新定位，再找不到就标 anchorLost。
 *
 * @module dsh-writing-canvas/suggestions
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** 生成短 id。 */
function newId() {
  return `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

/** 原子写 JSON。 */
/**
 * 把损坏的存储文件挪到一边留存（.corrupted-<时间戳> 后缀）。
 * 建议文件损坏时若只是当空数组用，下一次写入就会把文件静默清掉。
 */
async function quarantineCorruptedFile(filePath) {
  if (!existsSync(filePath)) return;
  try {
    await rename(filePath, `${filePath}.corrupted-${Date.now()}`);
  } catch {
    // 挪不动就维持原状：不阻断正常功能。
  }
}

async function writeJsonAtomic(filePath, value) {
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(tmp, filePath);
}

/**
 * 在正文里重新定位一段原文。
 * @param content - 当前正文。
 * @param needle - 原文片段。
 * @param hintStart - 原区间起点。
 * @returns { start, end } 或 null。
 */
function locate(content, needle, hintStart) {
  if (typeof needle !== 'string' || needle === '') return null;
  const first = content.indexOf(needle);
  if (first === -1) return null;
  if (typeof hintStart !== 'number') return { start: first, end: first + needle.length };
  let best = first;
  let cursor = first;
  for (;;) {
    const next = content.indexOf(needle, cursor + 1);
    if (next === -1) break;
    if (Math.abs(next - hintStart) < Math.abs(best - hintStart)) best = next;
    cursor = next;
  }
  return { start: best, end: best + needle.length };
}

/**
 * 单个工作区之上的建议存储。
 */
export class SuggestionStore {
  /**
   * @param workspacePath - 工作区绝对路径。
   * @param stateDir - 相对工作区的状态目录名。
   */
  constructor(workspacePath, stateDir) {
    this.workspacePath = workspacePath;
    this.stateDir = stateDir;
    this.chains = new Map();
  }

  /** 建议文件路径。 */
  #file(docId) {
    return join(this.workspacePath, this.stateDir, 'docs', docId, 'suggestions.json');
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

  /** 原始读取。 */
  async #read(docId) {
    const file = this.#file(docId);
    if (!existsSync(file)) return [];
    try {
      const parsed = JSON.parse(await readFile(file, 'utf8'));
      return Array.isArray(parsed?.items) ? parsed.items : [];
    } catch {
      // 与 annotations 同款处理：隔离坏文件，避免下次写入静默清库。
      await quarantineCorruptedFile(file);
      return [];
    }
  }

  /**
   * 列出建议，并把区间对齐到当前正文。
   * @param docId - 文档标识。
   * @param content - 当前正文（可选）。
   * @returns 建议数组（pending 在前）。
   */
  async list(docId, content) {
    const items = await this.#read(docId);
    const decorated = items.map((item) => {
      if (typeof content !== 'string') return { ...item, anchorLost: false };
      if (content.slice(item.range?.start ?? 0, item.range?.end ?? 0) === item.original) {
        return { ...item, anchorLost: false };
      }
      const relocated = locate(content, item.original, item.range?.start);
      if (relocated === null) return { ...item, anchorLost: true };
      return { ...item, range: relocated, anchorLost: false };
    });
    const rank = { pending: 0, accepted: 1, rejected: 2 };
    return decorated.sort((a, b) => (rank[a.status] ?? 3) - (rank[b.status] ?? 3));
  }

  /**
   * 新建建议（**不改动正文**）。
   * @param docId - 文档标识。
   * @param input - { original, proposed, reason, range, anchorVersion, author }
   * @returns 新建的建议。
   */
  async create(docId, input) {
    return this.#enqueue(docId, async () => {
      await mkdir(join(this.workspacePath, this.stateDir, 'docs', docId), { recursive: true });
      const items = await this.#read(docId);
      const at = new Date().toISOString();
      const suggestion = {
        id: newId(),
        createdAt: at,
        author: input.author === 'user' ? 'user' : 'agent',
        original: typeof input.original === 'string' ? input.original : '',
        proposed: typeof input.proposed === 'string' ? input.proposed : '',
        reason: typeof input.reason === 'string' ? input.reason : '',
        range: {
          start: Number.isInteger(input.range?.start) ? input.range.start : 0,
          end: Number.isInteger(input.range?.end) ? input.range.end : 0,
        },
        anchorVersion: Number.isInteger(input.anchorVersion) ? input.anchorVersion : null,
        status: 'pending',
        decidedAt: null,
      };
      items.push(suggestion);
      await writeJsonAtomic(this.#file(docId), { version: 1, items });
      return suggestion;
    });
  }

  /**
   * 取出单条建议。
   * @param docId - 文档标识。
   * @param id - 建议 id。
   * @returns 建议或 null。
   */
  async get(docId, id) {
    const items = await this.#read(docId);
    return items.find((item) => item.id === id) ?? null;
  }

  /**
   * 标记建议状态。
   * @param docId - 文档标识。
   * @param id - 建议 id。
   * @param status - 'accepted' | 'rejected' | 'pending'
   * @returns 更新后的建议，找不到时 null。
   */
  async mark(docId, id, status) {
    return this.#enqueue(docId, async () => {
      const items = await this.#read(docId);
      const index = items.findIndex((item) => item.id === id);
      if (index === -1) return null;
      const next = { ...items[index], status, decidedAt: new Date().toISOString() };
      items[index] = next;
      await writeJsonAtomic(this.#file(docId), { version: 1, items });
      return next;
    });
  }

  /**
   * 删除建议。
   * @param docId - 文档标识。
   * @param id - 建议 id。
   * @returns 是否删除。
   */
  async remove(docId, id) {
    return this.#enqueue(docId, async () => {
      const items = await this.#read(docId);
      const next = items.filter((item) => item.id !== id);
      if (next.length === items.length) return false;
      await writeJsonAtomic(this.#file(docId), { version: 1, items: next });
      return true;
    });
  }
}

/**
 * 把一条建议应用到正文上（纯函数，便于测试）。
 *
 * @param content - 当前正文。
 * @param suggestion - 建议（含 range / original / proposed）。
 * @returns { ok, content, message }
 */
export function applySuggestion(content, suggestion) {
  const { start, end } = suggestion.range ?? {};
  if (!Number.isInteger(start) || !Number.isInteger(end)) {
    return { ok: false, content, message: '建议的区间非法。' };
  }
  const current = content.slice(start, end);
  if (current !== suggestion.original) {
    // 区间已经对不上：按原文重新定位，避免改错地方。
    const relocated = locate(content, suggestion.original, start);
    if (relocated === null) {
      return { ok: false, content, message: '原文已不在正文中，无法应用（需重新生成建议）。' };
    }
    return {
      ok: true,
      content: content.slice(0, relocated.start) + suggestion.proposed + content.slice(relocated.end),
      message: '原文位置有变动，已按内容重新定位后应用。',
    };
  }
  return {
    ok: true,
    content: content.slice(0, start) + suggestion.proposed + content.slice(end),
    message: '已应用。',
  };
}
