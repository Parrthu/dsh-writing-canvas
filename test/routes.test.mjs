/**
 * 宿主 API 路由的真实行为测试。
 *
 * 直接实例化 createApiHandler，用假的 req/res 驱动，覆盖：
 * 两种寻址方式、冲突返回 409、还原、版本读取、越权工作区被拒。
 *
 * 运行：node --test test/routes.test.mjs
 */

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createApiHandler, docIdOfSession } from '../src/routes.js';

/** 造一个最小的 node:http 请求对象。 */
function makeReq(method, url, body) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.destroy = () => {};
  // 在下一个 tick 抛出数据，模拟真实流。
  process.nextTick(() => {
    if (body !== undefined) req.emit('data', Buffer.from(JSON.stringify(body), 'utf8'));
    req.emit('end');
  });
  return req;
}

/** 造一个最小的 node:http 响应对象，收集结果。 */
function makeRes() {
  const res = {
    status: null,
    headers: null,
    body: '',
    writeHead(status, headers) {
      res.status = status;
      res.headers = headers;
    },
    end(chunk) {
      res.body = chunk ?? '';
      res.json = (() => {
        try {
          return JSON.parse(res.body);
        } catch {
          return null;
        }
      })();
    },
  };
  return res;
}

/** 调用处理器并拿到 { status, json }。 */
async function call(handler, method, url, body) {
  const res = makeRes();
  await handler(makeReq(method, url, body), res);
  return { status: res.status, json: res.json, headers: res.headers };
}

/** 建一个用完即删的临时工作区，返回 handler。 */
async function withHandler(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'writing-canvas-routes-'));
  const config = { stateDir: '.writing-canvas', maxDocumentBytes: 1024 * 1024, promptSectionOrder: 118 };
  const workspaces = [{ id: 'w1', path: dir, title: '测试工作区' }];
  const handler = createApiHandler({
    config,
    resolveWorkspacePath: async () => dir,
    listWorkspaces: () => workspaces,
    logger: { info() {}, warn() {} },
  });
  try {
    await fn(handler, dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('会话 id 被映射为安全且稳定的文档 id', () => {
  assert.equal(docIdOfSession('session-abc-123'), 's-session-abc-123');
  assert.equal(docIdOfSession(''), 'default');
  assert.equal(docIdOfSession(undefined), 'default');
  assert.equal(docIdOfSession('a/b:c d'), 's-a_b_c_d');
});

test('health 报告插件已挂载', async () => {
  await withHandler(async (handler) => {
    const { status, json } = await call(handler, 'GET', '/writing-canvas/api/health');
    assert.equal(status, 200);
    assert.equal(json.ok, true);
    assert.equal(json.plugin, 'dsh-writing-canvas');
    assert.equal(json.constraintsSection, 'writing-canvas:constraints');
  });
});

test('未写入过的文档返回 exists=false 而不是报错', async () => {
  await withHandler(async (handler) => {
    const { status, json } = await call(handler, 'GET', '/writing-canvas/api/doc?sessionId=session-1');
    assert.equal(status, 200);
    assert.equal(json.exists, false);
    assert.equal(json.latest, null);
    assert.deepEqual(json.versions, []);
    assert.equal(json.docId, 's-session-1');
  });
});

test('保存后能读回正文、版本号与版本列表', async () => {
  await withHandler(async (handler) => {
    const saved = await call(handler, 'POST', '/writing-canvas/api/doc', {
      sessionId: 'session-1',
      content: '第一版正文',
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.json.latest.n, 1);
    assert.equal(saved.json.latest.content, '第一版正文');
    assert.equal(saved.json.versions.length, 1);

    const read = await call(handler, 'GET', '/writing-canvas/api/doc?sessionId=session-1');
    assert.equal(read.json.exists, true);
    assert.equal(read.json.latest.content, '第一版正文');
  });
});

test('基于过期版本的保存返回 409 且不写入（冲突保护走到 HTTP 层）', async () => {
  await withHandler(async (handler) => {
    await call(handler, 'POST', '/writing-canvas/api/doc', { sessionId: 's1', content: '用户版本' });
    await call(handler, 'POST', '/writing-canvas/api/doc', {
      sessionId: 's1',
      content: 'AI 写入',
      source: 'agent',
    });

    const conflict = await call(handler, 'POST', '/writing-canvas/api/doc', {
      sessionId: 's1',
      content: '用户基于 v1 的编辑',
      baseVersion: 1,
    });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.json.conflict, true);
    assert.equal(conflict.json.latest.content, 'AI 写入');

    // 再读一次，确认真的没写进去。
    const read = await call(handler, 'GET', '/writing-canvas/api/doc?sessionId=s1');
    assert.equal(read.json.latest.content, 'AI 写入');
    assert.equal(read.json.versions.length, 2);
  });
});

test('force=true 时才覆盖', async () => {
  await withHandler(async (handler) => {
    await call(handler, 'POST', '/writing-canvas/api/doc', { sessionId: 's1', content: 'A' });
    await call(handler, 'POST', '/writing-canvas/api/doc', { sessionId: 's1', content: 'B', source: 'agent' });
    const forced = await call(handler, 'POST', '/writing-canvas/api/doc', {
      sessionId: 's1',
      content: 'C',
      baseVersion: 1,
      force: true,
    });
    assert.equal(forced.status, 200);
    assert.equal(forced.json.latest.content, 'C');
    assert.equal(forced.json.latest.n, 3);
  });
});

test('可以读取指定版本并还原为新的最新版本', async () => {
  await withHandler(async (handler) => {
    await call(handler, 'POST', '/writing-canvas/api/doc', { sessionId: 's1', content: '最初' });
    await call(handler, 'POST', '/writing-canvas/api/doc', { sessionId: 's1', content: '改写' });

    const version = await call(handler, 'GET', '/writing-canvas/api/doc/version?sessionId=s1&n=1');
    assert.equal(version.status, 200);
    assert.equal(version.json.version.content, '最初');

    const restored = await call(handler, 'POST', '/writing-canvas/api/doc/restore', { sessionId: 's1', n: 1 });
    assert.equal(restored.status, 200);
    assert.equal(restored.json.latest.content, '最初');
    assert.equal(restored.json.latest.n, 3);
    assert.equal(restored.json.versions.length, 3);
  });
});

test('不存在的版本返回 404', async () => {
  await withHandler(async (handler) => {
    const { status, json } = await call(handler, 'GET', '/writing-canvas/api/doc/version?sessionId=s1&n=99');
    assert.equal(status, 404);
    assert.equal(json.error, 'version-not-found');
  });
});

test('总览接口同时返回工作区与文档，并带上工作区标题', async () => {
  await withHandler(async (handler) => {
    await call(handler, 'POST', '/writing-canvas/api/doc', { sessionId: 's1', content: '内容一' });
    const { status, json } = await call(handler, 'GET', '/writing-canvas/api/docs');
    assert.equal(status, 200);
    assert.equal(json.workspaces.length, 1);
    assert.equal(json.workspaces[0].title, '测试工作区');
    assert.equal(json.documents.length, 1);
    assert.equal(json.documents[0].docId, 's-s1');
    assert.equal(json.documents[0].workspaceTitle, '测试工作区');
  });
});

test('按工作区+文档寻址可用（工作台整页的方式）', async () => {
  await withHandler(async (handler, dir) => {
    await call(handler, 'POST', '/writing-canvas/api/doc', {
      workspace: dir,
      docId: 'manual-doc',
      content: '工作台写入的内容',
    });
    const read = await call(
      handler,
      'GET',
      `/writing-canvas/api/doc?workspace=${encodeURIComponent(dir)}&docId=manual-doc`,
    );
    assert.equal(read.json.latest.content, '工作台写入的内容');
  });
});

test('未登记的工作区被拒绝，不能借 API 写到任意路径', async () => {
  await withHandler(async (handler) => {
    const { status, json } = await call(handler, 'POST', '/writing-canvas/api/doc', {
      workspace: '/etc',
      docId: 'evil',
      content: 'x',
    });
    assert.equal(status, 400);
    assert.equal(json.error, 'unknown-workspace');
  });
});

test('未知路由返回 404 而不是 500', async () => {
  await withHandler(async (handler) => {
    const { status, json } = await call(handler, 'GET', '/writing-canvas/api/nope');
    assert.equal(status, 404);
    assert.equal(json.error, 'not-found');
  });
});

test('非法 JSON 请求体被拒绝', async () => {
  await withHandler(async (handler) => {
    const res = makeRes();
    const req = new EventEmitter();
    req.method = 'POST';
    req.url = '/writing-canvas/api/doc';
    req.destroy = () => {};
    process.nextTick(() => {
      req.emit('data', Buffer.from('{ 这不是 JSON', 'utf8'));
      req.emit('end');
    });
    await handler(req, res);
    assert.equal(res.status, 500);
    assert.equal(res.json.error, 'internal-error');
  });
});
