/**
 * Agent 工具：让模型真正读写写作画布。
 *
 * 这些工具是硬约束第 1 条的落地手段——「正文的唯一权威副本是写作工作台的文档存储」。
 * 没有它们，模型只能把正文写在对话里，约束就只是一句空话。
 *
 * 关于定义形态：官方 `defineTool` 只是把 DSL 转成 JSON Schema 并返回普通对象，
 * 而本包坚持零依赖（不 import 任何 @deepseek-ai/* 包），因此这里直接手写
 * 等价的定义对象：JSON Schema 的 parameters / output.schema + execute + render。
 *
 * 会话归属：工具执行时由宿主在 `exec.agent` 上携带发起 Agent，`agent.id` 即会话 id，
 * 因此每个会话自然对应自己那一份文档。
 *
 * @module dsh-writing-canvas/tools
 */

import { docIdOfSession } from './routes.js';
import { getType, listTypes } from './types/registry.js';

/** 把值渲染成给模型看的文本。 */
function textOf(value) {
  return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }];
}

/** 渲染写作类型的完整约束（供模型在动笔前读取）。 */
function renderTypeDetail(type) {
  const lines = [`# ${type.label}（id: ${type.id}）`, '', type.summary ?? '', ''];
  if (Array.isArray(type.mustConfirm) && type.mustConfirm.length > 0) {
    lines.push('## 生成前必须确认', ...type.mustConfirm.map((item) => `- ${item}`), '');
  }
  lines.push('## 硬约束');
  lines.push(...(type.constraints ?? []).map((item, index) => `${index + 1}. ${item}`));
  if (Array.isArray(type.structure) && type.structure.length > 0) {
    lines.push('', '## 结构骨架', ...type.structure.map((item) => `- ${item}`));
  }
  if (Array.isArray(type.checklist) && type.checklist.length > 0) {
    lines.push('', '## 交付前自检', ...type.checklist.map((item) => `- [ ] ${item}`));
  }
  const format = type.format ?? { kind: 'markdown' };
  lines.push(
    '',
    '## 默认格式规格',
    format.kind === 'docx'
      ? `DOCX（规格：${format.spec ?? '未命名'}）—— 字体、字号、行距必须由格式工具真实写入并回读校验。`
      : 'Markdown（默认）',
  );
  return lines.join('\n');
}

/**
 * 注册全部写作工具。
 *
 * @param options - 依赖。
 * @param options.ctx - Cordis 上下文。
 * @param options.resolveWorkspacePath - 由 sessionId 解析工作区路径。
 * @param options.storeFor - 共享的存储工厂。
 */
export function registerWritingTools({ ctx, resolveWorkspacePath, storeFor }) {
  /**
   * 解析当前工具调用的目标文档。
   * @param exec - 工具执行元信息。
   * @returns { sessionId, workspacePath, docId, store }
   */
  const targetOf = async (exec) => {
    const agent = exec?.agent;
    if (agent === undefined || agent === null || typeof agent.id !== 'string' || agent.id === '') {
      throw new Error('写作工具必须在一次会话内调用（拿不到当前 Agent）。');
    }
    const sessionId = agent.id;
    const workspacePath = await resolveWorkspacePath(sessionId);
    return {
      sessionId,
      workspacePath,
      docId: docIdOfSession(sessionId),
      store: storeFor(workspacePath),
    };
  };

  /** 统一的注册小工具：自动包一层错误处理，失败不许伪装成成功。 */
  const register = (definition) => {
    ctx.tools.register({
      ...definition,
      async execute(args, exec) {
        try {
          return await definition.execute(args, exec);
        } catch (error) {
          // 直接把真实原因抛回给模型，模型会看到并如实报告，而不是我们编一个结果。
          throw new Error(`${definition.name} 失败：${error instanceof Error ? error.message : String(error)}`);
        }
      },
    });
  };

  // ---------------------------------------------------------------- 读取文档
  register({
    name: 'writing_canvas_read',
    description:
      '读取当前会话的写作画布文档：正文、元信息（含写作类型）、最新版本号与版本列表。动笔前必须先调用它。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => textOf(value),
    },
    async execute(_args, exec) {
      const { docId, workspacePath, store } = await targetOf(exec);
      const doc = await store.readDoc(docId);
      const versions = await store.listVersions(docId);
      if (doc === null) {
        return {
          exists: false,
          docId,
          workspace: workspacePath,
          content: '',
          hint: '这份文档还不存在。先与用户确认写作类型与要求，再用 writing_canvas_write 写入第一版。',
          versions: [],
        };
      }
      const type = doc.meta.writingType === undefined ? null : getType(doc.meta.writingType);
      return {
        exists: true,
        docId,
        workspace: workspacePath,
        title: doc.meta.title,
        writingType: doc.meta.writingType ?? null,
        writingTypeLabel: type?.label ?? null,
        format: doc.meta.format,
        latestVersion: doc.latest.n,
        content: doc.latest.content,
        versions: versions.map((item) => ({
          n: item.n,
          at: item.at,
          source: item.source,
          note: item.note,
          bytes: item.bytes,
        })),
      };
    },
  });

  // ---------------------------------------------------------------- 写入文档
  register({
    name: 'writing_canvas_write',
    description:
      '把正文写入当前会话的写作画布，生成一个新的不可变版本。必须先 writing_canvas_read 并把读到的 latestVersion 作为 baseVersion 传入；若用户在此期间改过正文，写入会被拒绝并返回 conflict，此时应重新读取再决定。',
    parameters: {
      type: 'object',
      properties: {
        content: { type: 'string', description: '完整正文（整篇替换，不是增量补丁）' },
        baseVersion: {
          type: 'integer',
          description: '本次编辑所基于的版本号，取自 writing_canvas_read 的 latestVersion',
        },
        note: { type: 'string', description: '本次修改的说明，会记入版本历史' },
      },
      required: ['content', 'baseVersion'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => textOf(value),
    },
    async execute(args, exec) {
      const { docId, store } = await targetOf(exec);
      const saved = await store.saveDoc(docId, args.content, {
        source: 'agent',
        note: typeof args.note === 'string' ? args.note : '',
        baseVersion: Number.isInteger(args.baseVersion) ? args.baseVersion : undefined,
      });
      if (saved.conflict === true) {
        return {
          ok: false,
          conflict: true,
          message: `写入被拒绝：服务端已经是 v${saved.latest.n}，你基于 v${args.baseVersion}。请重新 writing_canvas_read 后再决定如何合并，不要把用户已写的内容覆盖掉。`,
          serverVersion: saved.latest.n,
          serverContent: saved.latest.content,
        };
      }
      return {
        ok: true,
        version: saved.latest.n,
        unchanged: saved.unchanged === true,
        bytes: saved.latest.bytes,
        message:
          saved.unchanged === true
            ? `内容与 v${saved.latest.n} 完全一致，没有生成新版本。`
            : `已写入 v${saved.latest.n}。`,
      };
    },
  });

  // ---------------------------------------------------------------- 版本历史
  register({
    name: 'writing_canvas_versions',
    description: '查看当前会话画布的版本历史；给定 n 时返回该版本的完整正文。',
    parameters: {
      type: 'object',
      properties: {
        n: { type: 'integer', description: '要读取的版本号；省略则只列出全部版本' },
      },
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => textOf(value),
    },
    async execute(args, exec) {
      const { docId, store } = await targetOf(exec);
      const versions = await store.listVersions(docId);
      if (Number.isInteger(args.n)) {
        const record = await store.readVersion(docId, args.n);
        if (record === null) return { ok: false, message: `版本 v${args.n} 不存在。`, versions };
        return { ok: true, version: record.n, at: record.at, source: record.source, content: record.content };
      }
      return {
        count: versions.length,
        latest: versions.length > 0 ? versions[versions.length - 1].n : 0,
        versions,
      };
    },
  });

  // ---------------------------------------------------------------- 还原版本
  register({
    name: 'writing_canvas_restore',
    description:
      '把某个历史版本的内容还原为新的最新版本。历史版本本身不会被删除或改写。还原前应先征得用户同意。',
    parameters: {
      type: 'object',
      properties: { n: { type: 'integer', description: '要还原到的版本号' } },
      required: ['n'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => textOf(value),
    },
    async execute(args, exec) {
      const { docId, store } = await targetOf(exec);
      const restored = await store.restoreVersion(docId, args.n);
      return {
        ok: true,
        restoredFrom: args.n,
        version: restored.latest.n,
        message: `已把 v${args.n} 的内容还原为 v${restored.latest.n}（历史保持完整）。`,
      };
    },
  });

  // ---------------------------------------------------------------- 类型清单
  register({
    name: 'writing_type_list',
    description:
      '列出当前已启用的写作类型。给定 id 时返回该类型的完整硬约束、结构骨架与自检清单。选定类型动笔前必须先读它。',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', description: '写作类型 id；省略则只列出清单' } },
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => textOf(value),
    },
    async execute(args) {
      const types = listTypes();
      if (typeof args.id === 'string' && args.id !== '') {
        const type = getType(args.id);
        if (type === undefined) {
          return {
            ok: false,
            message: `没有 id 为 ${args.id} 的写作类型。`,
            available: types.map((item) => item.id),
          };
        }
        return { ok: true, type: { id: type.id, label: type.label }, detail: renderTypeDetail(type) };
      }
      return {
        count: types.length,
        types: types.map((type) => ({
          id: type.id,
          label: type.label,
          summary: type.summary,
          format: type.format ?? { kind: 'markdown' },
          mustConfirm: type.mustConfirm ?? [],
        })),
        hint: '确定类型后，用 writing_type_set 把它记到文档上，再按该类型的硬约束动笔。',
      };
    },
  });

  // ---------------------------------------------------------------- 选定类型
  register({
    name: 'writing_type_set',
    description:
      '为当前会话的文档选定写作类型。必须先用 writing_type_list 读取该类型的完整约束，并已与用户确认生成前必须确认的要素。',
    parameters: {
      type: 'object',
      properties: {
        typeId: { type: 'string', description: '写作类型 id' },
        confirmed: {
          type: 'boolean',
          description: '是否已就该类型「生成前必须确认」的要素与用户确认完毕',
        },
      },
      required: ['typeId', 'confirmed'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => textOf(value),
    },
    async execute(args, exec) {
      const type = getType(args.typeId);
      if (type === undefined) {
        return {
          ok: false,
          message: `没有 id 为 ${args.typeId} 的写作类型。`,
          available: listTypes().map((item) => item.id),
        };
      }
      if (args.confirmed !== true) {
        return {
          ok: false,
          message: `尚未确认 ${type.label} 的必备要素。硬约束要求先确认再生成：请先就以下要素与用户确认——${(type.mustConfirm ?? []).join('、')}。`,
          mustConfirm: type.mustConfirm ?? [],
        };
      }
      const { docId, store } = await targetOf(exec);
      const meta = await store.setType(docId, type.id);
      return {
        ok: true,
        writingType: type.id,
        label: type.label,
        format: meta.format,
        message: `已把文档的写作类型设为「${type.label}」。接下来必须遵守该类型的硬约束；完整约束用 writing_type_list(id="${type.id}") 读取。`,
      };
    },
  });
}
