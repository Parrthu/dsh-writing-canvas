/**
 * 写作类型提示词覆盖的测试。
 *
 * 用户诉求：「写作类型查看引用数这个部分改成提示词，点开提示词之后，用户可以自己修改。」
 * 这条链路有四处必须同时对：库的存取、共享缓存、提示段渲染、以及「恢复内置」。
 * 少任何一处，用户改完都是「看起来保存了但没生效」——正是本项目栽过好几次的坑。
 *
 * 运行：node --test test/type-prompt.test.mjs
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { WorkspaceLibrary } from '../src/library.js';
import { typesSectionText } from '../src/prompt.js';
import { apply as applyCreative } from '../src/types/creative.js';
import { listTypes, registerType } from '../src/types/registry.js';
import { currentOverrides, mergeOverrides, onOverridesChanged } from '../src/prompt-overrides.js';

/** 建一个用完即删的临时工作区。 */
async function withLibrary(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'writing-type-prompt-'));
  try {
    await fn(new WorkspaceLibrary(dir, '.writing-canvas'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// 内置类型平时由独立的插件行注册；测试里手动挂一次。
applyCreative({ reflect: undefined, effect: (fn) => (fn(), () => {}), logger: { warn() {} } });

test('提示词覆盖：保存后能读回来', async () => {
  await withLibrary(async (library) => {
    assert.deepEqual(await library.listTypePrompts(), {}, '初始应当没有覆盖');
    await library.setTypePrompt('creative', '只写 800 字，禁用形容词。');
    const map = await library.listTypePrompts();
    assert.equal(map.creative, '只写 800 字，禁用形容词。');
  });
});

test('提示词覆盖：传空串即恢复内置（删掉覆盖而不是存空文本）', async () => {
  await withLibrary(async (library) => {
    await library.setTypePrompt('creative', '第一版');
    assert.equal((await library.listTypePrompts()).creative, '第一版');
    const after = await library.setTypePrompt('creative', '');
    assert.equal(after.creative, undefined, '空串必须删掉覆盖');
    assert.deepEqual(await library.listTypePrompts(), {});
  });
});

test('提示词覆盖：缺 id 直接报错，不静默写坏文件', async () => {
  await withLibrary(async (library) => {
    await assert.rejects(() => library.setTypePrompt('', 'x'), /缺少写作类型 id/);
  });
});

test('回归：有覆盖时提示段用用户那版，内置约束不再出现', () => {
  const builtin = typesSectionText({});
  assert.ok(builtin.includes('禁用陈词滥调'), '无覆盖时应当用内置约束');

  const custom = typesSectionText({ creative: '# 我的创意写作\n\n只写 800 字。' });
  assert.ok(custom.includes('我的创意写作'), '有覆盖时必须注入用户文本');
  assert.ok(custom.includes('只写 800 字。'), '用户文本要完整带上');
  assert.ok(!custom.includes('禁用陈词滥调'), '内置约束必须被替换，不能两版并存');
  assert.ok(custom.includes('优先级高于下面的内置约束'), '要明确告诉模型这版优先');
});

test('回归：其他类型不受某个类型的覆盖影响', () => {
  // 临时注册第二个类型，确认覆盖是按 id 精确命中的。
  const dispose = registerType({
    id: 'gongwen-test',
    label: '公文测试',
    summary: '',
    constraints: ['公文约束样例'],
    mustConfirm: [],
    structure: [],
    checklist: [],
    format: { kind: 'docx', spec: 'x' },
  });
  try {
    const text = typesSectionText({ creative: '# 只有创意被改' });
    assert.ok(text.includes('# 只有创意被改'), '创意那段应当用覆盖文本');
    assert.ok(text.includes('公文约束样例'), '公文那段仍是内置');
  } finally {
    dispose();
  }
});

test('回归：清空覆盖后提示段回到内置版本', () => {
  const custom = typesSectionText({ creative: 'x' });
  assert.ok(!custom.includes('禁用陈词滥调'));
  const restored = typesSectionText({});
  assert.ok(restored.includes('禁用陈词滥调'), '恢复内置后必须见到内置约束');
});

test('共享缓存：合并后能读到，并且会通知订阅者', () => {
  let notified = 0;
  const off = onOverridesChanged(() => {
    notified += 1;
  });
  try {
    mergeOverrides({ 'cache-probe': 'hello' });
    assert.equal(currentOverrides()['cache-probe'], 'hello');
    assert.ok(notified >= 1, '变更必须通知订阅者，否则提示段不会重装');
  } finally {
    off();
  }
});

test('共享缓存：空白覆盖不进缓存', () => {
  mergeOverrides({ 'blank-probe': '   ' });
  assert.equal(currentOverrides()['blank-probe'], undefined);
});

test('共享缓存：取消订阅后不再收到通知', () => {
  let notified = 0;
  const off = onOverridesChanged(() => {
    notified += 1;
  });
  off();
  mergeOverrides({ 'after-off': 'x' });
  assert.equal(notified, 0);
});

test('类型注册表里确实有内置类型（覆盖测试的前提）', () => {
  assert.ok(listTypes().some((type) => type.id === 'creative'));
});

// ---- 格式集：选中即生效（2026-10-01 用户要求去掉对勾）------------------------

test('格式集：setFormat 只写 meta，不产生新版本、不动正文', async () => {
  const { DocumentStore } = await import('../src/store.js');
  const { mkdtemp } = await import('node:fs/promises');
  const dir = await mkdtemp(join(tmpdir(), 'writing-format-'));
  try {
    const store = new DocumentStore(dir, '.writing-canvas');
    await store.saveDoc('doc-a', '正文内容', { title: '标题' });
    await store.setType('doc-a', 'creative');
    const before = await store.readDoc('doc-a');

    const meta = await store.setFormat('doc-a', 'md-standard');
    assert.equal(meta.format.set, 'md-standard');
    assert.equal(meta.writingType, 'creative', '改格式不能把写作类型冲掉');

    const after = await store.readDoc('doc-a');
    assert.equal(after.latest.n, before.latest.n, '改格式不得产生新版本');
    assert.equal(after.latest.content, '正文内容', '正文必须一字不动');
    assert.equal(after.meta.title, '标题', '标题保持');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('格式集：传空串即清掉选择，回到默认', async () => {
  const { DocumentStore } = await import('../src/store.js');
  const { mkdtemp } = await import('node:fs/promises');
  const dir = await mkdtemp(join(tmpdir(), 'writing-format-'));
  try {
    const store = new DocumentStore(dir, '.writing-canvas');
    await store.saveDoc('doc-a', '正文');
    await store.setFormat('doc-a', 'md-standard');
    const meta = await store.setFormat('doc-a', '');
    assert.equal(meta.format.set, undefined, '空串要删掉 set 字段而不是存空值');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
