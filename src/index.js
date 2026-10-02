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

import { CONSTRAINTS_SECTION_NAME, TYPES_SECTION_NAME, constraintsText, typesSectionText } from './prompt.js';
import { createEventBus } from './events.js';
import { API_PREFIX, createApiHandler } from './routes.js';
import { mergeOverrides } from './prompt-overrides.js';
import { createStoreRegistry } from './stores.js';
import { registerWritingTools } from './tools.js';
import { onTypesChanged, writingCanvasTypes } from './types/registry.js';
import { createWorkspaceLister, createWorkspaceResolver } from './workspace.js';

/** 插件在 Cordis 组合中的条目名。 */
export const name = 'writing-canvas';

/** 配置默认值。 */
const DEFAULT_CONFIG = {
  stateDir: '.writing-canvas',
  promptSectionOrder: 118,
  maxDocumentBytes: 4 * 1024 * 1024,
  // 版本折叠窗口（毫秒）：自动保存的连续小改动在此窗口内合并为一个版本。
  versionCoalesceMs: 60_000,
  // 是否向系统提示注入「写作硬约束」与「写作类型」两段。
  //
  // 默认 false，这是刻意的：本插件挂在**宿主组合**里，对每个会话都生效。
  // 若默认注入，那么无论用户建的是哪个模式的任务，模型都会被告知
  // 「你在本工作区中承担写作任务」「正文一律通过 writing_canvas_write 写入写作画布」，
  // 结果就是普通编码 / 问答任务也被当成写作任务处理——这是明确的用户投诉。
  // 只有写作模式（preset）才把它打开。
  injectPrompt: false,
  // 开发期开关：让界面自动做一次交互自检（选中正文 → 确认浮动工具条出现），
  // 结果回报到 /client-report。默认关闭，交付版本不会打扰用户。
  interactionSelfTest: false,
  // 开发期开关：自动切到整页工作台做一次结构自检，然后切回来。
  workbenchSelfTest: false,
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
    versionCoalesceMs: positive(input.versionCoalesceMs, DEFAULT_CONFIG.versionCoalesceMs),
    injectPrompt: input.injectPrompt === true,
    interactionSelfTest: input.interactionSelfTest === true,
    workbenchSelfTest: input.workbenchSelfTest === true,
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
  /** 界面与工具共用同一批存储实例，写入串行链才不会各管各的。 */
  const { storeFor, annotationsFor, suggestionsFor, libraryFor } = createStoreRegistry(config);
  /** 事件总线：把新版本与「撰写中」实时推给界面。 */
  const bus = createEventBus();

  // 0) 把写作类型注册表挂到 ctx，供**本包之外**的第三方插件注册新类型。
  //    内置类型包走同包模块直接注册，不依赖这一步，所以失败也不影响功能。
  try {
    const reflect = ctx.reflect;
    if (reflect !== undefined && typeof reflect.provide === 'function') {
      const dispose = reflect.provide('writingCanvasTypes', writingCanvasTypes);
      if (typeof dispose === 'function') {
        ctx.effect(() => dispose, 'writing-canvas: 写作类型服务');
      }
    }
  } catch (error) {
    ctx.logger.warn(`writing-canvas: 未能暴露 writingCanvasTypes 服务（不影响内置类型）：${String(error)}`);
  }

  // 1) 强指令约束提示段：跨写作类型的通用硬约束。
  //
  //    只有在写作模式下才注册（config.injectPrompt）。宿主组合对每个会话都生效，
  //    无条件注册会让所有模式的任务都被当成写作任务。
  if (config.injectPrompt) {
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

      // 1b) 写作类型与专属硬约束。
      //     写作类型是独立的插件行，注册时机晚于本插件，所以这里订阅注册表变化，
      //     每次变化都重新注册该提示段，保证提示内容始终与已启用的类型一致。
      scoped.effect(() => {
        let disposeSection = null;
        const install = () => {
          if (disposeSection !== null) disposeSection();
          disposeSection = scoped.systemPrompt.section({
            name: TYPES_SECTION_NAME,
            order: config.promptSectionOrder + 1,
            text: typesSectionText(),
          });
        };
        install();
        const unsubscribe = onTypesChanged(install);
        return () => {
          unsubscribe();
          if (disposeSection !== null) disposeSection();
        };
      }, 'writing-canvas: 写作类型提示段');
    });
  }

  /**
   * 拉起系统目录选择框，返回选中路径；用户取消返回 null。
   *
   * `directoryPicker` 由 dsh-host-directory-picker-* 注册，未必挂载
   * （远程/无头环境、或该组合没启用），所以这里**不硬依赖**：拿不到就返回
   * undefined，接口层据此退回默认导出目录并如实标注，而不是假装选过。
   *
   * 结果缓存在闭包里：服务通常在启动时就位，之后整场会话复用。
   */
  /**
   * 目录选择服务。
   *
   * 必须用 `ctx.inject` 声明式取，**不能**用 `ctx.get()` 查一次就缓存：
   * `dsh-host-directory-picker-auto` 是「启动时判定宿主处境、再把匹配的后端挂进
   * 内存根树」，也就是服务**出现得比本插件晚**；查一次就缓存下来的结果会永远停在
   * 「拿不到」上。`ctx.inject` 会等服务就绪再回调，与 webServer / tools 用的是同一套做法。
   */
  let pickerService;
  ctx.inject(['directoryPicker'], (scoped) => {
    pickerService = scoped.directoryPicker;
    ctx.logger.info('writing-canvas: 目录选择服务已就绪，导出时可让用户选保存位置');
    scoped.effect(
      () => () => {
        pickerService = undefined;
      },
      'writing-canvas: 目录选择服务',
    );
  });

  /** 给诊断用：不触发选择框，只回答「服务到底能不能用」。 */
  const pickerStatus = () => {
    if (pickerService === undefined || typeof pickerService.capability !== 'function') return 'service-unavailable';
    try {
      const kind = pickerService.capability()?.kind;
      return kind === 'native' ? 'native-ready' : `unsupported:${String(kind)}`;
    } catch {
      return 'capability-threw';
    }
  };

  /**
   * 拉起系统目录选择框。
   *
   *   1. `pick` **不在服务实例上**，而在 `service.capability()` 返回的能力对象上——
   *      判断 `service.pick` 永远是 undefined，会静默退化成"没有选择器"。
   *   2. `signal` 是必需的：native 实现在用户取消时会读 `signal.aborted`，
   *      不传会在取消路径上抛 TypeError。
   *
   * @param signal - AbortSignal，用于在请求断开时终止原生选择器。
   * @returns 选中路径 | null（用户取消）| undefined（此环境不支持系统选择器）。
   */
  const pickDirectory = async (signal) => {
    const service = pickerService;
    if (service === undefined || typeof service.capability !== 'function') return undefined;
    let capability;
    try {
      capability = service.capability();
    } catch (error) {
      ctx.logger.warn(`writing-canvas: 读取目录选择能力失败：${String(error)}`);
      return undefined;
    }
    // 只有 native 形态会开系统对话框。browse 形态是给远程客户端用的应用内浏览，
    // 本插件没实现那套 UI，按官方文档的建议「隐藏入口而不是失败」处理。
    if (capability === undefined || capability === null || capability.kind !== 'native') {
      ctx.logger.info(`writing-canvas: 目录选择能力是 ${String(capability?.kind)}，导出将使用默认目录`);
      return undefined;
    }
    if (typeof capability.pick !== 'function') return undefined;
    try {
      const picked = await capability.pick(signal ?? new AbortController().signal);
      return typeof picked === 'string' && picked !== '' ? picked : null;
    } catch (error) {
      ctx.logger.warn(`writing-canvas: 目录选择失败，将使用默认导出目录：${String(error)}`);
      return undefined;
    }
  };

  // 2) 宿主 API：文档读写、不可变版本、还原、批注、实时事件流。
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
            storeFor,
            annotationsFor,
            suggestionsFor,
            libraryFor,
            bus,
            logger: ctx.logger,
            // 提示词被用户改动后刷新共享缓存。
            // 提示段的重装由 mode/writing 自己订阅 onOverridesChanged 完成——
            // 那一段挂在 preset 的 agent scope 里，宿主这一层够不着。
            onPromptChanged: () => {},
            // 服务不可用时返回 null 会与「用户取消」混淆，所以这里把不可用
            // 直接翻成 undefined，让接口层能分清这两种情况。
            pickDirectory,
            pickerStatus,
          }),
        }),
      'writing-canvas: 宿主 API 路由',
    );
  });

  // 2b) 启动时把各工作区已有的提示词覆盖灌进共享缓存，
  //     否则重启后用户改过的提示词要等下次保存才生效。
  void (async () => {
    try {
      for (const workspace of listWorkspaces()) {
        mergeOverrides(await libraryFor(workspace.path).listTypePrompts());
      }
    } catch (error) {
      ctx.logger.warn(`writing-canvas: 读取写作类型提示词覆盖失败（不影响其他功能）：${String(error)}`);
    }
  })();

  // 3) Agent 工具：让模型真正能读写画布、读写批注、提出修改建议、套用格式。
  ctx.inject(['tools'], (scoped) => {
    registerWritingTools({
      ctx: scoped,
      resolveWorkspacePath,
      storeFor,
      annotationsFor,
      suggestionsFor,
      libraryFor,
      bus,
      // 导出工具也要能让用户挑保存位置，和界面上的导出按钮走同一条路。
      pickDirectory,
    });
  });

  ctx.logger.info(
    `writing-canvas: 写作插件宿主半体已挂载（API ${API_PREFIX}，状态目录 ${config.stateDir}）`,
  );
}



