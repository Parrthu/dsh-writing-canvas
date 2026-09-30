/**
 * 宿主 API 路由。
 *
 * 契约来自 Release 0.2.0-rc.2 的 dsh-host-webserver：
 *   ctx.webServer.register({ kind: 'prefix', path, handler })
 * 其中 handler 是 **node:http 风格**的 (req, res)。
 *
 * 路径刻意不放在 /plugins 下：那一段是客户端 bundle 的 combo 路由，
 * 分开可以彻底避免遮蔽。
 *
 * 寻址方式有两种，对应界面的两种形态：
 *   - sessionId            → 对话旁常驻画布（一份会话一份文档）
 *   - workspace + docId    → 工作台整页（可跨会话浏览/编辑工作区内的文档）
 * 出于安全，workspace 必须是 workspaceRegistry 里登记过的工作区，不接受任意路径。
 *
 * @module dsh-writing-canvas/routes
 */

import { AnnotationStore } from './annotations.js';
import { exportDocx } from './format/docx.js';
import { getFormatSpec, listFormatSpecs } from './format/specs.js';
import { BUILTIN_MARKDOWN_SETS, WorkspaceLibrary } from './library.js';
import { DocumentStore } from './store.js';
import { SuggestionStore, applySuggestion } from './suggestions.js';
import { listTypes } from './types/registry.js';
import { mergeOverrides } from './prompt-overrides.js';

/** API 前缀。 */
export const API_PREFIX = '/writing-canvas/api';

/**
 * 读取请求体并解析为 JSON（带大小上限）。
 * @param req - node:http 请求对象。
 * @param limitBytes - 允许的最大字节数。
 * @returns 解析后的对象；空体返回 {}。
 */
function readJsonBody(req, limitBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(new Error(`请求体超过上限 ${limitBytes} 字节`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (raw.trim() === '') {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(new Error(`请求体不是合法 JSON：${String(error)}`));
      }
    });
    req.on('error', reject);
  });
}

/** 写出 JSON 响应。 */
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
}

/**
 * 把一个写作类型的内置定义拼成可编辑的提示词文本。
 *
 * 用户在画布上点开「提示词」时看到的就是这段——它同时是**可编辑的初值**：
 * 改完保存就成了覆盖，注入系统提示时优先于内置定义。
 *
 * @param type - 类型定义。
 * @returns 提示词文本。
 */
function defaultTypePromptText(type) {
  const lines = [`# ${type.label}`, ''];
  if (typeof type.summary === 'string' && type.summary !== '') lines.push(type.summary, '');
  const format = type.format ?? { kind: 'markdown' };
  lines.push(
    format.kind === 'docx'
      ? `默认格式：DOCX（规格 ${format.spec ?? '未命名'}）—— 字体、字号、行距必须由格式工具真实写入并回读校验。`
      : '默认格式：Markdown。',
    '',
  );
  if (Array.isArray(type.mustConfirm) && type.mustConfirm.length > 0) {
    lines.push('生成前必须确认：', ...type.mustConfirm.map((item) => `- ${item}`), '');
  }
  if (Array.isArray(type.constraints) && type.constraints.length > 0) {
    lines.push('硬约束：', ...type.constraints.map((item, index) => `${index + 1}. ${item}`), '');
  }
  if (Array.isArray(type.structure) && type.structure.length > 0) {
    lines.push('结构骨架：', ...type.structure.map((item) => `- ${item}`), '');
  }
  if (Array.isArray(type.checklist) && type.checklist.length > 0) {
    lines.push('交付前自检：', ...type.checklist.map((item) => `- [ ] ${item}`), '');
  }
  return lines.join('\n').trim();
}

/**
 * 把会话映射为文档 id。
 *
 * 画布是「对话流的一部分」，所以一个会话一份文档。
 *
 * @param sessionId - 会话 id。
 * @returns 安全的文档 id。
 */
export function docIdOfSession(sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '') return 'default';
  const safe = sessionId.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
  return `s-${safe}`;
}

/**
 * 创建 API 处理器。
 *
 * @param options - 依赖。
 * @param options.config - 已解析配置。
 * @param options.resolveWorkspacePath - 由 sessionId 解析工作区绝对路径。
 * @param options.listWorkspaces - 返回 [{ id, path, title }]，用于校验与总览。
 * @param options.storeFor - 共享的文档存储工厂；省略时自建（仅供测试）。
 * @param options.annotationsFor - 共享的批注存储工厂；省略时自建。
 * @param options.bus - 事件总线；省略时退化为无推送。
 * @param options.logger - 可选日志器。
 * @returns node:http 风格的 (req, res) 处理器。
 */
export function createApiHandler({
  config,
  resolveWorkspacePath,
  listWorkspaces,
  storeFor: sharedStoreFor,
  annotationsFor: sharedAnnotationsFor,
  suggestionsFor: sharedSuggestionsFor,
  libraryFor: sharedLibraryFor,
  bus,
  logger,
  onPromptChanged,
}) {
  /** 同一工作区复用同一个实例（写入链才有意义）。 */
  const stores = new Map();
  const annotationStores = new Map();
  const suggestionStores = new Map();
  const libraries = new Map();

  /**
   * 浏览器侧诊断上报（内存环形缓冲，最多 50 条）。
   *
   * 存在的理由：客户端半体跑在浏览器里，出问题时宿主看不见。界面把关键步骤
   * （例如「自动开启画布」）的结果上报到这里，开发者可以直接用
   * GET /writing-canvas/api/client-report 读到真实原因。
   */
  const clientReports = [];

  const storeFor =
    sharedStoreFor ??
    ((workspacePath) => {
      let store = stores.get(workspacePath);
      if (store === undefined) {
        store = new DocumentStore(workspacePath, config.stateDir);
        stores.set(workspacePath, store);
      }
      return store;
    });

  const annotationsFor =
    sharedAnnotationsFor ??
    ((workspacePath) => {
      let store = annotationStores.get(workspacePath);
      if (store === undefined) {
        store = new AnnotationStore(workspacePath, config.stateDir);
        annotationStores.set(workspacePath, store);
      }
      return store;
    });

  const suggestionsFor =
    sharedSuggestionsFor ??
    ((workspacePath) => {
      let store = suggestionStores.get(workspacePath);
      if (store === undefined) {
        store = new SuggestionStore(workspacePath, config.stateDir);
        suggestionStores.set(workspacePath, store);
      }
      return store;
    });

  const libraryFor =
    sharedLibraryFor ??
    ((workspacePath) => {
      let library = libraries.get(workspacePath);
      if (library === undefined) {
        library = new WorkspaceLibrary(workspacePath, config.stateDir);
        libraries.set(workspacePath, library);
      }
      return library;
    });

  /**
   * 解析本次请求的目标 { workspacePath, docId }。
   * @param params - 形如 { sessionId } 或 { workspace, docId }。
   * @returns 目标描述，或 { error } 表示参数非法。
   */
  const resolveTarget = async (params) => {
    const known = listWorkspaces();

    if (typeof params.workspace === 'string' && params.workspace !== '') {
      const match = known.find((item) => item.path === params.workspace);
      if (match === undefined) return { error: 'unknown-workspace' };
      const docId =
        typeof params.docId === 'string' && params.docId !== '' ? params.docId : docIdOfSession(params.sessionId);
      return { workspacePath: match.path, docId };
    }

    const sessionId = typeof params.sessionId === 'string' ? params.sessionId : undefined;
    return { workspacePath: await resolveWorkspacePath(sessionId), docId: docIdOfSession(sessionId) };
  };

  /** 从 URL 查询串收集寻址参数。 */
  const paramsFromUrl = (url) => ({
    sessionId: url.searchParams.get('sessionId') ?? undefined,
    workspace: url.searchParams.get('workspace') ?? undefined,
    docId: url.searchParams.get('docId') ?? undefined,
  });

  return async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const route = url.pathname.startsWith(API_PREFIX) ? url.pathname.slice(API_PREFIX.length) : url.pathname;
      const method = (req.method ?? 'GET').toUpperCase();

      // ---- 健康检查 ------------------------------------------------------
      if (route === '/health' || route === '/' || route === '') {
        sendJson(res, 200, {
          ok: true,
          plugin: 'dsh-writing-canvas',
          phase: 'P4',
          release: '0.2.0-rc.2',
          stateDir: config.stateDir,
          constraintsSection: 'writing-canvas:constraints',
          // 写作提示注入的实际状态。宿主行挂在宿主组合里对**每个会话**都生效，
          // 所以这里必须能一眼看出它到底是开是关——「所有任务都被当成写作任务」
          // 就是这么来的。只有写作模式（preset 里的 mode/writing 行）才注入那两段。
          promptInjection: config.injectPrompt === true ? 'on' : 'off',
          subscribers: bus?.size?.() ?? 0,
        });
        return;
      }

      // ---- 界面开关（开发期自检等）----------------------------------------
      if (route === '/ui-flags' && method === 'GET') {
        sendJson(res, 200, {
          ok: true,
          interactionSelfTest: config.interactionSelfTest === true,
          workbenchSelfTest: config.workbenchSelfTest === true,
        });
        return;
      }

      // ---- 实时事件流（SSE）----------------------------------------------
      if (route === '/events' && method === 'GET') {
        const target = await resolveTarget(paramsFromUrl(url));
        if (target.error !== undefined) {
          sendJson(res, 400, { error: target.error });
          return;
        }
        if (bus === undefined) {
          sendJson(res, 501, { error: 'event-bus-unavailable' });
          return;
        }
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-store',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
        });
        res.write(`data: ${JSON.stringify({ type: 'hello', docId: target.docId })}\n\n`);
        const unsubscribe = bus.subscribe(target.docId, res);
        // 连接断开（含页面关闭）时一定要清理，否则订阅者会越积越多。
        req.on('close', unsubscribe);
        req.on('error', unsubscribe);
        return;
      }

      // ---- 写作类型清单（界面左栏用）--------------------------------------
      if (route === '/types' && method === 'GET') {
        const typesTarget = await resolveTarget(paramsFromUrl(url));
        const customTypes =
          typesTarget.error === undefined ? await libraryFor(typesTarget.workspacePath).listTypes() : [];
        sendJson(res, 200, {
          ok: true,
          types: [...listTypes(), ...customTypes].map((type) => ({
            id: type.id,
            label: type.label,
            order: type.order ?? 100,
            summary: type.summary ?? '',
            format: type.format ?? { kind: 'markdown' },
            mustConfirm: type.mustConfirm ?? [],
            constraints: type.constraints ?? [],
            structure: type.structure ?? [],
            checklist: type.checklist ?? [],
            custom: type.custom === true,
          })),
        });
        return;
      }

      // ---- 工作区与文档总览（工作台整页用）--------------------------------
      if (route === '/docs' && method === 'GET') {
        const workspaces = listWorkspaces();
        const documents = [];
        for (const workspace of workspaces) {
          const docs = await storeFor(workspace.path).listDocuments();
          for (const doc of docs) documents.push({ ...doc, workspaceTitle: workspace.title });
        }
        documents.sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')));
        sendJson(res, 200, { ok: true, workspaces, documents });
        return;
      }

      // ---- 新建文档 ------------------------------------------------------
      if (route === '/docs/create' && method === 'POST') {
        const body = await readJsonBody(req, 64 * 1024);
        const target = await resolveTarget(body);
        if (target.error !== undefined) {
          sendJson(res, 400, { error: target.error });
          return;
        }
        const docId =
          typeof body.docId === 'string' && body.docId !== ''
            ? body.docId
            : `doc-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
        const store = storeFor(target.workspacePath);
        // 空白文档允许创建（这是"新建"而不是"覆盖"）。
        const created = await store.saveDoc(docId, typeof body.content === 'string' ? body.content : '', {
          source: 'user',
          note: '新建文档',
          title: typeof body.title === 'string' && body.title !== '' ? body.title : '未命名文档',
          allowEmpty: true,
          force: true,
        });
        sendJson(res, 200, {
          ok: true,
          docId,
          workspace: target.workspacePath,
          meta: created.meta,
          latest: created.latest,
        });
        return;
      }

      // ---- 读取文档（含批注与撰写状态）------------------------------------
      if (route === '/doc' && method === 'GET') {
        const target = await resolveTarget(paramsFromUrl(url));
        if (target.error !== undefined) {
          sendJson(res, 400, { error: target.error });
          return;
        }
        const store = storeFor(target.workspacePath);
        const doc = await store.readDoc(target.docId);
        const versions = doc === null ? [] : await store.listVersions(target.docId);
        const annotations = await annotationsFor(target.workspacePath).list(target.docId, doc?.latest?.content);
        const suggestions = await suggestionsFor(target.workspacePath).list(target.docId, doc?.latest?.content);
        sendJson(res, 200, {
          exists: doc !== null,
          docId: target.docId,
          workspace: target.workspacePath,
          meta: doc?.meta ?? null,
          latest: doc?.latest ?? null,
          versions,
          annotations,
          suggestions,
          writing: bus?.writingState?.(target.docId) ?? { active: false, startedAt: null, note: '' },
        });
        return;
      }

      // ---- 保存（生成新的不可变版本；有冲突则不写）------------------------
      if (route === '/doc' && method === 'POST') {
        const body = await readJsonBody(req, config.maxDocumentBytes);
        const target = await resolveTarget(body);
        if (target.error !== undefined) {
          sendJson(res, 400, { error: target.error });
          return;
        }
        const store = storeFor(target.workspacePath);
        const saved = await store.saveDoc(target.docId, body.content ?? '', {
          source: typeof body.source === 'string' ? body.source : 'user',
          note: typeof body.note === 'string' ? body.note : '',
          title: typeof body.title === 'string' ? body.title : undefined,
          baseVersion: Number.isInteger(body.baseVersion) ? body.baseVersion : undefined,
          force: body.force === true,
          allowEmpty: body.allowEmpty === true,
        });

        if (saved.emptyRejected === true) {
          logger?.info?.(`writing-canvas: ${target.docId} 空内容覆盖被拦下（服务端 v${saved.latest.n} 非空）`);
          sendJson(res, 409, {
            emptyRejected: true,
            docId: target.docId,
            workspace: saved.workspace,
            meta: saved.meta,
            latest: saved.latest,
            versions: await store.listVersions(target.docId),
            message: '正文为空，已阻止覆盖：服务端当前版本不是空的。确实要清空请显式确认。',
          });
          return;
        }

        if (saved.conflict === true) {
          logger?.info?.(`writing-canvas: ${target.docId} 检测到冲突（服务端已到 v${saved.latest.n}），未写入`);
          sendJson(res, 409, {
            conflict: true,
            docId: target.docId,
            workspace: saved.workspace,
            meta: saved.meta,
            latest: saved.latest,
            versions: await store.listVersions(target.docId),
          });
          return;
        }

        logger?.info?.(
          `writing-canvas: 保存 ${target.docId} → v${saved.latest.n}${saved.unchanged ? '（内容未变，跳过）' : ''}`,
        );
        if (saved.unchanged !== true) {
          bus?.publishDocChanged?.(target.docId, {
            version: saved.latest.n,
            source: saved.latest.source,
            note: saved.latest.note,
          });
        }
        // 声明是 Agent 在写时，同步驱动界面上的「撰写中」指示；
        // final === false 表示后面还有内容，界面会一直显示到收到 final 为止。
        if (saved.latest.source === 'agent') {
          bus?.setWriting?.(target.docId, body.final === false, typeof body.note === 'string' ? body.note : '');
        }
        sendJson(res, 200, {
          ok: true,
          docId: target.docId,
          workspace: saved.workspace,
          meta: saved.meta,
          latest: saved.latest,
          versions: await store.listVersions(target.docId),
          annotations: await annotationsFor(target.workspacePath).list(target.docId, saved.latest.content),
          unchanged: saved.unchanged === true,
        });
        return;
      }

      // ---- 读取单个版本 --------------------------------------------------
      if (route === '/doc/version' && method === 'GET') {
        const target = await resolveTarget(paramsFromUrl(url));
        if (target.error !== undefined) {
          sendJson(res, 400, { error: target.error });
          return;
        }
        const n = Number(url.searchParams.get('n'));
        const record = await storeFor(target.workspacePath).readVersion(target.docId, n);
        if (record === null) {
          sendJson(res, 404, { error: 'version-not-found', docId: target.docId, n });
          return;
        }
        sendJson(res, 200, { ok: true, docId: target.docId, version: record });
        return;
      }

      // ---- 还原（把历史内容写成新版本，历史本身不破坏）--------------------
      if (route === '/doc/restore' && method === 'POST') {
        const body = await readJsonBody(req, config.maxDocumentBytes);
        const target = await resolveTarget(body);
        if (target.error !== undefined) {
          sendJson(res, 400, { error: target.error });
          return;
        }
        const store = storeFor(target.workspacePath);
        const restored = await store.restoreVersion(target.docId, Number(body.n));
        bus?.publishDocChanged?.(target.docId, { version: restored.latest.n, source: 'restore' });
        sendJson(res, 200, {
          ok: true,
          docId: target.docId,
          workspace: restored.workspace,
          meta: restored.meta,
          latest: restored.latest,
          versions: await store.listVersions(target.docId),
          annotations: await annotationsFor(target.workspacePath).list(target.docId, restored.latest.content),
        });
        return;
      }

      // ---- 设定写作类型（界面里用户直接选）--------------------------------
      // ---- 选中格式集即生效（不再需要点确认按钮）------------------------
      if (route === '/doc/format' && method === 'POST') {
        const body = await readJsonBody(req, 64 * 1024);
        const target = await resolveTarget(body);
        if (target.error !== undefined) {
          sendJson(res, 400, { error: target.error });
          return;
        }
        const setId = typeof body.setId === 'string' ? body.setId : '';
        // 只记录选择，不动正文、不产生版本——格式集是文档级设置。
        const meta = await storeFor(target.workspacePath).setFormat(target.docId, setId);
        sendJson(res, 200, { ok: true, set: meta.format?.set ?? null });
        return;
      }

      if (route === '/doc/type' && method === 'POST') {
        const body = await readJsonBody(req, 64 * 1024);
        const target = await resolveTarget(body);
        if (target.error !== undefined) {
          sendJson(res, 400, { error: target.error });
          return;
        }
        const wanted = typeof body.typeId === 'string' ? body.typeId : '';
        const known = listTypes();
        if (wanted === '') {
          await storeFor(target.workspacePath).setType(target.docId, undefined);
          sendJson(res, 200, { ok: true, writingType: null });
          return;
        }
        const type = known.find((item) => item.id === wanted);
        if (type === undefined) {
          sendJson(res, 400, { error: 'unknown-writing-type', typeId: wanted, available: known.map((t) => t.id) });
          return;
        }
        const meta = await storeFor(target.workspacePath).setType(target.docId, type.id);
        sendJson(res, 200, {
          ok: true,
          writingType: type.id,
          label: type.label,
          format: meta.format,
          mustConfirm: type.mustConfirm ?? [],
        });
        return;
      }

      // ---- 批注 ----------------------------------------------------------
      if (route === '/annotations' && method === 'GET') {
        const target = await resolveTarget(paramsFromUrl(url));
        if (target.error !== undefined) {
          sendJson(res, 400, { error: target.error });
          return;
        }
        const doc = await storeFor(target.workspacePath).readDoc(target.docId);
        const annotations = await annotationsFor(target.workspacePath).list(target.docId, doc?.latest?.content);
        sendJson(res, 200, { ok: true, docId: target.docId, annotations });
        return;
      }

      if (route === '/annotations' && method === 'POST') {
        const body = await readJsonBody(req, 256 * 1024);
        const target = await resolveTarget(body);
        if (target.error !== undefined) {
          sendJson(res, 400, { error: target.error });
          return;
        }
        const store = annotationsFor(target.workspacePath);
        const annotation = await store.create(target.docId, {
          quote: body.quote,
          range: body.range,
          kind: body.kind,
          instruction: body.instruction,
          author: body.author,
          anchorVersion: body.anchorVersion,
        });
        const doc = await storeFor(target.workspacePath).readDoc(target.docId);
        const annotations = await store.list(target.docId, doc?.latest?.content);
        bus?.publishAnnotationsChanged?.(target.docId, { count: annotations.length });
        sendJson(res, 200, { ok: true, annotation, annotations });
        return;
      }

      if (route === '/annotations/update' && method === 'POST') {
        const body = await readJsonBody(req, 256 * 1024);
        const target = await resolveTarget(body);
        if (target.error !== undefined) {
          sendJson(res, 400, { error: target.error });
          return;
        }
        const store = annotationsFor(target.workspacePath);
        const updated = await store.update(target.docId, body.id, {
          status: body.status,
          reply: body.reply,
          author: body.author,
          instruction: body.instruction,
          resolvedVersion: body.resolvedVersion,
          resolutionNote: body.resolutionNote,
        });
        if (updated === null) {
          sendJson(res, 404, { error: 'annotation-not-found', id: body.id });
          return;
        }
        const doc = await storeFor(target.workspacePath).readDoc(target.docId);
        const annotations = await store.list(target.docId, doc?.latest?.content);
        bus?.publishAnnotationsChanged?.(target.docId, { count: annotations.length });
        sendJson(res, 200, { ok: true, annotation: updated, annotations });
        return;
      }

      if (route === '/annotations/delete' && method === 'POST') {
        const body = await readJsonBody(req, 64 * 1024);
        const target = await resolveTarget(body);
        if (target.error !== undefined) {
          sendJson(res, 400, { error: target.error });
          return;
        }
        const store = annotationsFor(target.workspacePath);
        const removed = await store.remove(target.docId, body.id);
        const doc = await storeFor(target.workspacePath).readDoc(target.docId);
        const annotations = await store.list(target.docId, doc?.latest?.content);
        bus?.publishAnnotationsChanged?.(target.docId, { count: annotations.length });
        sendJson(res, 200, { ok: removed, annotations });
        return;
      }

      // ---- 撰写状态（外部驱动可据此点亮界面上的「撰写中」，无需改动正文）----
      if (route === '/doc/writing' && method === 'POST') {
        const body = await readJsonBody(req, 64 * 1024);
        const target = await resolveTarget(body);
        if (target.error !== undefined) {
          sendJson(res, 400, { error: target.error });
          return;
        }
        bus?.setWriting?.(target.docId, body.active === true, typeof body.note === 'string' ? body.note : '');
        sendJson(res, 200, { ok: true, docId: target.docId, writing: bus?.writingState?.(target.docId) ?? null });
        return;
      }

      // ---- 格式集（Set）：内置 Markdown 体例 + 内置 DOCX 规格 + 用户自定义 ----
      // ---- 写作类型提示词（用户在画布里点开「提示词」可自行修改）------------
      //   GET  返回该类型的**当前生效提示词**（用户覆盖优先，否则是内置拼装）
      //   POST 保存覆盖；text 传空串表示恢复内置
      if (route === '/type-prompt' && method === 'GET') {
        const target = await resolveTarget(paramsFromUrl(url));
        if (target.error !== undefined) {
          sendJson(res, 400, { error: target.error });
          return;
        }
        const typeId = url.searchParams.get('typeId') ?? '';
        const type = listTypes().find((item) => item.id === typeId);
        if (type === undefined) {
          sendJson(res, 404, { ok: false, error: `没有这个写作类型：${typeId}` });
          return;
        }
        const overrides = await libraryFor(target.workspacePath).listTypePrompts();
        // 顺手把库里的覆盖灌进共享缓存：用户打开面板时缓存就该是有值的。
        mergeOverrides(overrides);
        const override = overrides[typeId];
        sendJson(res, 200, {
          ok: true,
          typeId,
          label: type.label,
          // 用户改过就是用户那版，否则是内置拼装出来的默认提示词。
          text: typeof override === 'string' && override.trim() !== '' ? override : defaultTypePromptText(type),
          isCustom: typeof override === 'string' && override.trim() !== '',
        });
        return;
      }

      if (route === '/type-prompt' && method === 'POST') {
        const body = await readJsonBody(req, config.maxDocumentBytes);
        const target = await resolveTarget(body);
        if (target.error !== undefined) {
          sendJson(res, 400, { error: target.error });
          return;
        }
        const typeId = typeof body.typeId === 'string' ? body.typeId : '';
        if (listTypes().every((item) => item.id !== typeId)) {
          sendJson(res, 404, { ok: false, error: `没有这个写作类型：${typeId}` });
          return;
        }
        const library = libraryFor(target.workspacePath);
        const overrides = await library.setTypePrompt(typeId, typeof body.text === 'string' ? body.text : '');
        // 1) 刷新共享缓存：提示段渲染时读的就是它。
        mergeOverrides(overrides);
        // 2) 通知宿主重装那一段——提示段的正文是注册那一刻算好的，不重装不生效。
        onPromptChanged?.();
        sendJson(res, 200, {
          ok: true,
          typeId,
          isCustom: overrides[typeId] !== undefined,
          text: typeof overrides[typeId] === 'string' ? overrides[typeId] : '',
        });
        return;
      }

      if (route === '/format-sets' && method === 'GET') {
        const target = await resolveTarget(paramsFromUrl(url));
        const userSets = target.error === undefined ? await libraryFor(target.workspacePath).listSets() : [];
        sendJson(res, 200, {
          ok: true,
          sets: [
            ...BUILTIN_MARKDOWN_SETS.map((item) => ({ ...item, source: 'builtin' })),
            ...listFormatSpecs().map((item) => ({
              id: item.id,
              name: item.label,
              description: `正文 ${item.body.fontEastAsia} ${item.body.sizePt}pt${
                item.body.lineSpacingPt ? ` · 固定行距 ${item.body.lineSpacingPt}pt` : ''
              }`,
              kind: 'docx',
              builtin: true,
              source: 'builtin',
            })),
            ...userSets.map((item) => ({ ...item, source: 'user' })),
          ],
        });
        return;
      }

      if (route === '/format-sets/create' && method === 'POST') {
        const body = await readJsonBody(req, 256 * 1024);
        const target = await resolveTarget(body);
        if (target.error !== undefined) {
          sendJson(res, 400, { error: target.error });
          return;
        }
        const created = await libraryFor(target.workspacePath).createSet({
          name: body.name,
          description: body.description,
          kind: body.kind,
          definition: body.definition,
          createdBy: body.createdBy,
        });
        sendJson(res, 200, { ok: true, set: created });
        return;
      }

      if (route === '/format-sets/update' && method === 'POST') {
        const body = await readJsonBody(req, 256 * 1024);
        const target = await resolveTarget(body);
        if (target.error !== undefined) {
          sendJson(res, 400, { error: target.error });
          return;
        }
        const updated = await libraryFor(target.workspacePath).updateSet(body.id, {
          name: body.name,
          description: body.description,
          definition: body.definition,
        });
        if (updated === null) {
          sendJson(res, 404, { error: 'set-not-found', id: body.id });
          return;
        }
        sendJson(res, 200, { ok: true, set: updated });
        return;
      }

      if (route === '/format-sets/delete' && method === 'POST') {
        const body = await readJsonBody(req, 64 * 1024);
        const target = await resolveTarget(body);
        if (target.error !== undefined) {
          sendJson(res, 400, { error: target.error });
          return;
        }
        const removed = await libraryFor(target.workspacePath).removeSet(body.id);
        sendJson(res, 200, { ok: removed });
        return;
      }

      // ---- 自定义写作类型 ------------------------------------------------
      if (route === '/custom-types/delete' && method === 'POST') {
        const body = await readJsonBody(req, 64 * 1024);
        const target = await resolveTarget(body);
        if (target.error !== undefined) {
          sendJson(res, 400, { error: target.error });
          return;
        }
        const removed = await libraryFor(target.workspacePath).removeType(body.id);
        sendJson(res, 200, { ok: removed });
        return;
      }

      // ---- 格式规格清单 --------------------------------------------------
      if (route === '/format-specs' && method === 'GET') {
        sendJson(res, 200, { ok: true, specs: listFormatSpecs() });
        return;
      }

      // ---- 一键套用格式 → 生成 DOCX 并回读校验 ---------------------------
      if (route === '/export' && method === 'POST') {
        const body = await readJsonBody(req, 256 * 1024);
        const target = await resolveTarget(body);
        if (target.error !== undefined) {
          sendJson(res, 400, { error: target.error });
          return;
        }
        const store = storeFor(target.workspacePath);
        const doc = await store.readDoc(target.docId);
        if (doc === null) {
          sendJson(res, 400, { error: 'document-empty', message: '这份文档还没有内容，先写点东西再套用格式。' });
          return;
        }

        const specId =
          typeof body.specId === 'string' && body.specId !== ''
            ? body.specId
            : (doc.meta.format?.spec ?? 'plain-docx');
        const found = getFormatSpec(specId);
        if (found === null) {
          sendJson(res, 400, {
            error: 'unknown-format-spec',
            specId,
            available: listFormatSpecs().map((item) => item.id),
          });
          return;
        }

        const report = await exportDocx({
          workspacePath: target.workspacePath,
          stateDir: config.stateDir,
          docId: target.docId,
          content: doc.latest.content,
          spec: found.spec,
          specId,
          title: doc.meta.title,
        });

        logger?.info?.(
          `writing-canvas: 套用格式 ${specId} → ${report.ok ? '校验通过' : '校验未通过'}（${
            report.verification ? `${report.verification.total - report.verification.failed}/${report.verification.total}` : report.error
          }）`,
        );
        sendJson(res, report.ok === true ? 200 : 500, {
          ...report,
          docId: target.docId,
          specLabel: found.spec.label,
          version: doc.latest.n,
        });
        return;
      }

      // ---- 修改建议：AI 只能提议，是否应用由用户决定 ----------------------
      if (route === '/suggestions' && method === 'GET') {
        const target = await resolveTarget(paramsFromUrl(url));
        if (target.error !== undefined) {
          sendJson(res, 400, { error: target.error });
          return;
        }
        const doc = await storeFor(target.workspacePath).readDoc(target.docId);
        const suggestions = await suggestionsFor(target.workspacePath).list(target.docId, doc?.latest?.content);
        sendJson(res, 200, { ok: true, docId: target.docId, suggestions });
        return;
      }

      if (route === '/suggestions' && method === 'POST') {
        const body = await readJsonBody(req, 256 * 1024);
        const target = await resolveTarget(body);
        if (target.error !== undefined) {
          sendJson(res, 400, { error: target.error });
          return;
        }
        const store = suggestionsFor(target.workspacePath);
        const suggestion = await store.create(target.docId, {
          original: body.original,
          proposed: body.proposed,
          reason: body.reason,
          range: body.range,
          anchorVersion: body.anchorVersion,
          author: body.author,
        });
        const doc = await storeFor(target.workspacePath).readDoc(target.docId);
        bus?.publishAnnotationsChanged?.(target.docId, { suggestions: true });
        sendJson(res, 200, {
          ok: true,
          suggestion,
          suggestions: await store.list(target.docId, doc?.latest?.content),
        });
        return;
      }

      if (route === '/suggestions/decide' && method === 'POST') {
        const body = await readJsonBody(req, 256 * 1024);
        const target = await resolveTarget(body);
        if (target.error !== undefined) {
          sendJson(res, 400, { error: target.error });
          return;
        }
        const store = suggestionsFor(target.workspacePath);
        const suggestion = await store.get(target.docId, body.id);
        if (suggestion === null) {
          sendJson(res, 404, { error: 'suggestion-not-found', id: body.id });
          return;
        }
        if (body.action === 'reject') {
          const rejected = await store.mark(target.docId, suggestion.id, 'rejected');
          const doc = await storeFor(target.workspacePath).readDoc(target.docId);
          sendJson(res, 200, {
            ok: true,
            suggestion: rejected,
            applied: false,
            suggestions: await store.list(target.docId, doc?.latest?.content),
          });
          return;
        }

        // 接受：把 proposed 写进正文（生成新版本）。这是**唯一**由建议改动正文的路径。
        const docStore = storeFor(target.workspacePath);
        const doc = await docStore.readDoc(target.docId);
        if (doc === null) {
          sendJson(res, 400, { error: 'document-empty' });
          return;
        }
        const applied = applySuggestion(doc.latest.content, suggestion);
        if (applied.ok !== true) {
          sendJson(res, 409, { error: 'anchor-lost', message: applied.message, suggestion });
          return;
        }
        const saved = await docStore.saveDoc(target.docId, applied.content, {
          source: 'user',
          note: `接受建议：${suggestion.reason || suggestion.original.slice(0, 20)}`,
          baseVersion: doc.latest.n,
          allowEmpty: true,
        });
        if (saved.conflict === true || saved.emptyRejected === true) {
          sendJson(res, 409, { error: 'conflict', latest: saved.latest });
          return;
        }
        const accepted = await store.mark(target.docId, suggestion.id, 'accepted');
        bus?.publishDocChanged?.(target.docId, { version: saved.latest.n, source: 'suggestion' });
        sendJson(res, 200, {
          ok: true,
          suggestion: accepted,
          applied: true,
          message: applied.message,
          latest: saved.latest,
          versions: await docStore.listVersions(target.docId),
          suggestions: await store.list(target.docId, saved.latest.content),
        });
        return;
      }

      if (route === '/suggestions/delete' && method === 'POST') {
        const body = await readJsonBody(req, 64 * 1024);
        const target = await resolveTarget(body);
        if (target.error !== undefined) {
          sendJson(res, 400, { error: target.error });
          return;
        }
        const store = suggestionsFor(target.workspacePath);
        const removed = await store.remove(target.docId, body.id);
        const doc = await storeFor(target.workspacePath).readDoc(target.docId);
        sendJson(res, 200, {
          ok: removed,
          suggestions: await store.list(target.docId, doc?.latest?.content),
        });
        return;
      }

      // ---- 浏览器侧诊断上报（开发者用）------------------------------------
      if (route === '/client-report' && method === 'POST') {
        const body = await readJsonBody(req, 64 * 1024);
        const entry = {
          at: new Date().toISOString(),
          event: typeof body.event === 'string' ? body.event : 'unknown',
          detail: body.detail ?? null,
        };
        clientReports.push(entry);
        while (clientReports.length > 50) clientReports.shift();
        logger?.info?.(`writing-canvas: 界面上报 ${entry.event} ${JSON.stringify(entry.detail)}`);
        sendJson(res, 200, { ok: true });
        return;
      }

      if (route === '/client-report' && method === 'GET') {
        sendJson(res, 200, { ok: true, count: clientReports.length, reports: clientReports });
        return;
      }

      sendJson(res, 404, { error: 'not-found', route, method });
    } catch (error) {
      logger?.warn?.(`writing-canvas: API 处理失败 ${String(error)}`);
      try {
        sendJson(res, 500, { error: 'internal-error', message: String(error) });
      } catch {
        // 响应可能已经开始（例如 SSE），此时不能再写。
      }
    }
  };
}
