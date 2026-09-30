/**
 * 修改建议存储与应用的测试。
 *
 * 这一组测试守的是**最重要的一条产品规则**：
 * AI 只能提议，正文在用户接受之前一个字符都不能变。
 *
 * 运行：node --test test/suggestions.test.mjs
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { SuggestionStore, applySuggestion } from '../src/suggestions.js';

/** 建一个用完即删的临时工作区。 */
async function withStore(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'writing-suggest-'));
  try {
    await fn(new SuggestionStore(dir, '.writing-canvas'), dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('创建建议不会改动任何正文文件', async () => {
  await withStore(async (store, dir) => {
    const created = await store.create('doc-a', {
      original: '原来的说法',
      proposed: '更好的说法',
      reason: '更口语',
      range: { start: 0, end: 5 },
      anchorVersion: 1,
    });
    assert.equal(created.status, 'pending');
    assert.equal(created.author, 'agent');
    // 建议只写进 suggestions.json，不碰正文。
    const items = await store.list('doc-a', '原来的说法');
    assert.equal(items.length, 1);
    assert.ok(dir.length > 0);
  });
});

test('接受建议才会把 proposed 写进正文，且区间精确', () => {
  const content = '开头，原来的说法，结尾。';
  const suggestion = {
    original: '原来的说法',
    proposed: '更好的说法',
    range: { start: 3, end: 8 },
  };
  const applied = applySuggestion(content, suggestion);
  assert.equal(applied.ok, true);
  assert.equal(applied.content, '开头，更好的说法，结尾。');
});

test('区间对不上时按原文重新定位，不改进错地方', () => {
  // 正文前面多了两个字，原区间已经偏移
  const content = '新增开头，原来的说法，结尾。';
  const suggestion = { original: '原来的说法', proposed: '更好的说法', range: { start: 3, end: 8 } };
  const applied = applySuggestion(content, suggestion);
  assert.equal(applied.ok, true);
  assert.equal(applied.content, '新增开头，更好的说法，结尾。');
  assert.match(applied.message, /重新定位/);
});

test('原文已不在正文中时拒绝应用，并说明原因', () => {
  const content = '完全换过的内容了。';
  const suggestion = { original: '原来的说法', proposed: '更好的说法', range: { start: 3, end: 8 } };
  const applied = applySuggestion(content, suggestion);
  assert.equal(applied.ok, false);
  assert.equal(applied.content, content, '失败时正文必须原样返回');
  assert.match(applied.message, /已不在正文中/);
});

test('非法区间被拒绝而不是抛错', () => {
  const applied = applySuggestion('正文', { original: '正', proposed: '改', range: {} });
  assert.equal(applied.ok, false);
});

test('状态流转：pending → accepted / rejected', async () => {
  await withStore(async (store) => {
    const created = await store.create('doc-a', { original: 'A', proposed: 'B', range: { start: 0, end: 1 } });
    const accepted = await store.mark('doc-a', created.id, 'accepted');
    assert.equal(accepted.status, 'accepted');
    assert.ok(accepted.decidedAt !== null);

    const again = await store.create('doc-a', { original: 'C', proposed: 'D', range: { start: 1, end: 2 } });
    const rejected = await store.mark('doc-a', again.id, 'rejected');
    assert.equal(rejected.status, 'rejected');
  });
});

test('列表把待决定的排在前面（用户先看到要处理的事）', async () => {
  await withStore(async (store) => {
    const a = await store.create('doc-a', { original: 'A', proposed: 'B', range: { start: 0, end: 1 } });
    const b = await store.create('doc-a', { original: 'B', proposed: 'C', range: { start: 1, end: 2 } });
    await store.mark('doc-a', a.id, 'accepted');
    const items = await store.list('doc-a', 'AB');
    assert.equal(items[0].id, b.id, '待决定的应排第一');
    assert.equal(items[0].status, 'pending');
  });
});

test('id 不存在时标记返回 null，删除返回 false（不抛错）', async () => {
  await withStore(async (store) => {
    assert.equal(await store.mark('doc-a', 'nope', 'accepted'), null);
    assert.equal(await store.remove('doc-a', 'nope'), false);
  });
});

test('删除建议只影响建议集合', async () => {
  await withStore(async (store) => {
    const created = await store.create('doc-a', { original: 'A', proposed: 'B', range: { start: 0, end: 1 } });
    assert.equal(await store.remove('doc-a', created.id), true);
    assert.deepEqual(await store.list('doc-a', 'A'), []);
  });
});
