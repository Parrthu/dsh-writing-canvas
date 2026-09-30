/**
 * 文档存储：草稿、不可变版本历史。
 *
 * 存储布局（位于会话所属工作区下）：
 *   <workspace>/<stateDir>/docs/<docId>/meta.json
 *   <workspace>/<stateDir>/docs/<docId>/v0001.json ...
 *
 * 设计原则：
 * - **每次写入都生成新的不可变版本**，历史版本只读，绝不原地覆盖。
 * - 内容未变化时不产生新版本（按内容哈希判定），避免制造无意义历史。
 * - 同一文档的写入串行化，避免并发写坏索引。
 * - 落盘使用「临时文件 + rename」保证原子性，进程被杀不会留下半截 JSON。
 *
 * @module dsh-writing-canvas/store
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** 计算内容的稳定短哈希（用于判断"内容是否真的变了"）。 */
export function hashContent(content) {
  return createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 16);
}

/** 把版本号格式化为文件名片段：1 -> 'v0001'。 */
function versionFileName(n) {
  return `v${String(n).padStart(4, '0')}.json`;
}

/** 原子写：先写临时文件再 rename，避免读到半截文件。 */
async function writeJsonAtomic(filePath, value) {
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(tmp, filePath);
}

/**
 * 校验 docId，避免路径穿越。
 * @param docId - 客户端传入的文档标识。
 * @returns 合法则返回自身，否则抛错。
 */
export function assertSafeDocId(docId) {
  if (typeof docId !== 'string' || docId === '' || docId.length > 200) {
    throw new Error('docId 非法');
  }
  if (docId.includes('/') || docId.includes('\\') || docId.includes('..') || docId.startsWith('.')) {
    throw new Error('docId 含非法字符');
  }
  return docId;
}

/**
 * 单个工作区之上的文档存储。
 */
export class DocumentStore {
  /**
   * @param workspacePath - 工作区绝对路径。
   * @param stateDir - 相对工作区的状态目录名。
   */
  constructor(workspacePath, stateDir) {
    this.workspacePath = workspacePath;
    this.stateDir = stateDir;
    /** 每个文档一条写入链，保证同文档写入串行。 */
    this.writeChains = new Map();
  }

  /** 该工作区的写作状态根目录。 */
  get root() {
    return join(this.workspacePath, this.stateDir);
  }

  /** 某个文档的目录。 */
  docDir(docId) {
    return join(this.root, 'docs', assertSafeDocId(docId));
  }

  /** 把任务排进指定文档的串行链，避免并发写冲突。 */
  #enqueue(docId, task) {
    const previous = this.writeChains.get(docId) ?? Promise.resolve();
    const next = previous.then(task, task);
    // 链上只保留"已完成"的占位，避免内存泄漏与未处理拒绝。
    this.writeChains.set(
      docId,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  }

  /**
   * 列出本工作区内所有文档的摘要（供工作台的总览视图使用）。
   * @returns 文档摘要数组，按更新时间倒序。
   */
  async listDocuments() {
    const docsRoot = join(this.root, 'docs');
    if (!existsSync(docsRoot)) return [];
    const entries = await readdir(docsRoot, { withFileTypes: true });
    const out = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const metaPath = join(docsRoot, entry.name, 'meta.json');
      if (!existsSync(metaPath)) continue;
      try {
        const meta = JSON.parse(await readFile(metaPath, 'utf8'));
        out.push({
          docId: meta.docId ?? entry.name,
          title: meta.title ?? '未命名文档',
          latest: meta.latest ?? 0,
          versionCount: meta.versionCount ?? meta.latest ?? 0,
          format: meta.format ?? { kind: 'markdown' },
          createdAt: meta.createdAt ?? null,
          updatedAt: meta.updatedAt ?? null,
          workspace: this.workspacePath,
        });
      } catch {
        // 损坏的 meta 不阻断整体列表，跳过即可。
      }
    }
    out.sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')));
    return out;
  }

  /**
   * 读取文档汇总信息。
   * @param docId - 文档标识。
   * @returns 汇总信息；文档不存在时返回 null。
   */
  async readDoc(docId) {
    assertSafeDocId(docId);
    const dir = this.docDir(docId);
    const metaPath = join(dir, 'meta.json');
    if (!existsSync(metaPath)) return null;
    const meta = JSON.parse(await readFile(metaPath, 'utf8'));
    // 只有 meta、还没有任何版本的文档是合法状态：选定写作类型（或新建空文档）时
    // 会先落 meta，正文要等第一次写入才产生 v1。此时 meta.latest 为 0，
    // 必须直接给 null，不能交给 readVersion —— 它会以「版本号必须是正整数」抛错，
    // 导致整个画布读不出文档（界面表现为空白）。
    const latest = Number.isInteger(meta.latest) && meta.latest >= 1 ? await this.readVersion(docId, meta.latest) : null;
    return { meta, latest, workspace: this.workspacePath, stateDir: this.stateDir };
  }

  /**
   * 读取某个具体版本。
   * @param docId - 文档标识。
   * @param n - 版本号。
   * @returns 版本记录，不存在时返回 null。
   */
  async readVersion(docId, n) {
    assertSafeDocId(docId);
    if (!Number.isInteger(n) || n < 1) throw new Error('版本号必须是正整数');
    const file = join(this.docDir(docId), versionFileName(n));
    if (!existsSync(file)) return null;
    return JSON.parse(await readFile(file, 'utf8'));
  }

  /**
   * 设定文档的写作类型（只改元信息，不产生新的正文版本）。
   * @param docId - 文档标识。
   * @param typeId - 写作类型 id。
   * @returns 更新后的 meta。
   */
  async setType(docId, typeId) {
    assertSafeDocId(docId);
    return this.#enqueue(docId, async () => {
      const dir = this.docDir(docId);
      await mkdir(dir, { recursive: true });
      const metaPath = join(dir, 'meta.json');
      const existing = existsSync(metaPath) ? JSON.parse(await readFile(metaPath, 'utf8')) : null;
      const at = new Date().toISOString();
      const meta = {
        docId,
        title: existing?.title ?? '未命名文档',
        format: existing?.format ?? { kind: 'markdown' },
        createdAt: existing?.createdAt ?? at,
        updatedAt: at,
        latest: existing?.latest ?? 0,
        latestHash: existing?.latestHash ?? null,
        versionCount: existing?.versionCount ?? 0,
        writingType: typeId,
      };
      await writeJsonAtomic(metaPath, meta);
      return meta;
    });
  }

  /**
   * 只改文档的格式集，不产生新版本。
   *
   * 用户在画布上**选中一个格式集就立即生效**（不再需要点对勾确认），
   * 所以这条路径必须和 setType 一样：只写 meta、绝不动正文、绝不生成版本。
   *
   * @param docId - 文档标识。
   * @param setId - 格式集 id；传空串表示回到默认。
   * @returns 写入后的 meta。
   */
  async setFormat(docId, setId) {
    assertSafeDocId(docId);
    return this.#enqueue(docId, async () => {
      const dir = this.docDir(docId);
      await mkdir(dir, { recursive: true });
      const metaPath = join(dir, 'meta.json');
      const existing = existsSync(metaPath) ? JSON.parse(await readFile(metaPath, 'utf8')) : null;
      const at = new Date().toISOString();
      const id = typeof setId === 'string' ? setId.trim() : '';
      // 传空串就删掉 set 字段，读的时候会退回第一个可用格式集。
      const nextFormat = { ...(existing?.format ?? { kind: 'markdown' }) };
      if (id === '') delete nextFormat.set;
      else nextFormat.set = id;
      const meta = {
        docId,
        title: existing?.title ?? '未命名文档',
        format: nextFormat,
        createdAt: existing?.createdAt ?? at,
        updatedAt: at,
        latest: existing?.latest ?? 0,
        latestHash: existing?.latestHash ?? null,
        versionCount: existing?.versionCount ?? 0,
        writingType: existing?.writingType,
      };
      await writeJsonAtomic(metaPath, meta);
      return meta;
    });
  }

  /**
   * 列出全部版本，按版本号升序（不含正文，供历史列表使用）。
   * @param docId - 文档标识。
   * @returns 版本摘要数组。
   */
  async listVersions(docId) {
    assertSafeDocId(docId);
    const dir = this.docDir(docId);
    if (!existsSync(dir)) return [];
    const names = await readdir(dir);
    const numbers = names
      .filter((name) => /^v\d{4}\.json$/.test(name))
      .map((name) => Number(name.slice(1, 5)))
      .sort((a, b) => a - b);
    const out = [];
    for (const n of numbers) {
      const record = JSON.parse(await readFile(join(dir, versionFileName(n)), 'utf8'));
      out.push({
        n: record.n,
        at: record.at,
        source: record.source,
        note: record.note,
        bytes: record.bytes,
        hash: record.hash,
      });
    }
    return out;
  }

  /**
   * 写入新版本。
   *
   * 内容与最新版本完全一致时不创建新版本，直接返回现状——这样自动保存的
   * 轮询不会把历史刷成噪音。
   *
   * @param docId - 文档标识。
   * @param content - 正文。
   * @param options - source（user/agent/restore）、note、title。
   * @returns 写入后的文档汇总信息。
   */
  async saveDoc(docId, content, options = {}) {
    assertSafeDocId(docId);
    if (typeof content !== 'string') throw new Error('content 必须是字符串');

    return this.#enqueue(docId, async () => {
      const dir = this.docDir(docId);
      await mkdir(dir, { recursive: true });

      const hash = hashContent(content);
      const metaPath = join(dir, 'meta.json');
      const existing = existsSync(metaPath) ? JSON.parse(await readFile(metaPath, 'utf8')) : null;

      // 空内容保护：**绝不允许用空白内容静默覆盖一份非空文档**。
      //
      // 这道防线来自 ChatGPT Canvas 的头号翻车点（静默覆盖用户内容）。空保存
      // 可能是误触、可能是界面在重载期间状态未就绪，也可能是用户真的想清空——
      // 前两种情况下静默写入就是数据丢失。因此这里一律拦下，只有调用方显式
      // 传 allowEmpty: true 才允许清空。
      if (options.allowEmpty !== true && content.trim() === '' && existing !== null && existing.latest > 0) {
        const previous = await this.readVersion(docId, existing.latest);
        if (previous !== null && String(previous.content).trim() !== '') {
          return {
            emptyRejected: true,
            meta: existing,
            latest: previous,
            workspace: this.workspacePath,
            stateDir: this.stateDir,
          };
        }
      }

      // 冲突检测：客户端声明它基于哪个版本编辑。若服务端已经前进（例如 Agent
      // 期间写入过新版本），**不写入**，把决定权交回用户，绝不静默覆盖。
      if (
        options.force !== true &&
        Number.isInteger(options.baseVersion) &&
        existing !== null &&
        existing.latest !== options.baseVersion
      ) {
        const latest = await this.readVersion(docId, existing.latest);
        return { conflict: true, meta: existing, latest, workspace: this.workspacePath, stateDir: this.stateDir };
      }

      if (existing !== null && existing.latestHash === hash) {
        const latest = await this.readVersion(docId, existing.latest);
        // 正文没变就不生成新版本——但**改了标题必须写回**。
        // 否则「只改标题」会被这里静默吞掉，界面看起来像保存成功、标题却没变。
        const nextTitle =
          typeof options.title === 'string' && options.title !== '' ? options.title : existing.title;
        if (nextTitle !== existing.title) {
          const meta = { ...existing, title: nextTitle, updatedAt: new Date().toISOString() };
          await writeJsonAtomic(metaPath, meta);
          return { meta, latest, unchanged: true, workspace: this.workspacePath, stateDir: this.stateDir };
        }
        return { meta: existing, latest, unchanged: true, workspace: this.workspacePath, stateDir: this.stateDir };
      }

      const n = (existing?.latest ?? 0) + 1;
      const at = new Date().toISOString();
      const record = {
        n,
        at,
        source: typeof options.source === 'string' ? options.source : 'user',
        note: typeof options.note === 'string' ? options.note : '',
        content,
        bytes: Buffer.byteLength(content, 'utf8'),
        hash,
      };
      await writeJsonAtomic(join(dir, versionFileName(n)), record);

      const meta = {
        docId,
        title: typeof options.title === 'string' && options.title !== '' ? options.title : existing?.title ?? '未命名文档',
        format: existing?.format ?? { kind: 'markdown' },
        createdAt: existing?.createdAt ?? at,
        updatedAt: at,
        latest: n,
        latestHash: hash,
        versionCount: n,
        // 写作类型是文档级设置，由 setType 写入、必须跨版本保留。
        // 这里若重建 meta 时不带上它，每写一次正文就会把用户的类型选择清掉
        // （界面表现：选好「创意写作」，下一次写入后变回「未指定」）。
        writingType:
          typeof options.writingType === 'string' && options.writingType !== ''
            ? options.writingType
            : existing?.writingType,
      };
      await writeJsonAtomic(metaPath, meta);

      const latest = await this.readVersion(docId, n);
      return { meta, latest, unchanged: false, workspace: this.workspacePath, stateDir: this.stateDir };
    });
  }

  /**
   * 把一个历史版本的内容作为**新版本**写回（还原不是回退，历史依然完整）。
   * @param docId - 文档标识。
   * @param n - 要还原到的版本号。
   * @returns 写入后的文档汇总信息。
   */
  async restoreVersion(docId, n) {
    const record = await this.readVersion(docId, n);
    if (record === null) throw new Error(`版本 v${n} 不存在`);
    return this.saveDoc(docId, record.content, {
      source: 'restore',
      note: `还原自 v${String(n).padStart(4, '0')}`,
    });
  }
}
