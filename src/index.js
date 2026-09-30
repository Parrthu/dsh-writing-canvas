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
import { API_PREFIX, createApiHandler } from './routes.js';
import { createWorkspaceLister, createWorkspaceResolver } from './workspace.js';

/** 插件在 Cordis 组合中的条目名。 */
export const name = 'writing-canvas';

/** 配置默认值。 */
const DEFAULT_CONFIG = {
  stateDir: '.writing-canvas',
  promptSectionOrder: 118,
  maxDocumentBytes: 4 * 1024 * 1024,
};

/**
 * 合并用户配置与默认值。
 * @param raw - 来自补丁层 config 的原始值。
 * @returns 完整配置。
 */
function resolveConfig(raw) {
  const input = raw !== null && typeof raw === 'object' ? raw : {};
  const positive = (value, fallback) => (Number.isFinite(value) && value > 0 ? value : fallback);
  return {
    stateDir:
      typeof input.stateDir === 'string' && input.stateDir !== '' ? input.stateDir : DEFAULT_CONFIG.stateDir,
    promptSectionOrder: Number.isFinite(input.promptSectionOrder)
      ? input.promptSectionOrder
      : DEFAULT_CONFIG.promptSectionOrder,
    maxDocumentBytes: positive(input.maxDocumentBytes, DEFAULT_CONFIG.maxDocumentBytes),
  };
}

/**
 * 挂载写作插件宿主半体。
 * @param ctx - Cordis 上下文。
 * @param rawConfig - 补丁层传入的 config。
 */
export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig);
  const resolveWorkspacePath = createWorkspaceResolver(ctx);
  const listWorkspaces = createWorkspaceLister(ctx);

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

  // 2) 宿主 API：文档读写、不可变版本、还原。
  ctx.inject(['webServer'], (scoped) => {
    scoped.effect(
      () =>
        scoped.webServer.register({
          kind: 'prefix',
          path: API_PREFIX,
          handler: createApiHandler({
            config,
            resolveWorkspacePath,
            listWorkspaces,
            logger: ctx.logger,
          }),
        }),
      'writing-canvas: 宿主 API 路由',
    );
  });

  ctx.logger.info(
    `writing-canvas: 写作插件宿主半体已挂载（API ${API_PREFIX}，状态目录 ${config.stateDir}）`,
  );
}


