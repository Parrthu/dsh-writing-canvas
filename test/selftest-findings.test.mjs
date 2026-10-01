/**
 * 全功能自测发现的两个问题（2026-10-01）。
 *
 * 这两处都不是崩溃，而是「能力悄悄缺了一块」——最容易被漏掉的那类：
 * 工具与 HTTP 接口给出不一致的结果，AI 因此看不到本来存在的选项。
 *
 * 运行：node --test test/selftest-findings.test.mjs
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import test from 'node:test';

const HERE = dirname(fileURLToPath(import.meta.url));
const TOOLS = await readFile(join(HERE, '..', 'src', 'tools.js'), 'utf8');
const ROUTES = await readFile(join(HERE, '..', 'src', 'routes.js'), 'utf8');
const INDEX = await readFile(join(HERE, '..', 'src', 'index.js'), 'utf8');

test('回归：格式集列表工具必须包含内置 DOCX 版式', () => {
  // 工具的说明写着「分 markdown 与 docx 两种载体」，早先却只列了 markdown，
  // 于是 AI 不知道「党政机关公文」「工作报告」这些版式存在，
  // 与 /format-sets 接口（两者都给）也对不上。
  const idx = TOOLS.indexOf("name: 'writing_format_set_list'");
  assert.ok(idx > 0, '工具要存在');
  const body = TOOLS.slice(idx, idx + 2000);
  assert.match(body, /listFormatSpecs\(\)/, '要合并内置的 DOCX 版式规格');
  assert.match(body, /builtinDocx/, '要有明确的 DOCX 分支');
  // 顺序要看**合并数组里**的排列：builtinDocx 的定义在数组之前，
  // 直接在整个函数体里比 indexOf 会比到定义处，得出错误结论。
  const allAt = body.indexOf('const all = [');
  assert.ok(allAt > 0, '要有合并三类来源的数组');
  const allBody = body.slice(allAt, allAt + 420);
  assert.ok(allBody.indexOf('BUILTIN_MARKDOWN_SETS') < allBody.indexOf('builtinDocx'), 'markdown 在前');
  assert.ok(allBody.indexOf('builtinDocx') < allBody.indexOf('userSets'), 'docx 居中，用户自定义在后');
});

test('回归：导出工具必须让用户能选保存位置', () => {
  // 用户明确抱怨过「不能每次都保存到默认路径」；界面上修了，
  // 但 AI 走的工具路径当时仍然默默写进 exports/——同一件事两种待遇。
  const idx = TOOLS.indexOf("name: 'writing_canvas_export'");
  assert.ok(idx > 0);
  const body = TOOLS.slice(idx, idx + 3000);
  assert.match(body, /directory: \{/, '要能显式指定目录');
  // 必须断言**分支条件本身**：只查 pickDirectory() 这个字符串，
  // 把条件改成 `else if (false)` 也照样通过（这一点已被实验打脸）。
  assert.match(
    body,
    /\} else if \(typeof pickDirectory === 'function'\) \{/,
    '要走选择器分支，而不是写了不执行',
  );
  assert.match(body, /await pickDirectory\(\)/, '没指定时要真的拉起选择框');
  assert.match(body, /cancelled: true/, '用户取消要如实返回，不生成文件');
  assert.match(body, /usedDefaultDir/, '要汇报位置是怎么定的');
  assert.match(body, /outDir,/, '选定的目录要真的传给导出');
});

test('回归：导出工具的选择器依赖要由宿主注入', () => {
  assert.match(INDEX, /registerWritingTools\(\{[\s\S]{0,400}?pickDirectory,/, '宿主要把 pickDirectory 传进工具层');
  assert.match(TOOLS, /\n  pickDirectory,\n\}\) \{/, '工厂要接收它');
});

test('回归：界面导出与工具导出的行为必须一致', () => {
  // 两条路径都要：默认让用户选；没有选择器时退回工作区目录并如实标注。
  assert.match(ROUTES, /chooseDir === true/, 'HTTP 路径要支持选目录');
  assert.match(ROUTES, /pickerUnavailable = true/, 'HTTP 路径要标注不可用');
  const idx = TOOLS.indexOf("name: 'writing_canvas_export'");
  const body = TOOLS.slice(idx, idx + 3000);
  assert.match(body, /pickerUnavailable/, '工具路径同样要标注不可用');
});
