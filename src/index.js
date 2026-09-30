/**
 * dsh-writing-canvas · 宿主半体（Host half）
 *
 * 目标 Release：DeepSeek Harness 0.2.0-rc.2（cordis 4.0.4）
 *
 * 设计约束（有意为之）：
 * - 不静态导入任何 `@deepseek-ai/*` SDK 包。所有协作服务一律通过
 *   `ctx.inject([...], ...)` 动态获取，因此本包**不需要声明 peerDependencies**，
 *   也就不会被 0.2.0-rc.2 的版本兼容性网关拦下。
 * - 无构建步骤：`src/` 与 `client/` 里的文件就是最终产物。
 *
 * @module dsh-writing-canvas
 */

import { CONSTRAINTS_SECTION_NAME, constraintsText } from './prompt.js';

/** 插件在 Cordis 组合中的条目名。 */
export const name = 'writing-canvas';

/** 宿主 API 前缀（与 /plugins 的 bundle 路由刻意分开，避免遮蔽客户端 bundle）。 */
export const API_PREFIX = '/writing-canvas/api';

/** 解析后的运行配置默认值。 */
const DEFAULT_CONFIG = {
  stateDir: '.writing-canvas',
  promptSectionOrder: 118,
};

/**
 * 合并用户配置与默认值。
 * @param raw - 来自补丁层 config 的原始值。
 * @returns 完整配置。
 */
function resolveConfig(raw) {
  const input = raw !== null && typeof raw === 'object' ? raw : {};
  return {
    stateDir: typeof input.stateDir === 'string' && input.stateDir !== '' ? input.stateDir : DEFAULT_CONFIG.stateDir,
    promptSectionOrder: Number.isFinite(input.promptSectionOrder)
      ? input.promptSectionOrder
      : DEFAULT_CONFIG.promptSectionOrder,
  };
}

/**
 * 写出一个 JSON 响应。
 * @param res - node:http 响应对象。
 * @param status - HTTP 状态码。
 * @param payload - 任意可序列化值。
 */
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
}

/**
 * 处理写作工作台的宿主 API 请求。
 * @param config - 已解析配置。
 * @returns node:http 风格的 (req, res) 处理器。
 */
function createApiHandler(config) {
  return (req, res) => {
    let pathname;
    try {
      pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    } catch {
      sendJson(res, 400, { error: 'bad-request' });
      return;
    }

    const route = pathname.startsWith(API_PREFIX) ? pathname.slice(API_PREFIX.length) : pathname;

    if (route === '/health' || route === '/' || route === '') {
      sendJson(res, 200, {
        ok: true,
        plugin: 'dsh-writing-canvas',
        phase: 'P0',
        release: '0.2.0-rc.2',
        stateDir: config.stateDir,
        constraintsSection: CONSTRAINTS_SECTION_NAME,
      });
      return;
    }

    sendJson(res, 404, { error: 'not-found', route });
  };
}

/**
 * 挂载写作插件宿主半体。
 * @param ctx - Cordis 上下文。
 * @param rawConfig - 补丁层传入的 config。
 */
export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig);

  // 1) 强指令约束提示段：跨写作类型的通用硬约束。
  ctx.inject(['systemPrompt'], (scoped) => {
    scoped.effect(
      () =>
        scoped.systemPrompt.section({
          name: CONSTRAINTS_SECTION_NAME,
          order: config.promptSectionOrder,
          text: constraintsText(),
        }),
      'writing-canvas: 强指令约束提示段',
    );
  });

  // 2) 宿主 API：供写作工作台界面读写状态。
  ctx.inject(['webServer'], (scoped) => {
    scoped.effect(
      () =>
        scoped.webServer.register({
          kind: 'prefix',
          path: API_PREFIX,
          handler: createApiHandler(config),
        }),
      'writing-canvas: 宿主 API 路由',
    );
  });

  ctx.logger.info(
    `writing-canvas: 写作插件宿主半体已挂载（API ${API_PREFIX}，状态目录 ${config.stateDir}）`,
  );
}
