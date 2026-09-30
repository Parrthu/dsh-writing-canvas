/**
 * 客户端半体的纯逻辑测试。
 *
 * 客户端 bundle 是「宿主直接提供、无构建」的单文件，里面的纯函数无法被 import。
 * 因此测试用最小桩件执行一次工厂函数，取出 __internals 再做断言——
 * 这比复制一份实现来测更有意义：测的就是真正上线的那段代码。
 *
 * 运行：node --test test/client.test.mjs
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import test from 'node:test';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLIENT_PATH = join(HERE, '..', 'client', 'client.js');

/** 极简 React 桩：工厂执行期间不会真正渲染，只需要一个可 require 的对象。 */
const reactStub = { createElement: () => null, useState: () => [null, () => {}], useEffect: () => {}, useRef: () => ({}) };

/** 加载客户端 bundle，取出工厂返回的导出。 */
async function loadClientExports() {
  const source = await readFile(CLIENT_PATH, 'utf8');
  let captured = null;
  const fakeWindow = {
    __ModuleLoader__: {
      load(spec) {
        captured = spec;
      },
    },
  };
  const fakeDocument = { querySelector: () => null, createElement: () => ({ dataset: {}, style: {} }), head: { appendChild() {} } };
  const fn = new Function('window', 'document', 'localStorage', 'fetch', 'EventSource', 'console', source);
  fn(fakeWindow, fakeDocument, { getItem: () => null, setItem() {} }, () => Promise.reject(new Error('no net')), function () {}, console);
  assert.ok(captured !== null, 'bundle 必须调用 window.__ModuleLoader__.load');
  assert.equal(captured.id, 'dsh-writing-canvas');
  return captured.factory((name) => {
    if (name === 'react') return reactStub;
    throw new Error(`测试桩未提供模块：${name}`);
  });
}

const client = await loadClientExports();
const { transformSelection, buildHighlightSegments, formatKeys, modifiersOf } = client.__internals;

test('客户端 bundle 以宿主契约的形态导出', () => {
  assert.equal(typeof client.apply, 'function');
  assert.deepEqual(client.inject, ['slots', 'sidebarRightTabs']);
});

test('行内格式：给选区加标记并把光标落在内容上', () => {
  const value = '今天天气很好';
  const result = transformSelection(value, 0, 2, 'bold');
  assert.equal(result.value, '**今天**天气很好');
  assert.equal(result.value.slice(result.start, result.end), '今天');
});

test('行内格式：再次应用同一格式即取消（可逆）', () => {
  const once = transformSelection('今天天气很好', 0, 2, 'bold');
  const twice = transformSelection(once.value, once.start - 2, once.end + 2, 'bold');
  assert.equal(twice.value, '今天天气很好');
});

test('行内格式：未选中文字时插入占位并选中它', () => {
  const result = transformSelection('', 0, 0, 'italic');
  assert.equal(result.value, '*文字*');
  assert.equal(result.value.slice(result.start, result.end), '文字');
});

test('块级格式：给选中的多行统一加前缀', () => {
  const value = '第一行\n第二行\n第三行';
  const result = transformSelection(value, 0, value.length, 'ul');
  assert.equal(result.value, '- 第一行\n- 第二行\n- 第三行');
});

test('块级格式：整块已有前缀时再点一次即去掉', () => {
  const value = '- 第一行\n- 第二行';
  const result = transformSelection(value, 0, value.length, 'ul');
  assert.equal(result.value, '第一行\n第二行');
});

test('块级格式：只影响选区覆盖到的行，不碰其他行', () => {
  const value = '标题行\n正文一\n正文二\n结尾行';
  const start = value.indexOf('正文一');
  const end = value.indexOf('\n结尾行');
  const result = transformSelection(value, start, end, 'quote');
  assert.equal(result.value, '标题行\n> 正文一\n> 正文二\n结尾行');
});

test('标题切换：H1 换 H2 时不会叠加成 ## #', () => {
  const h1 = transformSelection('标题', 0, 2, 'h1');
  assert.equal(h1.value, '# 标题');
  const h2 = transformSelection(h1.value, 0, h1.value.length, 'h2');
  assert.equal(h2.value, '## 标题');
});

test('代码块与分隔线插入到选区位置', () => {
  const code = transformSelection('abc', 3, 3, 'codeblock');
  assert.ok(code.value.startsWith('abc\n```'));
  const hr = transformSelection('abc', 3, 3, 'hr');
  assert.equal(hr.value, 'abc\n---\n');
});

test('链接：选中文字变成链接文字，光标落在 url 上', () => {
  const result = transformSelection('看这里', 0, 3, 'link');
  assert.equal(result.value, '[看这里](url)');
  assert.equal(result.value.slice(result.start, result.end), 'url');
});

test('未知格式不改变任何东西', () => {
  const result = transformSelection('原文', 0, 2, 'nope');
  assert.equal(result.value, '原文');
});

test('高亮分段：把批注区间切成 文本/标记 交替的片段', () => {
  const content = '前面被批注后面';
  const segments = buildHighlightSegments(content, [
    { range: { start: 2, end: 5 }, status: 'open', kind: 'rewrite', anchorLost: false },
  ]);
  assert.deepEqual(
    segments.map((s) => [s.text, s.mark === true]),
    [
      ['前面', false],
      ['被批注', true],
      ['后面', false],
    ],
  );
});

test('高亮分段：anchorLost 的批注不参与高亮（不指错位置）', () => {
  const segments = buildHighlightSegments('正文', [
    { range: { start: 0, end: 2 }, status: 'open', kind: 'comment', anchorLost: true },
  ]);
  assert.equal(segments.length, 1);
  assert.equal(segments[0].mark, false);
});

test('高亮分段：区间越界会被夹到正文长度内，不会抛错', () => {
  const segments = buildHighlightSegments('短', [
    { range: { start: 0, end: 999 }, status: 'open', kind: 'comment', anchorLost: false },
  ]);
  assert.equal(segments.length, 1);
  assert.equal(segments[0].text, '短');
  assert.equal(segments[0].mark, true);
});

test('高亮分段：多条批注按位置排序输出', () => {
  const content = 'AABBCC';
  const segments = buildHighlightSegments(content, [
    { range: { start: 4, end: 6 }, status: 'open', kind: 'comment', anchorLost: false },
    { range: { start: 0, end: 2 }, status: 'open', kind: 'comment', anchorLost: false },
  ]);
  assert.deepEqual(
    segments.map((s) => s.text),
    ['AA', 'BB', 'CC'],
  );
});

test('键位与修饰键的转换', () => {
  assert.equal(formatKeys([]), '未绑定');
  assert.equal(formatKeys(['⌘', 'W']), '[⌘] [W]');
  assert.deepEqual(modifiersOf({ ctrlKey: true, altKey: false, shiftKey: true, metaKey: true }), [
    'control',
    'shift',
    'meta',
  ]);
});
