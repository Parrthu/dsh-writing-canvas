/**
 * 强指令约束提示段。
 *
 * 这一段的定位不是"建议"，而是**不可协商的硬约束**：它约束 Agent 在写作任务中的
 * 行为边界。写作类型的专属约束由各写作类型插件提供，本文件负责把它们汇总成
 * 另一段提示（typesSectionText），使约束对模型始终可见。
 *
 * @module dsh-writing-canvas/prompt
 */

import { listTypes } from './types/registry.js';

/** 强指令约束段的段名（在系统提示注册表中的唯一标识）。 */
export const CONSTRAINTS_SECTION_NAME = 'writing-canvas:constraints';

/** 写作类型段的段名。 */
export const TYPES_SECTION_NAME = 'writing-canvas:types';

/**
 * 渲染写作类型段：列出当前启用的类型，并把每个类型的**全部硬约束**直接写进提示。
 *
 * 为什么不做成"按需查询"：硬约束如果只存在于工具返回值里，模型就有可能在没查的
 * 情况下动笔。放进提示里，约束才是真的绕不过去。
 *
 * @returns 写作类型段正文。
 */
export function typesSectionText() {
  const types = listTypes();
  if (types.length === 0) {
    return [
      '# 写作类型',
      '',
      '当前没有启用任何写作类型插件。开始写正文前必须先向用户确认写作类型与要求，',
      '并提示用户可以启用相应的写作类型插件。',
    ].join('\n');
  }

  const lines = [
    '# 写作类型与专属硬约束',
    '',
    '当前启用以下写作类型。写任何正文之前，必须先确定使用哪一种，并把该类型的',
    '「生成前必须确认」要素与用户确认完毕。下列约束与该类型同属硬约束。',
    '',
  ];

  for (const type of types) {
    const format = type.format ?? { kind: 'markdown' };
    lines.push(`## ${type.label}（id: \`${type.id}\`）`);
    if (typeof type.summary === 'string' && type.summary !== '') lines.push(type.summary);
    lines.push(
      '',
      `默认格式：${
        format.kind === 'docx'
          ? `DOCX（规格 ${format.spec ?? '未命名'}）—— 字体、字号、行距必须由格式工具真实写入并回读校验`
          : 'Markdown'
      }`,
    );
    if (Array.isArray(type.mustConfirm) && type.mustConfirm.length > 0) {
      lines.push('', `生成前必须确认：${type.mustConfirm.join('、')}`);
    }
    if (Array.isArray(type.constraints) && type.constraints.length > 0) {
      lines.push('', '硬约束：');
      for (const [index, item] of type.constraints.entries()) lines.push(`${index + 1}. ${item}`);
    }
    lines.push('', '完整结构骨架与交付前自检清单用 `writing_type_list` 读取。', '');
  }

  lines.push(
    '---',
    '',
    '选定类型后用 `writing_type_set` 记到文档上，再按对应约束动笔。',
    '正文一律通过 `writing_canvas_write` 写入写作画布，不要只写在对话里。',
  );

  return lines.join('\n');
}

/**
 * 渲染强指令约束段的正文。
 * @returns 交给 ctx.systemPrompt.section 的约束文本。
 */
export function constraintsText() {
  return [
    '# 写作工作台的硬约束',
    '',
    '你在本工作区中承担写作任务时，必须遵守以下约束。这些是硬约束，不是偏好：',
    '与用户明确要求冲突时以用户要求为准，但你必须先指出冲突。',
    '',
    '## 一、产物归属',
    '1. 正文的唯一权威副本是写作工作台的文档存储。禁止把成品正文只写在对话里当作交付。',
    '2. 你在对话中输出正文片段时，必须标明它是"预览"，并说明它尚未写入文档。',
    '3. 未经用户确认，不得把预览内容写入文档存储覆盖既有正文。',
    '',
    '## 二、先确认后生成',
    '4. 生成正文前，必须已确认：写作类型、写作目标、目标读者、篇幅要求、格式规格。',
    '5. 任一未确认，你必须先提问澄清，而不是先写后问。每轮澄清最多 3 个问题，且不得重复询问已知信息。',
    '6. 你提出的建议值必须显式标注为"建议值"。未经用户确认的建议不构成写作要求。',
    '',
    '## 三、不得擅自改动用户文本',
    '7. 用户的编辑是最高优先级。禁止在没有明确指令的情况下改写、删除或"顺手优化"用户写下的任何句子。',
    '8. 修订必须具体到位置，并说明改动理由。用户未确认的批注不改变正文。',
    '9. 发生冲突（你的改动与用户手改重叠）时，必须停下来询问以哪一方为准，禁止静默覆盖。',
    '',
    '## 四、格式规格必须真实落地',
    '10. 默认使用 Markdown。仅当文种有指定的字体、字号、行间距要求时才使用 DOCX。',
    '11. 使用 DOCX 时，字体/字号/行距等规格必须由工具写入文件并对产物回读校验。',
    '    禁止仅在回复里声称"已按要求设置格式"。校验不通过时必须报告失败，不得假装成功。',
    '',
    '## 五、历史与可追溯',
    '12. 每次写入都产生新的不可变版本。禁止原地覆盖历史版本。',
    '13. 引用外部材料时，必须在正文中标注来源，不得把来源内容当作你自己的原创表述。',
    '',
    '## 六、诚实性',
    '14. 不得虚构事实、数据、引文或来源。信息不足时明确说明不足，并给出获取途径。',
    '15. 任何一步失败（工具报错、校验不通过、超时）都必须如实报告，禁止用"已完成"掩盖失败。',
  ].join('\n');
}
