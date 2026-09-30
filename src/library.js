/**
 * 用户库：自定义格式集（Set）与自定义写作类型。
 *
 * 设计取向（用户定的）：
 *   - 格式只需要一个概念：**Set**。用户用自然语言描述、或丢一个模板过来，
 *     Agent 把它整理成一个 Set，命名后以后一键套用。
 *   - Set 分两种载体：`markdown`（标题层级、正文体例、分隔线这类**写作体例**）
 *     与 `docx`（字体、字号、行距、页边距这类**版式规格**）。
 *     不需要导出 DOCX 时就选 markdown Set，正文照样有规整的标题与分隔线。
 *   - 自定义写作类型同样属于用户，存在工作区里，不需要做成插件行。
 *
 * 存储（都在工作区下，随稿子走）：
 *   <workspace>/<stateDir>/library/format-sets.json
 *   <workspace>/<stateDir>/library/custom-types.json
 *
 * @module dsh-writing-canvas/library
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** 生成短 id。 */
function newId(prefix) {
  return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** 原子写 JSON。 */
async function writeJsonAtomic(filePath, value) {
  await mkdir(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(tmp, filePath);
}

/** 读取一个 JSON 集合。 */
async function readCollection(filePath, key) {
  if (!existsSync(filePath)) return [];
  try {
    const parsed = JSON.parse(await readFile(filePath, 'utf8'));
    return Array.isArray(parsed?.[key]) ? parsed[key] : [];
  } catch {
    return [];
  }
}

/**
 * 给 Set 起一个智能名字：优先用户给的名字，其次从描述里提炼，最后用兜底。
 * @param name - 用户指定的名字。
 * @param description - 用户描述。
 * @param kind - 载体。
 * @returns 名字。
 */
export function suggestSetName(name, description, kind) {
  if (typeof name === 'string' && name.trim() !== '') return name.trim().slice(0, 40);
  const text = String(description ?? '').replace(/\s+/g, ' ').trim();
  if (text !== '') {
    // 取描述里最有信息量的前若干字，去掉标点。
    const cleaned = text.replace(/[，。；、,.;:：！!？?]/g, ' ').replace(/\s+/g, ' ').trim();
    const words = cleaned.split(' ').filter((w) => w.length > 0);
    const candidate = words.slice(0, 3).join(' ');
    if (candidate.length >= 2) return candidate.slice(0, 24);
  }
  return kind === 'docx' ? '自定义版式' : '自定义体例';
}

/**
 * 用户库（每个工作区一份）。
 */
export class WorkspaceLibrary {
  /**
   * @param workspacePath - 工作区绝对路径。
   * @param stateDir - 状态目录名。
   */
  constructor(workspacePath, stateDir) {
    this.root = join(workspacePath, stateDir, 'library');
    this.setsFile = join(this.root, 'format-sets.json');
    this.typesFile = join(this.root, 'custom-types.json');
    this.typePromptsFile = join(this.root, 'type-prompts.json');
  }

  // ------------------------------------------------------------ 写作类型提示词覆盖

  /**
   * 列出用户改过的写作类型提示词。
   * @returns { [typeId]: text }
   */
  async listTypePrompts() {
    const rows = await readCollection(this.typePromptsFile, 'prompts');
    const map = {};
    for (const row of rows) {
      if (row !== null && typeof row === 'object' && typeof row.typeId === 'string' && typeof row.text === 'string') {
        map[row.typeId] = row.text;
      }
    }
    return map;
  }

  /**
   * 保存（或清除）某个写作类型的提示词覆盖。
   *
   * 用户点开「提示词」自己改的内容存在这里；注入系统提示时优先用它，
   * 这样用户不必等插件发布就能调整某个文种的约束。
   * 传空字符串表示**恢复内置**（删掉覆盖）。
   *
   * @param typeId - 写作类型 id（内置如 `creative`，自定义如 `custom:xxx`）。
   * @param text - 覆盖文本；空串表示删除覆盖。
   * @returns 保存后的覆盖映射。
   */
  async setTypePrompt(typeId, text) {
    const id = String(typeId ?? '').trim();
    if (id === '') throw new Error('缺少写作类型 id');
    const rows = await readCollection(this.typePromptsFile, 'prompts');
    const rest = rows.filter((row) => row === null || typeof row !== 'object' || row.typeId !== id);
    const value = typeof text === 'string' ? text : '';
    // 单条上限：提示词再长也不该到几十 KB，超了多半是误粘贴。
    const next = value.trim() === '' ? rest : [...rest, { typeId: id, text: value.slice(0, 20000), updatedAt: new Date().toISOString() }];
    await writeJsonAtomic(this.typePromptsFile, { version: 1, prompts: next });
    const map = {};
    for (const row of next) map[row.typeId] = row.text;
    return map;
  }

  // ------------------------------------------------------------ 格式集

  /** 列出用户自定义的格式集。 */
  async listSets() {
    return readCollection(this.setsFile, 'sets');
  }

  /**
   * 新建一个格式集。
   * @param input - { name, description, kind, definition, createdBy }
   * @returns 新建的 Set。
   */
  async createSet(input) {
    const sets = await readCollection(this.setsFile, 'sets');
    const kind = input.kind === 'docx' ? 'docx' : 'markdown';
    const set = {
      id: newId('set'),
      name: suggestSetName(input.name, input.description, kind),
      description: typeof input.description === 'string' ? input.description.slice(0, 500) : '',
      kind,
      definition: input.definition ?? {},
      createdBy: input.createdBy === 'user' ? 'user' : 'agent',
      createdAt: new Date().toISOString(),
    };
    sets.push(set);
    await writeJsonAtomic(this.setsFile, { version: 1, sets });
    return set;
  }

  /**
   * 重命名或修改一个格式集。
   * @param id - Set id。
   * @param patch - { name?, description?, definition? }
   * @returns 更新后的 Set 或 null。
   */
  async updateSet(id, patch) {
    const sets = await readCollection(this.setsFile, 'sets');
    const index = sets.findIndex((item) => item.id === id);
    if (index === -1) return null;
    const next = { ...sets[index] };
    if (typeof patch.name === 'string' && patch.name.trim() !== '') next.name = patch.name.trim().slice(0, 40);
    if (typeof patch.description === 'string') next.description = patch.description.slice(0, 500);
    if (patch.definition !== undefined) next.definition = patch.definition;
    next.updatedAt = new Date().toISOString();
    sets[index] = next;
    await writeJsonAtomic(this.setsFile, { version: 1, sets });
    return next;
  }

  /** 删除一个格式集。 */
  async removeSet(id) {
    const sets = await readCollection(this.setsFile, 'sets');
    const next = sets.filter((item) => item.id !== id);
    if (next.length === sets.length) return false;
    await writeJsonAtomic(this.setsFile, { version: 1, sets: next });
    return true;
  }

  // ------------------------------------------------------------ 自定义写作类型

  /** 列出用户自定义的写作类型。 */
  async listTypes() {
    return readCollection(this.typesFile, 'types');
  }

  /**
   * 新建/覆盖一个自定义写作类型。
   * @param input - { id, label, summary, constraints, mustConfirm, structure, checklist, format }
   * @returns 类型定义。
   */
  async upsertType(input) {
    const types = await readCollection(this.typesFile, 'types');
    const id = String(input.id ?? '').trim().replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 60);
    if (id === '') throw new Error('自定义写作类型必须有 id');
    const record = {
      id: `custom:${id}`,
      slug: id,
      label: String(input.label ?? '').trim().slice(0, 40),
      summary: String(input.summary ?? '').trim().slice(0, 200),
      constraints: Array.isArray(input.constraints) ? input.constraints.slice(0, 30) : [],
      mustConfirm: Array.isArray(input.mustConfirm) ? input.mustConfirm.slice(0, 15) : [],
      structure: Array.isArray(input.structure) ? input.structure.slice(0, 30) : [],
      checklist: Array.isArray(input.checklist) ? input.checklist.slice(0, 30) : [],
      format: input.format ?? { kind: 'markdown' },
      custom: true,
      createdBy: input.createdBy === 'user' ? 'user' : 'agent',
      updatedAt: new Date().toISOString(),
    };
    if (record.label === '') throw new Error('自定义写作类型必须有名称');
    const index = types.findIndex((item) => item.id === record.id);
    if (index === -1) types.push(record);
    else types[index] = { ...types[index], ...record };
    await writeJsonAtomic(this.typesFile, { version: 1, types });
    return record;
  }

  /** 删除一个自定义写作类型。 */
  async removeType(id) {
    const types = await readCollection(this.typesFile, 'types');
    const next = types.filter((item) => item.id !== id);
    if (next.length === types.length) return false;
    await writeJsonAtomic(this.typesFile, { version: 1, types: next });
    return true;
  }
}

/**
 * 内置的 Markdown 体例 Set。
 *
 * 用户说「某些时候不用导出 DOCX，直接用 MD」——那就需要把标题层级、正文体例、
 * 分隔线这些**写作体例**也准备成可套用的 Set，而不是只管 DOCX 版式。
 */
export const BUILTIN_MARKDOWN_SETS = [
  {
    id: 'md-standard',
    name: '标准 Markdown',
    description: '标题用 #/##/###，段落之间空一行，分隔线用 ---。最通用。',
    kind: 'markdown',
    builtin: true,
    definition: {
      titlePrefix: '# ',
      headingPrefixes: ['## ', '### ', '#### '],
      paragraphSpacing: 'blank-line',
      rule: '---',
      listMarker: '- ',
      orderedMarker: '1. ',
      quotePrefix: '> ',
      firstLineIndent: 0,
    },
  },
  {
    id: 'md-cn-official',
    name: '中文书面体例',
    description: '层级序数用「一、」「（一）」「1.」，段落首行缩进两个全角空格，分隔线用 ---。',
    kind: 'markdown',
    builtin: true,
    definition: {
      titlePrefix: '# ',
      headingPrefixes: ['## 一、', '### （一）', '#### 1. '],
      paragraphSpacing: 'blank-line',
      firstLineIndent: 2,
      indentChar: '　',
      rule: '---',
      listMarker: '- ',
      orderedMarker: '1. ',
      quotePrefix: '> ',
    },
  },
  {
    id: 'md-plain',
    name: '极简体例',
    description: '只用一级标题与正文，不加深层标题，分隔线用三个短横。适合随笔与短文。',
    kind: 'markdown',
    builtin: true,
    definition: {
      titlePrefix: '# ',
      headingPrefixes: ['## '],
      paragraphSpacing: 'blank-line',
      rule: '---',
      listMarker: '- ',
      orderedMarker: '1. ',
      quotePrefix: '> ',
      firstLineIndent: 0,
    },
  },
];
