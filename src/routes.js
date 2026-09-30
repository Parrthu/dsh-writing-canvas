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

import { DocumentStore } from './store.js';

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
 * @param options.logger - 可选日志器。
 * @returns node:http 风格的 (req, res) 处理器。
 */
export function createApiHandler({ config, resolveWorkspacePath, listWorkspaces, logger }) {
  /** 同一工作区复用同一个 DocumentStore 实例（写入链才有意义）。 */
  const stores = new Map();

  const storeFor = (workspacePath) => {
    let store = stores.get(workspacePath);
    if (store === undefined) {
      store = new DocumentStore(workspacePath, config.stateDir);
      stores.set(workspacePath, store);
    }
    return store;
  };

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
          phase: 'P1',
          release: '0.2.0-rc.2',
          stateDir: config.stateDir,
          constraintsSection: 'writing-canvas:constraints',
        });
        return;
      }

      // ---- 工作区与文档总览（工作台整页用）--------------------------------
      if (route === '/docs' && method === 'GET') {
        const workspaces = listWorkspaces();
        const documents = [];
        for (const workspace of workspaces) {
          const store = storeFor(workspace.path);
          const docs = await store.listDocuments();
          for (const doc of docs) documents.push({ ...doc, workspaceTitle: workspace.title });
        }
        documents.sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')));
        sendJson(res, 200, { ok: true, workspaces, documents });
        return;
      }

      // ---- 读取文档 ------------------------------------------------------
      if (route === '/doc' && method === 'GET') {
        const target = await resolveTarget({
          sessionId: url.searchParams.get('sessionId') ?? undefined,
          workspace: url.searchParams.get('workspace') ?? undefined,
          docId: url.searchParams.get('docId') ?? undefined,
        });
        if (target.error !== undefined) {
          sendJson(res, 400, { error: target.error });
          return;
        }
        const store = storeFor(target.workspacePath);
        const doc = await store.readDoc(target.docId);
        const versions = doc === null ? [] : await store.listVersions(target.docId);
        sendJson(res, 200, {
          exists: doc !== null,
          docId: target.docId,
          workspace: target.workspacePath,
          meta: doc?.meta ?? null,
          latest: doc?.latest ?? null,
          versions,
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
        });

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
        sendJson(res, 200, {
          ok: true,
          docId: target.docId,
          workspace: saved.workspace,
          meta: saved.meta,
          latest: saved.latest,
          versions: await store.listVersions(target.docId),
          unchanged: saved.unchanged === true,
        });
        return;
      }

      // ---- 读取单个版本 --------------------------------------------------
      if (route === '/doc/version' && method === 'GET') {
        const target = await resolveTarget({
          sessionId: url.searchParams.get('sessionId') ?? undefined,
          workspace: url.searchParams.get('workspace') ?? undefined,
          docId: url.searchParams.get('docId') ?? undefined,
        });
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
        sendJson(res, 200, {
          ok: true,
          docId: target.docId,
          workspace: restored.workspace,
          meta: restored.meta,
          latest: restored.latest,
          versions: await store.listVersions(target.docId),
        });
        return;
      }

      sendJson(res, 404, { error: 'not-found', route, method });
    } catch (error) {
      logger?.warn?.(`writing-canvas: API 处理失败 ${String(error)}`);
      sendJson(res, 500, { error: 'internal-error', message: String(error) });
    }
  };
}
