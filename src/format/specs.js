/**
 * 格式规格预设。
 *
 * 设计分工（用户定的方向）：
 *   - 画布只管**内容**，正文一律是 Markdown 纯文本，不做富文本编辑
 *   - 需要指定字体/字号/行距的文种，由「格式引擎」一键套用预设规格生成 DOCX
 *
 * 规格里的 `target` 是**生成后回读时要断言的期望值**：格式引擎会把 DOCX 重新打开，
 * 逐项核对，不一致就报告失败，而不是声称成功。
 *
 * 关于字体可用性（必须诚实说明）：规格只负责把字体**名称**写进 DOCX。
 * 字体本身要由查看文档的机器提供；缺失时 Word/WPS 会自行替换字形。
 * 因此回读校验核对的是「名称与字号/行距是否按规格写入」，渲染效果取决于机器字体。
 *
 * @module dsh-writing-canvas/format/specs
 */

/** 字号换算：中文号数 → 磅值。 */
export const CHINESE_FONT_SIZES = {
  初号: 42,
  小初: 36,
  一号: 26,
  小一: 24,
  二号: 22,
  小二: 18,
  三号: 16,
  小三: 15,
  四号: 14,
  小四: 12,
  五号: 10.5,
  小五: 9,
};

/**
 * 党政机关公文格式（依据 GB/T 9704-2012 的常用参数）。
 */
const GONGWEN_GB9704 = {
  label: '党政机关公文（GB/T 9704-2012 版式）',
  kind: 'docx',
  page: {
    widthMm: 210,
    heightMm: 297,
    marginTopMm: 37,
    marginBottomMm: 35,
    marginLeftMm: 28,
    marginRightMm: 26,
  },
  title: {
    fontEastAsia: '方正小标宋简体',
    fontAscii: 'Times New Roman',
    sizePt: 22,
    align: 'center',
    spaceBeforePt: 0,
    spaceAfterPt: 0,
    lineSpacingPt: 30,
    lineRule: 'exact',
  },
  body: {
    fontEastAsia: '仿宋_GB2312',
    fontAscii: 'Times New Roman',
    sizePt: 16,
    lineSpacingPt: 28,
    lineRule: 'exact',
    firstLineIndentChars: 2,
    spaceBeforePt: 0,
    spaceAfterPt: 0,
    align: 'justify',
  },
  heading1: { fontEastAsia: '黑体', fontAscii: 'Times New Roman', sizePt: 16, firstLineIndentChars: 2 },
  heading2: { fontEastAsia: '楷体_GB2312', fontAscii: 'Times New Roman', sizePt: 16, firstLineIndentChars: 2 },
  heading3: { fontEastAsia: '仿宋_GB2312', fontAscii: 'Times New Roman', sizePt: 16, bold: true, firstLineIndentChars: 2 },
  quote: { fontEastAsia: '楷体_GB2312', fontAscii: 'Times New Roman', sizePt: 16, firstLineIndentChars: 2 },
  pageNumber: { fontEastAsia: '宋体', fontAscii: 'Times New Roman', sizePt: 14, dash: true },
};

/** 通用中文文档：正文小四宋体，1.5 倍行距。 */
const PLAIN_DOCX = {
  label: '通用中文文档（小四宋体 · 1.5 倍行距）',
  kind: 'docx',
  page: { widthMm: 210, heightMm: 297, marginTopMm: 25.4, marginBottomMm: 25.4, marginLeftMm: 31.8, marginRightMm: 31.8 },
  title: {
    fontEastAsia: '黑体',
    fontAscii: 'Times New Roman',
    sizePt: 18,
    align: 'center',
    spaceAfterPt: 12,
    lineSpacingPt: 0,
    lineRule: 'auto',
  },
  body: {
    fontEastAsia: '宋体',
    fontAscii: 'Times New Roman',
    sizePt: 12,
    lineSpacingPt: 0,
    lineRule: 'auto',
    lineSpacingMultiple: 1.5,
    firstLineIndentChars: 2,
    align: 'justify',
  },
  heading1: { fontEastAsia: '黑体', fontAscii: 'Times New Roman', sizePt: 15, firstLineIndentChars: 0 },
  heading2: { fontEastAsia: '黑体', fontAscii: 'Times New Roman', sizePt: 13.5, firstLineIndentChars: 0 },
  heading3: { fontEastAsia: '宋体', fontAscii: 'Times New Roman', sizePt: 12, bold: true, firstLineIndentChars: 0 },
  quote: { fontEastAsia: '楷体', fontAscii: 'Times New Roman', sizePt: 12, firstLineIndentChars: 2 },
  pageNumber: { fontEastAsia: '宋体', fontAscii: 'Times New Roman', sizePt: 10.5, dash: false },
};

/** 工作报告：正文小四仿宋，固定行距 26pt。 */
const REPORT_DOCX = {
  label: '工作报告（小四仿宋 · 固定行距 26pt）',
  kind: 'docx',
  page: { widthMm: 210, heightMm: 297, marginTopMm: 30, marginBottomMm: 30, marginLeftMm: 28, marginRightMm: 26 },
  title: {
    fontEastAsia: '方正小标宋简体',
    fontAscii: 'Times New Roman',
    sizePt: 20,
    align: 'center',
    spaceAfterPt: 14,
    lineSpacingPt: 30,
    lineRule: 'exact',
  },
  body: {
    fontEastAsia: '仿宋_GB2312',
    fontAscii: 'Times New Roman',
    sizePt: 12,
    lineSpacingPt: 26,
    lineRule: 'exact',
    firstLineIndentChars: 2,
    align: 'justify',
  },
  heading1: { fontEastAsia: '黑体', fontAscii: 'Times New Roman', sizePt: 12, firstLineIndentChars: 2 },
  heading2: { fontEastAsia: '楷体_GB2312', fontAscii: 'Times New Roman', sizePt: 12, firstLineIndentChars: 2 },
  heading3: { fontEastAsia: '仿宋_GB2312', fontAscii: 'Times New Roman', sizePt: 12, bold: true, firstLineIndentChars: 2 },
  quote: { fontEastAsia: '楷体_GB2312', fontAscii: 'Times New Roman', sizePt: 12, firstLineIndentChars: 2 },
  pageNumber: { fontEastAsia: '宋体', fontAscii: 'Times New Roman', sizePt: 14, dash: true },
};

/** 全部可用的 DOCX 规格。 */
export const FORMAT_SPECS = {
  'gongwen-gb9704': GONGWEN_GB9704,
  'plain-docx': PLAIN_DOCX,
  'report-docx': REPORT_DOCX,
};

/**
 * 取规格；未指定时给一个合理的默认。
 * @param id - 规格 id。
 * @returns { id, spec } 或 null。
 */
export function getFormatSpec(id) {
  if (typeof id !== 'string' || id === '') return null;
  const spec = FORMAT_SPECS[id];
  return spec === undefined ? null : { id, spec };
}

/** 列出全部规格（供界面下拉使用）。 */
export function listFormatSpecs() {
  return Object.entries(FORMAT_SPECS).map(([id, spec]) => ({
    id,
    label: spec.label,
    kind: spec.kind,
    body: {
      fontEastAsia: spec.body.fontEastAsia,
      sizePt: spec.body.sizePt,
      sizeName: Object.entries(CHINESE_FONT_SIZES).find(([, pt]) => pt === spec.body.sizePt)?.[0] ?? null,
      lineSpacingPt: spec.body.lineSpacingPt,
      lineRule: spec.body.lineRule,
      lineSpacingMultiple: spec.body.lineSpacingMultiple ?? null,
    },
  }));
}
