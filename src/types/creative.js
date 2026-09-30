/**
 * 写作类型插件：创意写作。
 *
 * 这是一行独立的 Cordis 插件（见 cordis.patch.yml），可以在 profile 里单独停用。
 *
 * @module dsh-writing-canvas/types/creative
 */

import { registerType } from './registry.js';

/** Cordis 插件名。 */
export const name = 'writing-type-creative';

/**
 * @param ctx - Cordis 上下文。
 */
export function apply(ctx) {
  ctx.effect(
    () =>
      registerType({
        id: 'creative',
        label: '创意写作',
        order: 10,
        summary: '小说、故事、散文等以表达力与感染力为目标的写作',
        format: { kind: 'markdown' },
        mustConfirm: ['体裁（短篇 / 长篇章节 / 散文 / 剧本）', '目标读者与基调', '篇幅', '人称与视角'],
        constraints: [
          '人物必须先有欲望与阻力，再谈情节。禁止为推进情节而让人物做出违背自身动机的事。',
          '场景必须落到具体感官细节（看到 / 听到 / 闻到 / 触到）。禁止用"很美""很伤心"这类概括词代替描写。',
          '对话必须推进信息或关系。禁止只有寒暄功能的对话。',
          '禁用陈词滥调：心中一紧、泪水夺眶而出、时间仿佛静止、嘴角勾起一抹弧度等。确需类似效果时必须具体化改写。',
          '人称与视角一旦确定，全篇不得漂移。禁止写出视角人物不可能知道的信息。',
          '每个场景必须有变化：进入时与离开时，人物处境或人物关系必须不同。',
        ],
        structure: ['开场：打破日常的瞬间', '发展：欲望与阻力交锋', '转折：代价显现', '收束：新的平衡'],
        checklist: [
          '主要人物是否有明确的欲望与阻力？',
          '是否存在只为交代背景而存在的段落？',
          '视角是否全篇一致？',
          '是否出现了陈词滥调？',
          '结尾是否与开场形成呼应或反差？',
        ],
      }),
    'writing-type-creative: 注册创意写作类型',
  );
}
