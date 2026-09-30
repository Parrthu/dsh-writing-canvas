/**
 * 写作类型插件：视频文案。
 *
 * 这是一行独立的 Cordis 插件，可以单独停用。
 *
 * @module dsh-writing-canvas/types/video-script
 */

import { registerType } from './registry.js';

/** Cordis 插件名。 */
export const name = 'writing-type-video-script';

/**
 * @param ctx - Cordis 上下文。
 */
export function apply(ctx) {
  ctx.effect(
    () =>
      registerType({
        id: 'video-script',
        label: '视频文案',
        order: 30,
        summary: '短视频口播稿、分镜脚本，按秒控制节奏',
        format: { kind: 'markdown' },
        mustConfirm: ['平台与时长上限', '目标观众', '出镜形式（口播 / 剧情 / 图文）', '是否带货或引流'],
        constraints: [
          '前 3 秒必须给出钩子（冲突、疑问或明确利益点）。禁止以自我介绍、寒暄或背景铺垫开场。',
          '全篇使用口语。禁止书面语与长定语；单句不超过 20 字。',
          '必须标注节奏：每段给出预计秒数与画面提示。',
          '每 15 秒必须有信息增量或情绪转折。做不到的段落必须删减，不得用废话填充时长。',
          '禁止无法在画面上呈现的抽象表述（如"提升了整体效能"），必须换成可见的动作或结果。',
          '结尾必须给出明确的行动号召，且与视频主题直接相关。',
        ],
        structure: ['0–3 秒：钩子', '3–15 秒：建立问题', '15–45 秒：给出方法或过程', '收尾：行动号召'],
        checklist: [
          '前 3 秒是否有钩子？',
          '是否全部为口语、单句是否都短于 20 字？',
          '是否标注了每段秒数与画面？',
          '是否存在超过 15 秒没有增量的段落？',
          '结尾是否有明确的行动号召？',
        ],
      }),
    'writing-type-video-script: 注册视频文案类型',
  );
}
