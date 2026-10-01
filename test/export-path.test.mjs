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
const INDEX_SOURCE = await readFile(join(HERE, '..', 'src', 'index.js'), 'utf8');

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
  assert.ok(CLIENT_SOURCE.indexOf('chooseDir: true') > 0);
  assert.match(ROUTES_SOURCE, /typeof pickDirectory === 'function' \?/, '接口层要判空');
  assert.match(ROUTES_SOURCE, /pickerUnavailable = true/, '拿不到服务要如实标注');
});

// ---- 2026-10-01 实测：导出没弹系统选择框，查出两个叠在一起的 bug --------------

test('回归：必须从 capability() 取 pick，不能在服务实例上找 pick', () => {
  // native 后端把 pick 挂在 capability 对象上（service.capability().pick），
  // 服务实例本身没有 pick —— 判断 service.pick 永远是 undefined，
  // 结果是每次都静默退化成「没有选择器」，用户什么都看不到。
  // 只断言「用了 capability」，不写死比较方向——代码里是 `!== 'function'` 的判空写法，
  // 断言 `=== 'function'` 会误报（这一点已被测试打脸一次）。
  assert.match(INDEX_SOURCE, /service\.capability/, '要通过 capability() 取能力');
  assert.match(INDEX_SOURCE, /capability\.pick\(/, 'pick 要从 capability 上取');
  assert.ok(
    !/typeof service\.pick === 'function'/.test(INDEX_SOURCE),
    '不得再判断 service.pick——那是永远为假的路径',
  );
});

test('回归：pick 必须收到 signal（不传会在用户取消时抛 TypeError）', () => {
  // native 实现在取消分支里读 signal.aborted，macOS 走 osascript 时同样把 signal 交给 runner。
  assert.match(INDEX_SOURCE, /capability\.pick\(signal/, '要把 signal 传进去');
  assert.match(INDEX_SOURCE, /new AbortController\(\)\.signal/, '没有外部 signal 时要有兜底');
});

test('回归：只有 native 形态才开系统对话框，其他形态按官方建议隐藏入口', () => {
  assert.match(INDEX_SOURCE, /capability\.kind !== 'native'/, '要按 kind 分支');
  // browse 是给远程客户端的应用内浏览，本插件没实现那套 UI，应退默认目录而非失败。
  assert.match(INDEX_SOURCE, /return undefined/, '非 native 形态退默认目录');
});

test('回归：请求断开要能终止系统对话框，不能留悬空框', () => {
  // 实测：只监听 req 时，客户端超时断开没能可靠触发，对话框留在屏幕上没人应答。
  assert.match(ROUTES_SOURCE, /req\.on\('close', onClose\)/, '要监听 req');
  assert.match(ROUTES_SOURCE, /res\.on\('close', onClose\)/, '也要监听 res');
  assert.match(ROUTES_SOURCE, /controller\.abort\(\)/, '断开要 abort');
  assert.match(ROUTES_SOURCE, /controller\.signal\.aborted/, '中断后不要再往下导出');
});

test('回归：服务就绪判定要看 capability，不能只看服务对象存在', () => {
  // 我第一版诊断只检查「包装函数是否存在」，那永远为真，于是误报 available。
  assert.match(INDEX_SOURCE, /service-unavailable/, '拿不到要报 unavailable');
  assert.match(INDEX_SOURCE, /native-ready/, 'native 就绪才报 ready');
  assert.match(INDEX_SOURCE, /unsupported:/, '非 native 形态要如实说明');
});

test('docx.js 导出纯路径函数，便于直接测试', () => {
  assert.match(DOCX_SOURCE, /export function resolveExportPath/, '必须是可导入的纯函数');
});
