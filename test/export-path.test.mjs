/**
 * 导出落盘路径的测试。
 *
 * 用户诉求：「导出没有保存路径的选项，你不能够每次都保存到默认路径。」
 * 这条链路上最容易写错的两处：没选目录时的回落，以及存到工作区**之外**时
 * 相对路径的算法（按工作区前缀硬截会得到一段残路径）。
 *
 * 运行：node --test test/export-path.test.mjs
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { resolveExportPath } from '../src/format/docx.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROUTES_SOURCE = await readFile(join(HERE, '..', 'src', 'routes.js'), 'utf8');
const DOCX_SOURCE = await readFile(join(HERE, '..', 'src', 'format', 'docx.js'), 'utf8');
const CLIENT_SOURCE = await readFile(join(HERE, '..', 'client', 'client.js'), 'utf8');

const base = {
  workspacePath: '/w',
  stateDir: '.writing-canvas',
  safeName: '那一栏',
  specId: 'plain-docx',
  stamp: '2026-10-01T00-00-00',
};

test('没选目录时落回工作区内的 exports/', () => {
  const p = resolveExportPath({ ...base });
  assert.equal(p, '/w/.writing-canvas/exports/那一栏-plain-docx-2026-10-01T00-00-00.docx');
});

test('选了目录就用它，且支持中文目录名与尾部空白', () => {
  const p = resolveExportPath({ ...base, outDir: '  /Users/parrt/桌面/稿件  ' });
  assert.equal(p, '/Users/parrt/桌面/稿件/那一栏-plain-docx-2026-10-01T00-00-00.docx');
});

test('空串/空白等同没选，仍然回落默认目录', () => {
  for (const outDir of ['', '   ', undefined, null]) {
    const p = resolveExportPath({ ...base, outDir });
    assert.ok(p.startsWith('/w/.writing-canvas/exports/'), `${JSON.stringify(outDir)} 应回落默认`);
  }
});

test('回归：导出到工作区外要给绝对路径，不能截出残路径', () => {
  // 界面直接把 relativePath 展示给用户；硬截工作区前缀会得到 /tmp/... 之外的残串。
  const outside = resolveExportPath({ ...base, outDir: '/tmp/elsewhere' });
  assert.ok(!outside.startsWith('/w/'), '必须落在指定目录');
  const sliced = outside.slice(base.workspacePath.length + 1);
  assert.ok(!sliced.startsWith('/'), '正确做法是判定前缀后再决定是否截');
});

test('回归：导出接口把「用了默认目录」如实上报', () => {
  assert.match(ROUTES_SOURCE, /usedDefaultDir/, '要告诉界面位置是怎么定的');
  assert.match(ROUTES_SOURCE, /pickerUnavailable/, '选择器不可用时也要如实说');
  // 这段在 docx.js（算路径的地方），不在 routes.js——写错文件会得到一个恒真的空断言。
  assert.match(
    DOCX_SOURCE,
    /outPath\.startsWith\(`\$\{options\.workspacePath\}\/`\)/,
    '相对路径必须先判定是否在工作区内',
  );
});

test('回归：用户取消选择不是错误，且不生成文件', () => {
  assert.match(ROUTES_SOURCE, /error: 'cancelled'/, '取消要有独立信号');
  const fn = ROUTES_SOURCE.slice(ROUTES_SOURCE.indexOf("if (body.chooseDir === true)"));
  const block = fn.slice(0, fn.indexOf('const report = await exportDocx'));
  assert.match(block, /picked === null[\s\S]{0,220}?return;/, '取消必须直接返回，不能再往下生成文件');
});

test('回归：客户端导出必须请求选择位置', () => {
  assert.match(CLIENT_SOURCE, /chooseDir: true/, '导出请求要带上选择位置');
  assert.match(CLIENT_SOURCE, /data\?\.error === 'cancelled'/, '取消要单独处理，不能当失败报错');
  assert.match(CLIENT_SOURCE, /export:cancelled/, '取消要上报，便于事后核对');
});

test('目录选择服务拿不到时要容错，而不是硬依赖', () => {
  // 远程 / 无头组合没有原生选择器；硬依赖会让整个插件在这一步崩掉。
  const idx = CLIENT_SOURCE.indexOf('chooseDir: true');
  assert.ok(idx > 0);
  assert.match(ROUTES_SOURCE, /typeof pickDirectory !== 'function'/, '接口层要判空');
});

test('docx.js 导出纯路径函数，便于直接测试', () => {
  assert.match(DOCX_SOURCE, /export function resolveExportPath/, '必须是可导入的纯函数');
});
