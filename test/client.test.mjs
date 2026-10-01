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
const {
  transformSelection,
  buildHighlightSegments,
  formatKeys,
  modifiersOf,
  readAgentPresetId,
  clampFloatPosition,
  markdownInlineSegments,
  markdownSegmentsToText,
  computeFenceLines,
} = client.__internals;

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
    segments.map((s) => [s.text, s.mark === false ? false : s.mark]),
    [
      ['前面', false],
      ['被批注', 'note'],
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
  assert.equal(segments[0].mark, 'note');
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

test('高亮分段：待决定的建议标成 suggestion，不接受已决定的建议', () => {
  const content = '前面要改的地方后面';
  const segments = buildHighlightSegments(
    content,
    [],
    [
      { range: { start: 2, end: 7 }, status: 'pending', anchorLost: false, proposed: '改后的说法' },
      { range: { start: 0, end: 2 }, status: 'accepted', anchorLost: false, proposed: 'x' },
    ],
  );
  // 已接受的那条不再标记
  assert.deepEqual(
    segments.map((s) => [s.text, s.mark === false ? false : s.mark]),
    [
      ['前面', false],
      ['要改的地方', 'suggestion'],
      ['后面', false],
    ],
  );
});

test('高亮分段：建议不改变文本长度（高亮层必须与输入框逐字对齐）', () => {
  const content = '原文内容';
  const segments = buildHighlightSegments(
    content,
    [],
    [{ range: { start: 0, end: 2 }, status: 'pending', anchorLost: false, proposed: '一段长得多得多的替换文字' }],
  );
  const joined = segments.map((s) => s.text).join('');
  assert.equal(joined, content, '拼接结果必须与正文完全一致，否则高亮层会错位');
});

test('版本对比：相同文本没有增删行', () => {
  const { diffLines } = client.__internals;
  const lines = diffLines('甲\n乙\n丙', '甲\n乙\n丙');
  assert.deepEqual(lines.map((l) => l.type), ['same', 'same', 'same']);
});

test('版本对比：能识别新增、删除与改动行', () => {
  const { diffLines } = client.__internals;
  const lines = diffLines('甲\n乙\n丙', '甲\n乙改了\n丙\n丁');
  const added = lines.filter((l) => l.type === 'add').map((l) => l.text);
  const removed = lines.filter((l) => l.type === 'del').map((l) => l.text);
  assert.ok(added.includes('丁'), '新增行应被识别');
  assert.ok(added.includes('乙改了') || removed.includes('乙'), '改动应体现为增或删');
  assert.deepEqual(
    lines.filter((l) => l.type === 'same').map((l) => l.text),
    ['甲', '丙'],
  );
});

test('版本对比：空文本与单行文本不会崩', () => {
  const { diffLines } = client.__internals;
  assert.deepEqual(diffLines('', '甲').map((l) => l.type), ['del', 'add']);
  assert.equal(diffLines('甲', '甲').length, 1);
});

test('版本对比：超长文本退化为整体替换而不卡住', () => {
  const { diffLines } = client.__internals;
  const big = Array.from({ length: 700 }, (_, i) => `行${i}`).join('\n');
  const other = Array.from({ length: 700 }, (_, i) => `别${i}`).join('\n');
  const lines = diffLines(big, other);
  assert.equal(lines.length, 1400, '应为全删 + 全增');
});

// ---- 回归测试：右栏画布拿不到会话 id（2026-09-30「画布空白」事故）----------
//
// 右栏槽位的组件**拿不到任何 props**（宿主是 renderSlot(seat, {}, { hookContext})），
// 会话身份只能靠 register 的 `inject(sessionId)` 注入。漏掉 inject 时
// CanvasTabBody 的 props.sessionId 恒为 undefined，画布会去读
// docIdOfSession(undefined) = "default" 那份空文档，表现就是「永远空白、永远新文档」，
// 而同一份正文在磁盘上明明存在。官方 sidebar-terminal 同样依赖 inject
// （dsh-client-ui-renderer 的 runInject：args.push(binding.key)，返回值展开为 props）。
//
// 这里直接对 bundle 源码做断言：apply() 需要完整的 Cordis 宿主，桩件跑不完整条链路，
// 与其造一个假的宿主，不如把「注册形态」这条契约钉死在源码上。

const CLIENT_SOURCE = await readFile(CLIENT_PATH, 'utf8');
const PATCH_SOURCE = await readFile(join(HERE, '..', 'cordis.patch.yml'), 'utf8');
const PRESET_PATCH_SOURCE = await readFile(join(HERE, '..', 'presets', 'writing.patch.yml'), 'utf8');

test('回归：右栏标签页注册必须声明 inject(sessionId)', () => {
  const paneRegistration = CLIENT_SOURCE.match(
    /name:\s*'sidebar\.right\.pane\.tab',[\s\S]{0,400}?inject:\s*\(sessionId\)\s*=>\s*\(\{\s*sessionId\s*\}\)/,
  );
  assert.ok(
    paneRegistration !== null,
    "sidebar.right.pane.tab 的注册里必须带 inject: (sessionId) => ({ sessionId })",
  );
});

test('回归：右侧画布 body 从注入里读会话 id，而不是指望 props 里自带', () => {
  const body = CLIENT_SOURCE.match(/function CanvasTabBody\(props\)\s*\{[\s\S]{0,300}?\}/);
  assert.ok(body !== null, 'CanvasTabBody 必须存在');
  assert.match(body[0], /props\?\.sessionId/, 'CanvasTabBody 必须从 props.sessionId 取会话 id（该 props 由 inject 提供）');
  assert.match(body[0], /target:\s*\{\s*sessionId\s*\}/, '必须把 sessionId 作为画布 target');
});

test('回归：只有写作模式才自动调出画布，其他模式一律不自动开', () => {
  // 事故复盘（被用户投诉两次）：
  //   1. 最初「只要会话在屏幕上就开」——每建一个任务都弹空画布。
  //   2. 后来改成「文档里有正文才恢复」——普通任务的会话照样弹。
  // 用户原话：「我只有在特定条件下触发之后才进入写作，不要直接就进入写作了」。
  // 现在的判据是会话的 agent preset 是不是 writing，所以把这条契约钉死。
  assert.match(
    CLIENT_SOURCE,
    /const WRITING_PRESET_ID = 'writing';/,
    '必须定义写作模式的 preset id，且与 cordis.patch.yml 里 preset-writing 的 config.id 一致',
  );
  assert.match(CLIENT_SOURCE, /readAgentPreset/, '必须去读会话的 agent preset');
  assert.match(
    CLIENT_SOURCE,
    /preset !== WRITING_PRESET_ID/,
    '非写作模式必须有明确的分支直接返回（不自动开）',
  );
  assert.match(
    CLIENT_SOURCE,
    /autoopen:skip[\s\S]{0,120}not-writing-mode/,
    '非写作模式要上报 skip 原因，便于事后核对走了哪条分支',
  );
});

test('回归：preset 判据必须先于 openTab，且取不到判据时不开（fail closed）', () => {
  const fn = CLIENT_SOURCE.slice(CLIENT_SOURCE.indexOf('function makeAutoOpen'));
  const gateAt = fn.indexOf('preset !== WRITING_PRESET_ID');
  const openAt = fn.indexOf('sidebarRight.openTab(');
  assert.ok(gateAt !== -1, 'makeAutoOpen 里必须有 preset 判定');
  assert.ok(openAt !== -1, 'makeAutoOpen 里必须有 openTab');
  assert.ok(gateAt < openAt, 'preset 判定必须在 openTab 之前，否则等于没判');

  // 取不到 preset 时要走 skip 而不是 openTab——宁可让用户手动开一次，
  // 也不要再出现「莫名其妙自己弹出来」。
  assert.match(
    fn,
    /agent-preset-unknown/,
    '读不到 preset 时必须放弃自动开启（fail closed）',
  );
});

test('回归：preset-writing 声明的 id 必须与客户端常量一致', () => {
  // 两边分处不同文件、不同语言半边，靠字符串对齐，必须机械校验而不是靠记忆。
  const patch = PRESET_PATCH_SOURCE;
  const idMatch = patch.match(/- id: preset-writing[\s\S]{0,200}?config:\s*\n\s*id: (\w+)/);
  assert.ok(idMatch !== null, 'patch 里必须声明 preset-writing 且带 config.id');
  const clientId = CLIENT_SOURCE.match(/const WRITING_PRESET_ID = '([^']+)';/);
  assert.ok(clientId !== null, '客户端必须有 WRITING_PRESET_ID');
  assert.equal(
    clientId[1],
    idMatch[1],
    `预设 id（${idMatch[1]}）与客户端 WRITING_PRESET_ID（${clientId[1]}）必须一致，否则画布永不自动打开`,
  );
});

// ---- preset 读取：决定「画布要不要自动出现」的那一步 --------------------------

test('preset 读取：从服务 list store 取到会话的 agentPreset', () => {
  const sessions = {
    list: {
      getSnapshot: () => ({
        byId: { 's-1': { projectionValues: { agentPreset: 'writing' } } },
      }),
    },
  };
  assert.equal(readAgentPresetId({ sessions, sessionId: 's-1' }), 'writing');
});

test('preset 读取：取不到会话时返回 undefined（调用方据此 fail closed）', () => {
  const sessions = { list: { getSnapshot: () => ({ byId: {} }) } };
  assert.equal(readAgentPresetId({ sessions, sessionId: 's-x' }), undefined);
  assert.equal(readAgentPresetId({ sessions, sessionId: '' }), undefined);
  assert.equal(readAgentPresetId({ sessions: undefined, sessionId: 's-1' }), undefined);
});

test('preset 读取：服务抛错不得把异常抛给调用方', () => {
  const sessions = {
    list: {
      getSnapshot() {
        throw new Error('store 未就绪');
      },
    },
  };
  assert.equal(readAgentPresetId({ sessions, sessionId: 's-1' }), undefined);
});

test('preset 读取：槽位 hook 注入优先于服务读取', () => {
  const useSessions = (selector) => selector({ byId: { 's-1': { projectionValues: { agentPreset: 'writing' } } } });
  const sessions = { list: { getSnapshot: () => ({ byId: { 's-1': { projectionValues: { agentPreset: 'standard' } } } }) } };
  assert.equal(readAgentPresetId({ sessions, useSessions, sessionId: 's-1' }), 'writing');
});

test('preset 读取：hook 抛错时退回到服务读取', () => {
  const useSessions = () => {
    throw new Error('在渲染期之外调用');
  };
  const sessions = { list: { getSnapshot: () => ({ byId: { 's-1': { projectionValues: { agentPreset: 'standard' } } } }) } };
  assert.equal(readAgentPresetId({ sessions, useSessions, sessionId: 's-1' }), 'standard');
});

test('preset 读取：空字符串不算有效 preset', () => {
  const sessions = { list: { getSnapshot: () => ({ byId: { 's-1': { projectionValues: { agentPreset: '' } } } }) } };
  assert.equal(readAgentPresetId({ sessions, sessionId: 's-1' }), undefined);
});

test('回归：自动开启只认 writing，其他 preset 一律不开', () => {
  // 把每种真实 preset 都过一遍，确保没有哪一种会误触发自动开启。
  for (const preset of ['standard', 'ptc', 'minimal', 'cordis']) {
    const sessions = { list: { getSnapshot: () => ({ byId: { 's-1': { projectionValues: { agentPreset: preset } } } }) } };
    const read = readAgentPresetId({ sessions, sessionId: 's-1' });
    assert.equal(read, preset);
    assert.notEqual(read, 'writing', `preset=${preset} 不得被当成写作模式`);
  }
});

// ---- 2026-10-01 界面重构：逐条钉住用户提出的问题 -----------------------------

test('回归：撰写中焦点必须跟随（文字长出来时自动滚到底）', () => {
  // 用户原话：「焦点始终在上方，用户不自己去动的话，他是不知道已经写完的」。
  assert.match(CLIENT_SOURCE, /followWritingTail/, '必须有焦点跟随的函数');
  assert.match(CLIENT_SOURCE, /scrollTop = el\.scrollHeight/, '要把编辑器拉到最底');
  // 逐字推进的每个 tick 都要跟，否则中间那几秒视野仍然停在上面。
  const reveal = CLIENT_SOURCE.slice(CLIENT_SOURCE.indexOf('const revealContent = React.useCallback'));
  const tick = reveal.slice(0, reveal.indexOf('}, 16)'));
  assert.match(tick, /followWritingTail\(\)/, '逐字推进的每个 tick 都必须跟一次');
});

test('回归：焦点跟随要同步高亮层，否则批注色块与文字错位', () => {
  // 同步逻辑在 scrollEditorToEnd 里（followWritingTail 调用它）。
  const fn = CLIENT_SOURCE.slice(CLIENT_SOURCE.indexOf('const scrollEditorToEnd'));
  const body = fn.slice(0, fn.indexOf('\n      };'));
  assert.match(body, /highlightRef\.current/, '要把高亮层也一起处理');
  assert.match(body, /layer\.scrollTop = el\.scrollTop/, '高亮层的滚动位置要跟编辑器一致');
});

test('回归：AI 选区动作不得使用 window.prompt（Electron 不支持，点了没反应）', () => {
  // 这是「改写/润色/扩写/批注四个按钮不可用」的真正原因。
  assert.ok(
    !/window\.prompt\s*\(/.test(CLIENT_SOURCE),
    '不得调用 window.prompt：Electron 会直接抛错，表现为按钮点了没反应',
  );
  assert.match(CLIENT_SOURCE, /submitAiAction/, '必须有内联提交路径');
  assert.match(CLIENT_SOURCE, /wcv-floatInput/, '浮动工具条要有内联输入框');
});

test('回归：AI 动作提交后落成带 anchor 的批注', () => {
  const fn = CLIENT_SOURCE.slice(CLIENT_SOURCE.indexOf('const submitAiAction'));
  const body = fn.slice(0, fn.indexOf('\n      };'));
  assert.match(body, /addAnnotation\(pending\.kind/, '提交要落到批注通道');
  assert.match(body, /pending\.range/, '批注要带选区位置');
});

test('回归：AI 输入态不得依赖实时 selection（否则输入框刚出现就被卸载）', () => {
  // 事故：点「改写」→ 输入框 autoFocus → textarea 失焦 → onBlur 清 selection
  // → 工具栏挂在 selection 上，连输入框一起被卸载；用户看到「点了没反应」。
  assert.match(CLIENT_SOURCE, /floatAnchor/, '浮动工具条要有独立锚点');
  assert.match(
    CLIENT_SOURCE,
    /const floatAnchor = aiAction !== null \? \{ top: aiAction\.top, left: aiAction\.left \} : selection/,
    'AI 动作进行中必须用它的选区快照定位，而不是实时 selection',
  );
  assert.match(
    CLIENT_SOURCE,
    /floatAnchor !== null\s*\n?\s*\? h\(/,
    '渲染条件必须看锚点，不能只看 selection',
  );
  // 选区快照要带上位置与文本。
  assert.match(CLIENT_SOURCE, /const beginAiAction = \(kind\) =>/, '进入输入态要经 beginAiAction');
  const begin = CLIENT_SOURCE.slice(CLIENT_SOURCE.indexOf('const beginAiAction'));
  const body = begin.slice(0, begin.indexOf('\n      };'));
  // 注意用词边界而不是 `${field}:`——代码里 kind 用的是简写属性 `kind,`，
  // 写死冒号会误判（这一点已被实验打脸过一次）。
  for (const field of ['kind', 'range', 'quote', 'top', 'left']) {
    assert.ok(new RegExp(`\\b${field}\\b`).test(body), `快照要带上 ${field}`);
  }
});

test('回归：AI 输入态不能阻止默认行为，否则输入框拿不到焦点', () => {
  // 工具栏容器上的 onMouseDown preventDefault 会阻止焦点转移，
  // 输入框摆在眼前却打不了字。
  assert.match(
    CLIENT_SOURCE,
    /onMouseDown: aiAction === null \? \(event\) => event\.preventDefault\(\) : undefined/,
    '只有非输入态才 preventDefault',
  );
});

test('回归：点回正文要取消 AI 输入态', () => {
  assert.match(
    CLIENT_SOURCE,
    /onFocus: \(\) => \{[\s\S]{0,160}?setAiAction\(null\)/,
    '点回编辑器应当收起输入框，而不是一直挂着',
  );
});

test('回归：新建议到达时自动展开面板（否则用户以为 Agent 没成功）', () => {
  // 事故：Agent 提交了 3 条建议且全部成功落盘，用户却说「并没有成功」——
  // 因为窄栏下建议面板默认收起，只有一个不起眼的「建议 3」标签。
  assert.match(CLIENT_SOURCE, /prevPendingRef/, '必须记录上一次的待决数量');
  assert.match(
    CLIENT_SOURCE,
    /pendingSuggestions > prevPendingRef\.current[\s\S]{0,120}?setPaneTab\('suggestions'\)/,
    '数量增加时必须自动展开到建议面板',
  );
});

test('回归：有待决项时抽屉标签要高亮', () => {
  assert.match(CLIENT_SOURCE, /'data-alert': pendingSuggestions > 0/, '建议标签要有 alert 态');
  assert.match(CLIENT_SOURCE, /'data-alert': openCount > 0/, '批注标签要有 alert 态');
});

test('回归：右栏不再有「写作画布」抬头与文档副标题', () => {
  // 多标签页形态里标签已经写着标题，画布内再顶一个同名抬头是重复且诡异的。
  const headerIdx = CLIENT_SOURCE.indexOf("className: 'wcv-header'");
  assert.ok(headerIdx !== -1, 'workbench 形态仍应保留 header');
  const headerBlock = CLIENT_SOURCE.slice(headerIdx - 400, headerIdx + 400);
  assert.match(
    headerBlock,
    /variant === 'pane'\s*\?\s*null/,
    'pane 形态必须整块跳过 header',
  );
  assert.ok(
    !CLIENT_SOURCE.includes("variant === 'pane' ? '写作画布' : '写作工作台'"),
    '不得再按形态渲染「写作画布」抬头',
  );
});

test('回归：写作类型与格式集合并进工具栏，不再各占一栏', () => {
  assert.match(CLIENT_SOURCE, /wcv-meta/, '类型/格式集要渲染成 chip 按钮');
  assert.match(CLIENT_SOURCE, /wcv-metaSelect/, 'chip 内要有覆盖其上的原生 select');
  // 旧的独立选择条：样式与渲染都不应再存在。
  assert.ok(
    !/className: 'wcv-typeBar'/.test(CLIENT_SOURCE),
    '不应再渲染独立的 wcv-typeBar',
  );
});

test('回归：底栏在窄栏下不渲染（原来那条文档/工作区/最近更新太臃肿）', () => {
  const idx = CLIENT_SOURCE.indexOf("className: 'wcv-foot'");
  assert.ok(idx !== -1, 'workbench 仍保留一条极简底栏');
  const block = CLIENT_SOURCE.slice(idx - 500, idx);
  assert.match(block, /variant === 'pane'\s*\?\s*null/, 'pane 必须跳过底栏');
  assert.ok(
    !CLIENT_SOURCE.includes("`文档 ${doc?.docId ?? '—'}`"),
    '不再把长 docId 直接铺在底栏上',
  );
});

test('回归：提示词面板是可编辑的，不是只读清单', () => {
  assert.match(CLIENT_SOURCE, /wcv-promptText/, '要有可编辑的提示词输入区');
  assert.match(CLIENT_SOURCE, /loadTypePrompt/, '打开面板要拉取当前提示词');
  assert.match(CLIENT_SOURCE, /saveTypePrompt/, '要有保存路径');
  assert.match(CLIENT_SOURCE, /apiPost\('\/type-prompt'/, '保存要打到 /type-prompt');
  assert.match(CLIENT_SOURCE, /恢复内置/, '要有恢复内置的出口');
});

test('回归：工具栏分两行，格式按钮不被 chip 挤断', () => {
  // 实测问题：13 个格式按钮曾被 chip 挤成 5+8 两行，换行位置很乱。
  assert.match(CLIENT_SOURCE, /wcv-toolRow/, '工具栏要有明确的行容器');
  assert.match(CLIENT_SOURCE, /wcv-toolRow--formats/, '格式按钮要有独立一行');
  // 格式按钮那一行必须包含全部 13 个，不再与 chip 混排。
  const row = CLIENT_SOURCE.slice(CLIENT_SOURCE.indexOf("'wcv-toolRow wcv-toolRow--formats'"));
  const list = row.slice(0, row.indexOf('].map('));
  for (const kind of ['h1', 'h2', 'h3', 'bold', 'italic', 'strike', 'code', 'codeblock', 'quote', 'ul', 'ol', 'link', 'hr']) {
    assert.ok(list.includes(`'${kind}'`), `格式按钮 ${kind} 必须在同一行里`);
  }
});

test('回归：镜像层要补偿 textarea 的滚动条宽度（否则批注色块错位）', () => {
  // 实测：textarea 有 7px 滚动条，镜像层 overflow:hidden 不占，
  // 两层内容盒宽度不等 → 换行位置分叉 → 高亮色块与文字对不上。
  assert.match(CLIENT_SOURCE, /syncHighlightMetrics/, '必须有宽度同步');
  assert.match(
    CLIENT_SOURCE,
    /el\.offsetWidth - el\.clientWidth - border/,
    '要真的把滚动条宽度量出来',
  );
  // 必须断言**补偿值真的被算进去了**：只断言出现过 paddingRight 是抓不到
  // 「量了滚动条却没用上」的——这一点已被实验证伪过一次。
  assert.match(
    CLIENT_SOURCE,
    /inner\.style\.paddingRight = `\$\{baseRight \+ scrollbar\}px`/,
    '镜像层内边距必须是「原内边距 + 滚动条宽度」',
  );
  // 三条路径都要同步：内容变化、滚动、逐字推进。
  const calls = CLIENT_SOURCE.match(/syncHighlightMetrics\(\)/g) ?? [];
  assert.ok(calls.length >= 3, `同步点至少三处，实际 ${calls.length} 处`);
  assert.match(CLIENT_SOURCE, /\}, \[text\]\);/, '内容变化后要重算');
});

// ---- 2026-10-01 用户反馈：格式集确认按钮 + 提示条关不掉 + 按钮尺寸不齐 --------

test('回归：选中格式集即生效，不再需要确认按钮', () => {
  // 用户原话：「把对勾取消掉，选中什么就默认确定使用这个 set」。
  assert.match(CLIENT_SOURCE, /const chooseSet = async/, '选中要走 chooseSet');
  assert.match(CLIENT_SOURCE, /apiPost\('\/doc\/format'/, '选中要立即持久化到文档');
  assert.match(
    CLIENT_SOURCE,
    /onChange: \(event\) => void chooseSet\(event\.target\.value\)/,
    '下拉的 onChange 必须直接落地，而不是只改本地状态',
  );
  assert.ok(
    !CLIENT_SOURCE.includes('IconCheck'),
    '对勾按钮与其图标都应删掉（含死代码）',
  );
});

test('回归：确认按钮删掉后，applyFormatSpec 只做导出，不留死分支', () => {
  const fn = CLIENT_SOURCE.slice(CLIENT_SOURCE.indexOf('const applyFormatSpec'));
  const body = fn.slice(0, fn.indexOf('\n      };'));
  assert.ok(
    !body.includes('currentTypeId'),
    'Markdown 那个「确认体例」分支已走不到（且原先写错成 currentTypeId），必须删掉',
  );
  assert.match(body, /apiPost\('\/export'/, '仍然要能导出 DOCX');
});

test('回归：+ Set 改成加号图标按钮', () => {
  assert.match(CLIENT_SOURCE, /icon: IconPlus[\s\S]{0,200}新建格式集/, '应是加号图标按钮');
  assert.ok(!CLIENT_SOURCE.includes("'+ Set'"), '不再有「+ Set」文字按钮');
});

test('回归：提示条必须能关掉', () => {
  // 用户原话：「点了对勾或者加 set 之后，这个上方的说明文字就不会消失了，怎么都去不掉」。
  assert.match(CLIENT_SOURCE, /wcv-bannerClose/, '提示条要有关闭按钮');
  assert.match(
    CLIENT_SOURCE,
    /wcv-bannerClose[\s\S]{0,400}?setMessage\(null\)/,
    '关闭按钮必须真的清掉 message',
  );
});

test('回归：工具栏按钮尺寸与形状统一为同款胶囊', () => {
  // 用户原话：「所有的按钮保持一致大小，同样的胶囊样式」。
  const icon = CLIENT_SOURCE.slice(CLIENT_SOURCE.indexOf('.wcv-iconBtn {'));
  const iconBlock = icon.slice(0, icon.indexOf('}'));
  assert.match(iconBlock, /width: 26px; height: 26px;/, '图标按钮 26×26');
  assert.match(iconBlock, /border-radius: 999px/, '图标按钮要是胶囊');

  const mini = CLIENT_SOURCE.slice(CLIENT_SOURCE.indexOf('.wcv-mini {'));
  const miniBlock = mini.slice(0, mini.indexOf('}'));
  assert.match(miniBlock, /height: 26px/, '文字按钮同为 26px 高');
  assert.match(miniBlock, /border-radius: 999px/, '文字按钮也要胶囊');

  const meta = CLIENT_SOURCE.slice(CLIENT_SOURCE.indexOf('.wcv-meta {'));
  const metaBlock = meta.slice(0, meta.indexOf('}'));
  assert.match(metaBlock, /height: 26px/, 'chip 同为 26px 高');
  assert.match(metaBlock, /border-radius: 999px/, 'chip 也是胶囊');
});

// ---- 2026-10-01 用户反馈：批注只能标已处理，不能交给 AI ---------------------

test('回归：批注卡片必须有「让 AI 处理」，不能只有已处理/忽略/删除', () => {
  // 用户原话：「批注只有已处理选项，没有让 AI 处理的选项」。
  assert.match(CLIENT_SOURCE, /让 AI 处理/, '批注卡片要有让 AI 处理的入口');
  assert.match(
    CLIENT_SOURCE,
    /askAgentToHandle\(annotation\.kind, annotation\.instruction, annotation\.quote\)/,
    '按钮要把这条批注的要求与原文交给 AI',
  );
});

test('回归：浮动工具条提交后要自动发到对话框', () => {
  // 用户原话：「输入之后，它会自动到对话框，然后让 AI 处理，实时撰写」。
  const fn = CLIENT_SOURCE.slice(CLIENT_SOURCE.indexOf('const submitAiAction'));
  const body = fn.slice(0, fn.indexOf('\n      };'));
  assert.match(body, /askAgentToHandle\(/, '提交成功后要自动交给 AI');
  assert.match(body, /created === true/, '只有批注确实建好了才发消息');
});

test('回归：交给 AI 的消息要带上要求，并指明用哪个工具读批注', () => {
  const fn = CLIENT_SOURCE.slice(CLIENT_SOURCE.indexOf('const askAgentToHandle'));
  const body = fn.slice(0, fn.indexOf('\n      };'));
  assert.match(body, /instruction/, '消息要带上用户写的要求');
  assert.match(body, /writing_canvas_annotate/, '要指引 AI 用批注工具读准确位置');
  assert.match(body, /resolved/, '要要求 AI 处理完标记已处理');
});

test('回归：输入框里有未发送的草稿时绝不覆盖', () => {
  // setDraft 是替换语义：不检查就会把用户正写的一半话冲掉。
  const fn = CLIENT_SOURCE.slice(CLIENT_SOURCE.indexOf('function sendToConversation'));
  const body = fn.slice(0, fn.indexOf('\n    }'));
  assert.match(body, /draft\.trim\(\) !== ''/, '要先判断草稿是否为空');
  assert.match(body, /return 'draft-busy'/, '草稿非空时明确拒绝并回报原因');
  assert.ok(
    body.indexOf("draft-busy") < body.indexOf('inputActions.setDraft'),
    '判断必须发生在 setDraft 之前',
  );
});

test('回归：发送结果要分情况播报，不能一律说成功', () => {
  const fn = CLIENT_SOURCE.slice(CLIENT_SOURCE.indexOf('const askAgentToHandle'));
  const body = fn.slice(0, fn.indexOf('\n      };'));
  for (const outcome of ["'sent'", "'draft-busy'"]) {
    assert.ok(body.includes(outcome), `要分别处理 ${outcome}`);
  }
  assert.match(body, /report\('annotation:handoff'/, '要上报结果便于事后核对');
});

test('回归：取不到输入框桥时不假装成功', () => {
  const fn = CLIENT_SOURCE.slice(CLIENT_SOURCE.indexOf('function sendToConversation'));
  const body = fn.slice(0, fn.indexOf('\n    }'));
  assert.match(body, /return 'no-bridge'/, '桥没就绪要如实返回');
});

test('回归：桥必须挂在会话级槽位上并从注入里取输入动作', () => {
  assert.match(CLIENT_SOURCE, /writing-canvas-composer-bridge/, '要注册桥组件');
  assert.match(
    CLIENT_SOURCE,
    /props\?\.inputActions \?\? props\?\.keyboard\?\.actions/,
    '输入动作可能经 inputActions 或 keyboard.actions 注入，两条都要认',
  );
});

// ---- 浮动工具条定位：选中靠右的文字时不得压住它 ------------------------------

const geo = { barWidth: 420, barHeight: 34, wrapWidth: 549, wrapHeight: 675 };

test('定位：常规情况贴在选区左上方', () => {
  const pos = clampFloatPosition({ ...geo, anchorLeft: 100, anchorTop: 300 });
  assert.equal(pos.left, 100);
  assert.equal(pos.top, 300 - 34 - 8);
});

test('回归：选区靠右时工具条要被夹进容器，不能越界压住文字', () => {
  // 用户报的正是这一条：文字在最右边，选中后工具条盖住了它。
  const pos = clampFloatPosition({ ...geo, anchorLeft: 540, anchorTop: 300 });
  assert.ok(pos.left + geo.barWidth <= geo.wrapWidth, `左边界越界：${pos.left} + ${geo.barWidth} > ${geo.wrapWidth}`);
  assert.equal(pos.left, geo.wrapWidth - geo.barWidth - 4);
});

test('定位：选区贴左边界时留出 gap，不贴死', () => {
  assert.equal(clampFloatPosition({ ...geo, anchorLeft: 0, anchorTop: 300 }).left, 4);
  assert.equal(clampFloatPosition({ ...geo, anchorLeft: -50, anchorTop: 300 }).left, 4);
});

test('回归：选中的是第一行时工具条翻到下方，不盖住那一行', () => {
  // 上方放不下（top - 高度 - 8 < 2）就应当翻到选区下面。
  const pos = clampFloatPosition({ ...geo, anchorLeft: 100, anchorTop: 10 });
  assert.ok(pos.top >= 10, `应当翻到选区下方，实际 top=${pos.top}`);
  assert.equal(pos.top, 10 + 30);
});

test('定位：容器太低时贴顶，不把工具条挤出可视区', () => {
  const pos = clampFloatPosition({ barWidth: 200, barHeight: 34, wrapWidth: 549, wrapHeight: 80, anchorLeft: 10, anchorTop: 200 });
  assert.ok(pos.top >= 2, '不得为负');
});

test('定位：容器比工具条还窄时退化为贴左，不产生负坐标', () => {
  const pos = clampFloatPosition({ barWidth: 600, barHeight: 34, wrapWidth: 400, wrapHeight: 500, anchorLeft: 300, anchorTop: 200 });
  assert.equal(pos.left, 4, '无处可放时贴左，配合 CSS max-width 兜底');
});

test('回归：定位必须在绘制前完成，且量出来之前先隐藏（避免闪跳）', () => {
  // 窗口给宽一点：断言的是「同一个 effect 里先量后定位」这个结构，
  // 而不是两段代码之间恰好隔多少字符（写紧过一次，误报）。
  assert.match(
    CLIENT_SOURCE,
    /React\.useLayoutEffect\(\(\) => \{[\s\S]{0,900}?clampFloatPosition/,
    '要用 useLayoutEffect 在绘制前量并定位',
  );
  assert.match(CLIENT_SOURCE, /visibility: 'hidden'/, '未定位前先隐藏');
  assert.match(CLIENT_SOURCE, /ref: floatRef/, '要挂 ref 才能量宽度');
});

test('回归：工具条自身要有 max-width 兜底，极窄容器下不溢出', () => {
  const css = CLIENT_SOURCE.slice(CLIENT_SOURCE.indexOf('.wcv-float {'));
  const block = css.slice(0, css.indexOf('}'));
  assert.match(block, /max-width: calc\(100% - 8px\)/, '要有 max-width 兜底');
  assert.match(block, /flex-wrap: wrap/, '放不下时换行而不是溢出');
});

// ---- Markdown 所见即所得：解析层 ---------------------------------------------
//
// 这套做法能成立只有一个前提：**解析不改变字符**。语法标记是用 visibility
// 占位隐藏的，不是删掉的——宽度不变，换行位置才不变，光标才落在正确的地方。
// 所以下面每个用例都先验字符保真，再验样式。

/** 解析并折成便于断言的形状：隐藏标记写成 [x]，带样式的写成 style:text。 */
const shape = (segments) =>
  segments.map((s) => (s.hidden === true ? `[${s.text}]` : s.style ? `${s.style}:${s.text}` : s.text)).join('');

test('回归：Markdown 解析必须逐字符保真（否则光标必然错位）', () => {
  const cases = [
    '# 那一栏',
    '**粗体**和*斜体*',
    '- 列表项一\n- 列表项二',
    '> 引用一句话',
    '看这个`code`和[链接](https://a.b)',
    '~~删除线~~',
    '普通中文，没有任何标记。',
    '**未闭合的星号',
    'my_var 不该被当成斜体',
    '`**` 里的星号不该生效',
    '',
    '\n\n',
    '***',
  ];
  for (const text of cases) {
    const segments = markdownInlineSegments(text, { atLineStart: true });
    assert.equal(markdownSegmentsToText(segments), text, `字符必须原样保留：${JSON.stringify(text)}`);
  }
});

test('标题：隐藏 # 号，整行套 heading 样式（字号不变）', () => {
  assert.equal(shape(markdownInlineSegments('# 那一栏', { atLineStart: true })), '[# ]heading:那一栏');
  // # 只在行首生效
  assert.equal(shape(markdownInlineSegments('井号 # 在句中', { atLineStart: false })), '井号 # 在句中');
});

test('粗体 / 斜体 / 删除线 / 行内代码：标记隐藏，内容套样式', () => {
  assert.equal(shape(markdownInlineSegments('**粗**', { atLineStart: false })), '[**]bold:粗[**]');
  assert.equal(shape(markdownInlineSegments('*斜*', { atLineStart: false })), '[*]italic:斜[*]');
  assert.equal(shape(markdownInlineSegments('~~删~~', { atLineStart: false })), '[~~]strike:删[~~]');
  assert.equal(shape(markdownInlineSegments('`码`', { atLineStart: false })), '[`]code:码[`]');
});

test('下划线不参与解析（避免把 my_var 之类误判成斜体）', () => {
  assert.equal(shape(markdownInlineSegments('my_var 和 __x__', { atLineStart: false })), 'my_var 和 __x__');
});

test('链接：只显示文字，方括号与地址占位隐藏', () => {
  // shape() 自带一层 [] 表示「隐藏」，所以开头的 `[` 显示为 `[[]`。
  assert.equal(
    shape(markdownInlineSegments('[看这里](https://a.b)', { atLineStart: false })),
    '[[]link:看这里[](https://a.b)]',
  );
});

test('行级标记：列表与引用只在行首生效', () => {
  assert.equal(shape(markdownInlineSegments('- 项目', { atLineStart: true })), '[-] 项目');
  assert.equal(shape(markdownInlineSegments('> 引用', { atLineStart: true })), '[> ]quote:引用');
  // 行首的 * 是列表符号，不该被当成斜体起始
  assert.equal(shape(markdownInlineSegments('* 项目', { atLineStart: true })), '[*] 项目');
});

test('未闭合的标记保持原样', () => {
  assert.equal(shape(markdownInlineSegments('**没关', { atLineStart: false })), '**没关');
  assert.equal(shape(markdownInlineSegments('只有一个 ` 号', { atLineStart: false })), '只有一个 ` 号');
});

test('回归：代码块内部的 Markdown 不解析', () => {
  const text = '```\n# 这是代码不是标题\n**也不是粗体**\n```';
  const fenceLines = computeFenceLines(text);
  assert.deepEqual(fenceLines, [true, true, true, true], '围栏内（含围栏行本身）都要标出来');
  const segments = markdownInlineSegments(text, { atLineStart: true, firstLine: 0, fenceLines });
  assert.equal(markdownSegmentsToText(segments), text, '仍然逐字符保真');
  assert.ok(
    segments.every((s) => s.style === undefined && s.hidden !== true),
    '代码块里不该出现任何样式或隐藏标记',
  );
});

test('围栏状态跨行成对切换，不会一路吞到底', () => {
  const lines = computeFenceLines('正文\n```\ncode\n```\n又回到正文');
  assert.deepEqual(lines, [false, true, true, true, false]);
});

test('回归：样式一律不改字号（改了宽度就变，对齐立刻破功）', () => {
  const css = CLIENT_SOURCE.slice(CLIENT_SOURCE.indexOf('.wcv-md-heading'));
  const block = css.slice(0, css.indexOf('}'));
  assert.match(block, /font-weight: 700/, '标题靠字重区分');
  assert.ok(!/font-size/.test(block), '标题绝不能改字号');
});

test('回归：语法标记必须是 visibility 占位，不能 display 隐藏', () => {
  assert.match(CLIENT_SOURCE, /\.wcv-mdHidden \{ visibility: hidden; \}/, '占位而不是移除');
  // 富文本开启时文字画在镜像层上，textarea 只留光标
  assert.match(CLIENT_SOURCE, /\.wcv-root--rich \.wcv-highlightInner \{ color: inherit; \}/, '镜像层要可见');
  assert.match(CLIENT_SOURCE, /caret-color:/, 'textarea 要保留光标颜色');
});

test('回归：两层高度对不上要自动退回纯文本', () => {
  // 宁可不好看，也不能让光标落在错的地方。
  assert.match(CLIENT_SOURCE, /setRichSafe\(false\)/, '要有降级路径');
  assert.match(CLIENT_SOURCE, /richtext:fallback/, '降级要上报');
  assert.match(CLIENT_SOURCE, /text\.trim\(\) === ''/, '空文档不体检（否则误报）');
});

test('回归：正文要经 renderRichText 渲染，批注高亮与 Markdown 叠加', () => {
  assert.match(CLIENT_SOURCE, /\.\.\.renderRichText\(text, annotations, suggestions\)/, '渲染入口要接上');
  const fn = CLIENT_SOURCE.slice(CLIENT_SOURCE.indexOf('function renderRichText'));
  const body = fn.slice(0, fn.indexOf('\n    }'));
  assert.match(body, /buildHighlightSegments/, '先切批注区间，保证高亮位置精确');
  assert.match(body, /markdownInlineSegments/, '再在片段内部解析 Markdown');
});

test('回归：相邻的同样式片段必须合并（否则长文会生成上千个 DOM 节点）', () => {
  const segments = markdownInlineSegments('**这是一段比较长的粗体文字内容**', { atLineStart: false });
  assert.equal(segments.length, 3, `应是 [标记][整段粗体][标记] 三段，实际 ${segments.length} 段`);
  assert.equal(segments[1].text, '这是一段比较长的粗体文字内容');
  assert.equal(segments[1].style, 'bold');
  // 合并不得破坏保真
  assert.equal(markdownSegmentsToText(segments), '**这是一段比较长的粗体文字内容**');
});

// ---- 2026-10-01 用户反馈：「它一直往底部去，好诡异」--------------------------
//
// 起因是「撰写中焦点跟随」每个 tick 都无条件把视野拉到底：用户想回看前文，
// 会被一直拽回底部，而且界面上没有任何说明。改法是——用户一往上滚就停手。

test('回归：用户手动滚动后必须暂停焦点跟随', () => {
  const fn = CLIENT_SOURCE.slice(CLIENT_SOURCE.indexOf('const followWritingTail'));
  const body = fn.slice(0, fn.indexOf('\n      };'));
  assert.match(body, /if \(followPausedRef\.current\) return;/, '暂停时不得再滚动');
  assert.ok(
    body.indexOf('followPausedRef.current') < body.indexOf('scrollEditorToEnd()'),
    '判断必须发生在滚动之前',
  );
});

test('回归：区分「程序滚动」与「用户滚动」，否则会自我打断', () => {
  // 跟随本身会触发 scroll 事件；若不区分，它会被自己判成「用户滚了」而停掉。
  assert.match(CLIENT_SOURCE, /programmaticScrollRef/, '要有程序滚动标记');
  const scroll = CLIENT_SOURCE.slice(CLIENT_SOURCE.indexOf('const scrollEditorToEnd'));
  const body = scroll.slice(0, scroll.indexOf('\n      };'));
  assert.match(body, /programmaticScrollRef\.current = true/, '程序滚动要先打标');
  assert.match(
    CLIENT_SOURCE,
    /if \(!programmaticScrollRef\.current\)/,
    'onScroll 里只在非程序滚动时才改跟随状态',
  );
});

test('回归：滚回底部附近要自动恢复跟随', () => {
  assert.match(CLIENT_SOURCE, /scrollHeight - el\.scrollTop - el\.clientHeight < 24/, '按距底部距离判定');
  assert.match(CLIENT_SOURCE, /followPausedRef\.current = paused/, '状态要跟着更新');
});

test('回归：新一次撰写要重置跟随状态', () => {
  const fn = CLIENT_SOURCE.slice(CLIENT_SOURCE.indexOf('const revealContent'));
  const body = fn.slice(0, fn.indexOf('stopReveal),'));
  assert.match(body, /followPausedRef\.current = false/, '新一轮重新跟随，否则会一直停着');
});

test('回归：暂停跟随要给用户一条可见的回到末尾入口', () => {
  // 视图不动却没有任何说明，用户会以为卡住了——这正是「诡异」的来源。
  assert.match(CLIENT_SOURCE, /wcv-followBack/, '要有回到末尾的按钮');
  assert.match(CLIENT_SOURCE, /已暂停跟随/, '要明说发生了什么');
  // 从**使用处**开始找：CSS 里也有同名类，先匹配到样式块就什么都验不到。
  const at = CLIENT_SOURCE.indexOf("className: 'wcv-followBack'");
  assert.ok(at > 0, '按钮要被真的渲染出来');
  assert.match(CLIENT_SOURCE.slice(at, at + 600), /scrollEditorToEnd\(\)/, '点了要真的回到底部');
});

test('回归：滚动状态更新要防抖，不能每次 scroll 都 setState', () => {
  assert.match(
    CLIENT_SOURCE,
    /if \(followPausedRef\.current !== paused\) \{/,
    '只在状态真的变化时才 setState',
  );
});

// ---- 2026-10-01 用户确认：「不是撰写时，我平时打字或看着它就自己往下跑」-------
//
// 真凶：服务端每次落盘都推 doc-changed，客户端据此调 refresh，refresh 又调
// revealContent，而 revealContent 末尾**无条件**把视图拉到底部。
// 于是「打字 → 自动保存 → 服务端推送 → 视图跳到底部」，与是否在撰写无关。

test('回归：服务端同步不得顺手把视图拉到底部', () => {
  // refresh 是 doc-changed 的回调，用户打字触发的自动保存回显也走这条路。
  const refresh = CLIENT_SOURCE.slice(CLIENT_SOURCE.indexOf('const refresh = async ()'));
  const body = refresh.slice(0, refresh.indexOf('\n        };'));
  assert.match(body, /revealContent\([^)]*\{ follow: /, '必须显式声明是否跟随');
  assert.ok(
    !/revealContent\(data\.latest\?\.content \?\? ''\)/.test(body),
    '不能再用「不传选项」的老写法——那是无条件跟随',
  );
});

test('回归：只有 AI 正在写时才跟随滚动', () => {
  assert.match(
    CLIENT_SOURCE,
    /revealContent\(data\.latest\?\.content \?\? '', \{ follow: data\.writing\?\.active === true \}\)/,
    '跟随与否必须取决于 writing.active',
  );
});

test('回归：内容没变就什么都不做（否则光标会被顶到末尾）', () => {
  const fn = CLIENT_SOURCE.slice(CLIENT_SOURCE.indexOf('const revealContent = React.useCallback'));
  const body = fn.slice(0, fn.indexOf('stopReveal),'));
  assert.match(body, /if \(next === previous\) return;/, '相同内容直接返回');
  assert.ok(
    body.indexOf('if (next === previous) return;') < body.indexOf('setText(next)'),
    '判断要在 setText 之前',
  );
});

test('回归：follow 默认关闭，必须是显式传 true 才跟随', () => {
  assert.match(
    CLIENT_SOURCE,
    /const follow = options !== null && typeof options === 'object' && options\.follow === true;/,
    '默认不跟随，避免任何调用方漏传时又把视图拉走',
  );
});

test('回归：接受建议时跟随（用户主动要看改写结果）', () => {
  assert.match(CLIENT_SOURCE, /revealContent\(data\.latest\.content, \{ follow: true \}\)/, '主动操作要看结果');
});
