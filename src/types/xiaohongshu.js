/**
 * 写作类型插件：小红书文案。
 *
 * 这是一行独立的 Cordis 插件，可以单独停用。
 *
 * @module dsh-writing-canvas/types/xiaohongshu
 */

import { registerType } from './registry.js';

/** Cordis 插件名。 */
export const name = 'writing-type-xiaohongshu';

/**
 * @param ctx - Cordis 上下文。
 */
export function apply(ctx) {
  ctx.effect(
    () =>
      registerType({
        id: 'xiaohongshu',
        label: '小红书文案',
        order: 40,
        summary: '笔记标题与正文，重真实体验与互动',
        format: { kind: 'markdown' },
        mustConfirm: ['笔记主题与品类', '是否带货 / 报备', '目标人群', '是分享还是测评'],
        constraints: [
          '标题不超过 20 字，必须包含具体利益点或情绪词。禁止标题党式的虚假承诺。',
          '正文分段，每段不超过 3 行，段间空行。',
          'emoji 每段最多 1 个，禁止连续堆砌。',
          '必须基于真实体验叙述。禁止编造效果；涉及健康、功效、收益的内容不得作出保证性承诺。',
          '价格、折扣必须注明获取渠道与时间。禁用"最便宜""全网最低""第一"等绝对化用语。',
          '结尾必须有互动引导，或明确说明适用人群与不适用人群。',
          '标签 3–6 个，必须与内容相关。禁止堆砌无关热词。',
        ],
        structure: ['标题', '开头一句话结论', '分点体验或方法', '适用人群与避雷', '互动引导', '标签'],
        checklist: [
          '标题是否超过 20 字？',
          '是否有段落超过 3 行？',
          'emoji 是否堆砌？',
          '是否存在编造效果或保证性承诺？',
          '是否出现绝对化用语？',
          '是否说明了适用与不适用人群？',
          '标签是否与内容相关且不超过 6 个？',
        ],
      }),
    'writing-type-xiaohongshu: 注册小红书文案类型',
  );
}
