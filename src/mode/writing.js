/**
 * 写作模式（preset）专用的提示段插件。
 *
 * 为什么单独做一个插件，而不是让宿主那行无条件注入提示：
 *
 * 写作画布本体挂在**宿主组合**里，对每个会话都生效——界面、路由、工具都是全局的，
 * 这是对的（画布随时可以被调出来用）。但「写作硬约束」和「写作类型」这两段系统提示
 * **只应该在写作模式下出现**。
 *
 * 现在把这两段提示拆到这里：只有挂载了本行的写作模式预设才会注入，
 * 其他模式完全看不到写作提示。
 *
 * @module dsh-writing-canvas/mode/writing
 */

import { CONSTRAINTS_SECTION_NAME, TYPES_SECTION_NAME, constraintsText, typesSectionText } from '../prompt.js';
import { currentOverrides, onOverridesChanged } from '../prompt-overrides.js';
import { onTypesChanged } from '../types/registry.js';

/** 插件在 Cordis 组合中的条目名。 */
export const name = 'writing-canvas-mode-writing';

/** 提示段顺序：与宿主的 promptSectionOrder 默认值保持一致。 */
const CONSTRAINTS_ORDER = 118;

/**
 * 挂载写作模式的提示段。
 * @param ctx - Cordis 上下文（必须是 agent scope，preset 内挂载天然满足）。
 */
export function apply(ctx) {
  if (ctx === undefined || ctx === null) return;

  ctx.inject(['systemPrompt'], (scoped) => {
    // 通用硬约束。
    scoped.effect(
      () =>
        scoped.systemPrompt.section({
          name: CONSTRAINTS_SECTION_NAME,
          order: CONSTRAINTS_ORDER,
          text: constraintsText(),
        }),
      'writing-mode: 强指令约束提示段',
    );

    // 写作类型与专属硬约束。
    // 写作类型是独立的插件行，注册时机可能晚于本行，所以订阅注册表变化重新注册，
    // 保证提示内容始终与已启用的类型一致。
    //
    // 同时订阅「提示词覆盖」变化：用户在画布上改完某个类型的提示词要立刻生效，
    // 不能等重启——提示段的正文是注册那一刻算好的，所以这里必须整段重装。
    scoped.effect(() => {
      let disposeSection = null;
      const install = () => {
        if (disposeSection !== null) disposeSection();
        disposeSection = scoped.systemPrompt.section({
          name: TYPES_SECTION_NAME,
          order: CONSTRAINTS_ORDER + 1,
          text: typesSectionText(currentOverrides()),
        });
      };
      install();
      const unsubscribeTypes = onTypesChanged(install);
      const unsubscribePrompts = onOverridesChanged(install);
      return () => {
        unsubscribeTypes();
        unsubscribePrompts();
        if (disposeSection !== null) disposeSection();
      };
    }, 'writing-mode: 写作类型提示段');
  });
}
