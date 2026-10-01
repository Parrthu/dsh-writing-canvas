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

import { exportDocx } from './format/docx.js';
import { getFormatSpec, listFormatSpecs } from './format/specs.js';
import { docIdOfSession } from './routes.js';
import { BUILTIN_MARKDOWN_SETS } from './library.js';
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
 * @param options.storeFor - 共享的文档存储工厂。
 * @param options.annotationsFor - 共享的批注存储工厂。
 * @param options.suggestionsFor - 共享的修改建议存储工厂。
 * @param options.bus - 事件总线（把「撰写中」与新版本推给界面）。
 */
export function registerWritingTools({
  ctx,
  resolveWorkspacePath,
  storeFor,
  annotationsFor,
  suggestionsFor,
  libraryFor,
  bus,
  pickDirectory,
}) {
  /**
   * 解析当前工具调用的目标文档。
   * @param exec - 工具执行元信息。
   * @returns { sessionId, workspacePath, docId, store, annotations, suggestions }
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
      annotations: annotationsFor?.(workspacePath),
      suggestions: suggestionsFor?.(workspacePath),
      library: libraryFor?.(workspacePath),
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
      const { docId, workspacePath, store, annotations, suggestions } = await targetOf(exec);
      const doc = await store.readDoc(docId);
      const versions = await store.listVersions(docId);
      // 未处理的批注必须让模型看见——这是「用户要你改这里」的唯一传递路径。
      const allAnnotations = annotations === undefined ? [] : await annotations.list(docId, doc?.latest?.content);
      const openAnnotations = allAnnotations.filter((item) => item.status === 'open');
      const allSuggestions = suggestions === undefined ? [] : await suggestions.list(docId, doc?.latest?.content);
      const pendingSuggestions = allSuggestions.filter((item) => item.status === 'pending');
      if (doc === null) {
        return {
          exists: false,
          docId,
          workspace: workspacePath,
          content: '',
          hint: '这份文档还不存在。先与用户确认写作类型与要求，再用 writing_canvas_write 写入第一版。',
          versions: [],
          openAnnotations,
          pendingSuggestions,
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
        openAnnotations,
        annotationHint:
          openAnnotations.length === 0
            ? null
            : '有未处理的批注。按硬约束：用户未确认的批注不改变正文——请先逐条与用户确认要如何处理，处理完用 writing_canvas_annotate 把对应批注标记为 resolved。',
      };
    },
  });

  // ---------------------------------------------------------------- 写入文档
  register({
    name: 'writing_canvas_write',
    description:
      '把正文写入当前会话的写作画布，生成一个新的不可变版本。必须先 writing_canvas_read 并把读到的 latestVersion 作为 baseVersion 传入；若用户在此期间改过正文，写入会被拒绝并返回 conflict，此时应重新读取再决定。' +
      '长篇内容建议分段写：每段用 mode="append" 追加，并让最后一段带 final=true，界面会实时呈现并在收尾时结束「撰写中」提示。',
    parameters: {
      type: 'object',
      properties: {
        content: { type: 'string', description: '本次写入的正文' },
        baseVersion: {
          type: 'integer',
          description: '本次编辑所基于的版本号，取自 writing_canvas_read 的 latestVersion',
        },
        note: { type: 'string', description: '本次修改的说明，会记入版本历史' },
        mode: {
          type: 'string',
          enum: ['replace', 'append'],
          description:
            'replace（默认）整篇替换；append 追加到当前正文末尾（适合分段流式写入，界面会实时呈现）',
        },
        final: {
          type: 'boolean',
          description:
            '是否已写完。false 表示后面还有内容，界面会持续显示「撰写中」；默认 true 表示本次写完',
        },
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
      const isAppend = args.mode === 'append';

      let content = args.content;
      if (isAppend) {
        const current = await store.readDoc(docId);
        const base = current?.latest?.content ?? '';
        content = base === '' ? content : `${base}\n\n${content}`;
      }

      const saved = await store.saveDoc(docId, content, {
        source: 'agent',
        note: typeof args.note === 'string' ? args.note : '',
        baseVersion: Number.isInteger(args.baseVersion) ? args.baseVersion : undefined,
      });

      if (saved.conflict === true) {
        // 冲突时同时结束「撰写中」，否则界面会一直转圈。
        bus?.setWriting?.(docId, false);
        return {
          ok: false,
          conflict: true,
          message: `写入被拒绝：服务端已经是 v${saved.latest.n}，你基于 v${args.baseVersion}。请重新 writing_canvas_read 后再决定如何合并，不要把用户已写的内容覆盖掉。`,
          serverVersion: saved.latest.n,
          serverContent: saved.latest.content,
        };
      }

      const finished = args.final !== false;
      bus?.setWriting?.(docId, !finished, typeof args.note === 'string' ? args.note : '');
      if (!saved.unchanged) {
        bus?.publishDocChanged?.(docId, { version: saved.latest.n, source: 'agent' });
      }
      // 「真的在写正文」是调出画布的唯一判据。
      // 放在这里而不是新会话打开时：新建任务不再无条件弹出侧边画布，
      // 只有 Agent 确实要写作的那一刻，界面才把画布调到用户面前
      // （同时开始逐字呈现，用户不用手动开、也不用刷新）。
      bus?.publishCanvasIntent?.(docId, {
        reason: 'agent-write',
        version: saved.latest.n,
        streaming: !finished,
      });

      return {
        ok: true,
        version: saved.latest.n,
        mode: isAppend ? 'append' : 'replace',
        final: finished,
        unchanged: saved.unchanged === true,
        bytes: saved.latest.bytes,
        message:
          saved.unchanged === true
            ? `内容与 v${saved.latest.n} 完全一致，没有生成新版本。`
            : `已写入 v${saved.latest.n}${finished ? '（本篇完成）' : '（后续还有内容，界面显示撰写中）'}。`,
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

  // ---------------------------------------------------------------- 套用格式
  register({
    name: 'writing_canvas_export',
    description:
      '把画布正文按预设格式规格一键套用，生成 DOCX，并在生成后**回读校验**。' +
      '画布本身只管内容（Markdown）；字体、字号、行距这类版式由这个工具落地。' +
      '返回里带 verification.checks，必须如实转述校验结果——校验没过就不能说「已按要求排版」。' +
      '默认会拉起系统目录选择框让用户挑保存位置（与界面上的导出按钮一致）；' +
      '要落到固定位置就传 directory。',
    parameters: {
      type: 'object',
      properties: {
        specId: {
          type: 'string',
          description:
            '格式规格 id，例如 gongwen-gb9704（党政机关公文）、plain-docx（通用中文文档）、report-docx（工作报告）。省略则用文档已选写作类型的默认规格。',
        },
        directory: {
          type: 'string',
          description:
            '保存目录（绝对路径）。省略时会拉起系统目录选择框让用户挑；用户取消则不生成文件。',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => textOf(value),
    },
    async execute(args, exec) {
      const { docId, workspacePath, store } = await targetOf(exec);
      const doc = await store.readDoc(docId);
      if (doc === null) {
        return { ok: false, message: '这份文档还没有内容，先写正文再套用格式。' };
      }
      const specId =
        typeof args.specId === 'string' && args.specId !== ''
          ? args.specId
          : (doc.meta.format?.spec ?? 'plain-docx');
      const found = getFormatSpec(specId);
      if (found === null) {
        return {
          ok: false,
          message: `没有 id 为 ${specId} 的格式规格。`,
          available: listFormatSpecs().map((item) => item.id),
        };
      }

      // 保存位置：与界面上的导出按钮保持一致——默认让用户选，
      // 而不是每次都默默丢进工作区的 exports/（这一点被用户明确抱怨过）。
      const wanted = typeof args.directory === 'string' ? args.directory.trim() : '';
      let outDir;
      let usedDefaultDir = true;
      let pickerUnavailable = false;
      if (wanted !== '') {
        outDir = wanted;
        usedDefaultDir = false;
      } else if (typeof pickDirectory === 'function') {
        const picked = await pickDirectory();
        if (picked === undefined) {
          pickerUnavailable = true;
        } else if (picked === null) {
          // 用户取消了选择：不生成任何文件，也不假装成功。
          return { ok: false, cancelled: true, message: '用户取消了保存位置的选择，未生成文件。' };
        } else {
          outDir = picked;
          usedDefaultDir = false;
        }
      } else {
        pickerUnavailable = true;
      }

      const report = await exportDocx({
        workspacePath,
        stateDir: store.stateDir,
        docId,
        content: doc.latest.content,
        spec: found.spec,
        specId,
        title: doc.meta.title,
        outDir,
      });

      if (report.ok !== true) {
        return {
          ok: false,
          specId,
          specLabel: found.spec.label,
          error: report.error ?? 'verification-failed',
          message: report.message ?? '套用格式后回读校验未通过，请如实报告失败原因，不要说「已完成」。',
          verification: report.verification ?? null,
        };
      }

      // 保存位置据实播报：没选成、没有选择器都要说清楚，不能让用户以为文件在别处。
      const where =
        usedDefaultDir === false
          ? ''
          : pickerUnavailable === true
            ? '（当前环境没有可用的目录选择器，已存到工作区的导出目录）'
            : '（未选择位置，已存到工作区的导出目录）';
      return {
        ok: true,
        specId,
        specLabel: found.spec.label,
        file: report.file,
        relativePath: report.relativePath,
        bytes: report.bytes,
        verification: report.verification,
        warnings: report.warnings ?? [],
        usedDefaultDir,
        pickerUnavailable,
        message: `已按「${found.spec.label}」生成 DOCX 并通过 ${report.verification.total} 项回读校验，文件在 ${report.relativePath}。${where}`,
      };
    },
  });

  // ---------------------------------------------------------------- 格式集（Set）
  register({
    name: 'writing_format_set_list',
    description:
      '列出当前工作区可用的格式集（Set）。Set 分两种载体：markdown（标题层级、正文体例、分隔线这类写作体例）与 docx（字体、字号、行距、页边距这类版式规格）。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Set id；给定则返回它的完整定义' },
      },
      additionalProperties: false,
    },
    output: { schema: { type: 'object' }, render: (_args, value) => textOf(value) },
    async execute(args, exec) {
      const { library } = await targetOf(exec);
      const userSets = library === undefined ? [] : await library.listSets();
      // 必须把内置 DOCX 版式一并列出：本工具的说明写着「分 markdown 与 docx 两种载体」，
      // 早先只给了 markdown，于是 AI 根本不知道「党政机关公文」「工作报告」这些版式存在，
      // 与 /format-sets 接口（它两者都给）也对不上。
      const builtinDocx = listFormatSpecs().map((item) => ({
        id: item.id,
        name: item.label,
        kind: 'docx',
        source: 'builtin',
        description: `正文 ${item.body.fontEastAsia} ${item.body.sizePt}pt${
          item.body.lineSpacingPt ? ` · 固定行距 ${item.body.lineSpacingPt}pt` : ''
        }`,
      }));
      const all = [
        ...BUILTIN_MARKDOWN_SETS.map((x) => ({ ...x, source: 'builtin' })),
        ...builtinDocx,
        ...userSets.map((x) => ({ ...x, source: 'user' })),
      ];
      if (typeof args.id === 'string' && args.id !== '') {
        const found = all.find((x) => x.id === args.id);
        if (found === undefined) return { ok: false, message: `没有 id 为 ${args.id} 的格式集。`, available: all.map((x) => x.id) };
        return { ok: true, set: found };
      }
      return {
        count: all.length,
        sets: all.map((x) => ({
          id: x.id,
          name: x.name,
          kind: x.kind,
          source: x.source,
          description: x.description,
        })),
      };
    },
  });

  register({
    name: 'writing_format_set_create',
    description:
      '把用户用自然语言描述、或从模板里提取的格式要求，整理成一个可复用的格式集（Set）。' +
      'Set 会被存在当前工作区，之后一键套用。kind="markdown" 用于不导出 DOCX 的场景（定义标题层级、正文体例、分隔线）；' +
      'kind="docx" 用于需要指定字体/字号/行距的场景。' +
      '命名规则：用户给了名字就用用户的；没给就根据描述起一个简短准确的中文名。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Set 名称；省略则由你根据描述智能命名' },
        description: { type: 'string', description: '这个 Set 的用途与要求的简述（会显示给用户）' },
        kind: { type: 'string', enum: ['markdown', 'docx'], description: '载体：md 体例还是 docx 版式' },
        definition: {
          type: 'object',
          description:
            'Set 的定义。kind=markdown 时用 { titlePrefix, headingPrefixes[], paragraphSpacing, firstLineIndent, indentChar, rule, listMarker, orderedMarker, quotePrefix }；' +
            'kind=docx 时用与内置规格相同的结构 { page, title, body, heading1, heading2, heading3, quote, pageNumber }，字体用 fontEastAsia/fontAscii，字号用 sizePt，行距用 lineSpacingPt + lineRule="exact"。',
        },
      },
      required: ['description', 'kind', 'definition'],
      additionalProperties: false,
    },
    output: { schema: { type: 'object' }, render: (_args, value) => textOf(value) },
    async execute(args, exec) {
      const { library, workspacePath } = await targetOf(exec);
      if (library === undefined) return { ok: false, message: '用户库不可用。' };
      const created = await library.createSet({
        name: args.name,
        description: args.description,
        kind: args.kind,
        definition: args.definition,
        createdBy: 'agent',
      });
      return {
        ok: true,
        set: created,
        message: `已创建格式集「${created.name}」（${created.kind}），存放在 ${workspacePath}/.writing-canvas/library/format-sets.json，之后可以直接套用。`,
      };
    },
  });

  // ---------------------------------------------------------------- 自定义写作类型
  register({
    name: 'writing_type_create',
    description:
      '为用户创建一个自定义写作类型（存在当前工作区，不是插件行），适用于内置类型覆盖不到的场景。' +
      '创建前必须与用户确认：名称、生成前需要确认哪些要素、有哪些硬约束。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '英文短 id（字母数字与短横线），用于内部标识' },
        label: { type: 'string', description: '中文名称，例如「产品需求文档」' },
        summary: { type: 'string', description: '一句话说明这个类型是什么' },
        mustConfirm: { type: 'array', items: { type: 'string' }, description: '生成前必须向用户确认的要素' },
        constraints: { type: 'array', items: { type: 'string' }, description: '硬约束（越具体越好）' },
        structure: { type: 'array', items: { type: 'string' }, description: '结构骨架' },
        checklist: { type: 'array', items: { type: 'string' }, description: '交付前自检清单' },
        formatKind: { type: 'string', enum: ['markdown', 'docx'], description: '默认载体' },
      },
      required: ['id', 'label', 'summary', 'constraints'],
      additionalProperties: false,
    },
    output: { schema: { type: 'object' }, render: (_args, value) => textOf(value) },
    async execute(args, exec) {
      const { library } = await targetOf(exec);
      if (library === undefined) return { ok: false, message: '用户库不可用。' };
      const record = await library.upsertType({
        id: args.id,
        label: args.label,
        summary: args.summary,
        constraints: args.constraints,
        mustConfirm: args.mustConfirm ?? [],
        structure: args.structure ?? [],
        checklist: args.checklist ?? [],
        format: { kind: args.formatKind === 'docx' ? 'docx' : 'markdown' },
        createdBy: 'agent',
      });
      return {
        ok: true,
        type: { id: record.id, label: record.label },
        message: `已创建自定义写作类型「${record.label}」。用户现在可以在画布的类型下拉里选到它。`,
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
    async execute(args, exec) {
      const { library } = await targetOf(exec);
      const custom = library === undefined ? [] : await library.listTypes();
      const types = [...listTypes(), ...custom];
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
      const { library: lib } = await targetOf(exec);
      const customTypes = lib === undefined ? [] : await lib.listTypes();
      const type = getType(args.typeId) ?? customTypes.find((item) => item.id === args.typeId);
      if (type === undefined) {
        return {
          ok: false,
          message: `没有 id 为 ${args.typeId} 的写作类型。`,
          available: [...listTypes().map((item) => item.id), ...customTypes.map((item) => item.id)],
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

  // ---------------------------------------------------------------- 修改建议
  register({
    name: 'writing_canvas_suggest',
    description:
      '对画布正文的某一段**提出修改建议**，但**不改动正文**。用户会在画布上看到原文与建议的对照，并逐条决定接受或拒绝。' +
      '硬约束：任何对既有正文的改写都必须走这条通道；只有用户接受时才真正写入新版本。' +
      '新增段落或从零写第一版用 writing_canvas_write，改写用户已有的文字用本工具。',
    parameters: {
      type: 'object',
      properties: {
        original: { type: 'string', description: '要被替换的原文片段（必须与正文完全一致，逐字复制）' },
        proposed: { type: 'string', description: '建议改成的内容' },
        reason: { type: 'string', description: '为什么这样改（用户会看到）' },
        rangeStart: { type: 'integer', description: '原文在正文中的起始位置（可选，便于精确定位）' },
        rangeEnd: { type: 'integer', description: '原文在正文中的结束位置（可选）' },
      },
      required: ['original', 'proposed'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => textOf(value),
    },
    async execute(args, exec) {
      const { docId, store, suggestions } = await targetOf(exec);
      if (suggestions === undefined) {
        return { ok: false, message: '建议存储不可用。' };
      }
      const doc = await store.readDoc(docId);
      const content = doc?.latest?.content ?? '';
      if (content === '') {
        return { ok: false, message: '正文还是空的，没有可改写的文字。请用 writing_canvas_write 写第一版。' };
      }
      if (typeof args.original !== 'string' || args.original === '') {
        return { ok: false, message: 'original 不能为空：请逐字复制要被替换的原文片段。' };
      }

      const found = content.indexOf(args.original);
      if (found === -1) {
        return {
          ok: false,
          message: '原文片段在正文里找不到（必须逐字一致，包括标点与换行）。请先 writing_canvas_read 再复制准确片段。',
        };
      }
      let start = Number.isInteger(args.rangeStart) ? args.rangeStart : found;
      let end = Number.isInteger(args.rangeEnd)
        ? args.rangeEnd
        : start + args.original.length;
      if (content.slice(start, end) !== args.original) {
        start = found;
        end = found + args.original.length;
      }

      const suggestion = await suggestions.create(docId, {
        original: args.original,
        proposed: args.proposed,
        reason: args.reason,
        range: { start, end },
        anchorVersion: doc?.latest?.n ?? null,
        author: 'agent',
      });
      bus?.publishAnnotationsChanged?.(docId, { suggestions: true });
      return {
        ok: true,
        suggestionId: suggestion.id,
        version: doc?.latest?.n ?? 0,
        message:
          '已提交建议。正文未改动——用户会在画布上看到原文与建议的对照，并由他决定接受或拒绝。不要重复提交同一条建议。',
      };
    },
  });

  // ---------------------------------------------------------------- 批注
  register({
    name: 'writing_canvas_annotate',
    description:
      '读写画布批注。用户常在画布里选中一段文字后留下批注（要改写/扩写/删减/润色/提问）。' +
      '用 action="list" 读取；处理完某条批注后用 action="resolve" 标记为已处理（必须在此前把改动写进正文）；' +
      '也可以用 action="create" 就某段文字向用户提问。硬约束：用户未确认的批注不改变正文。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'create', 'reply', 'resolve', 'dismiss'],
          description: '要执行的操作',
        },
        id: { type: 'string', description: '批注 id（reply / resolve / dismiss 需要）' },
        quote: { type: 'string', description: '被批注的原文片段（create 需要）' },
        rangeStart: { type: 'integer', description: '原文起始位置（create 可选）' },
        rangeEnd: { type: 'integer', description: '原文结束位置（create 可选）' },
        kind: {
          type: 'string',
          enum: ['comment', 'rewrite', 'expand', 'shorten', 'polish', 'continue', 'ask'],
          description: '批注种类（create 可选，默认 comment）',
        },
        instruction: { type: 'string', description: '批注内容/要求（create 需要）' },
        reply: { type: 'string', description: '追加一条回复（reply 需要）' },
        resolvedVersion: { type: 'integer', description: 'resolve 时说明是哪一版完成的改动' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => textOf(value),
    },
    async execute(args, exec) {
      const { docId, store, annotations } = await targetOf(exec);
      if (annotations === undefined) {
        return { ok: false, message: '批注存储不可用。' };
      }
      const doc = await store.readDoc(docId);
      const content = doc?.latest?.content ?? '';

      if (args.action === 'list') {
        const items = await annotations.list(docId, content);
        return {
          count: items.length,
          open: items.filter((item) => item.status === 'open').length,
          annotations: items,
        };
      }

      if (args.action === 'create') {
        if (typeof args.instruction !== 'string' || args.instruction === '') {
          return { ok: false, message: 'create 需要 instruction（你想问用户什么）。' };
        }
        const quote = typeof args.quote === 'string' ? args.quote : '';
        let start = Number.isInteger(args.rangeStart) ? args.rangeStart : 0;
        let end = Number.isInteger(args.rangeEnd) ? args.rangeEnd : 0;
        if (quote !== '' && (start === 0 || content.slice(start, end) !== quote)) {
          const found = content.indexOf(quote);
          if (found !== -1) {
            start = found;
            end = found + quote.length;
          }
        }
        const annotation = await annotations.create(docId, {
          quote,
          range: { start, end },
          kind: args.kind,
          instruction: args.instruction,
          author: 'agent',
          anchorVersion: doc?.latest?.n ?? null,
        });
        bus?.publishAnnotationsChanged?.(docId, { count: 1 });
        return { ok: true, annotation, message: '已创建批注，用户会在画布右侧看到它。' };
      }

      if (typeof args.id !== 'string' || args.id === '') {
        return { ok: false, message: `${args.action} 需要 id。` };
      }

      if (args.action === 'reply') {
        const updated = await annotations.update(docId, args.id, { reply: args.reply, author: 'agent' });
        if (updated === null) return { ok: false, message: `找不到批注 ${args.id}。` };
        bus?.publishAnnotationsChanged?.(docId, { count: 1 });
        return { ok: true, annotation: updated };
      }

      if (args.action === 'resolve' || args.action === 'dismiss') {
        const updated = await annotations.update(docId, args.id, {
          status: args.action === 'resolve' ? 'resolved' : 'dismissed',
          resolvedVersion: Number.isInteger(args.resolvedVersion) ? args.resolvedVersion : (doc?.latest?.n ?? null),
          resolutionNote: typeof args.reply === 'string' ? args.reply : '',
        });
        if (updated === null) return { ok: false, message: `找不到批注 ${args.id}。` };
        bus?.publishAnnotationsChanged?.(docId, { count: 1 });
        return {
          ok: true,
          annotation: updated,
          message:
            args.action === 'resolve'
              ? '已标记为已处理。请确认改动确实已经写入正文（用 writing_canvas_write）。'
              : '已忽略该批注，正文未改动。',
        };
      }

      return { ok: false, message: `不支持的 action：${args.action}` };
    },
  });
}
