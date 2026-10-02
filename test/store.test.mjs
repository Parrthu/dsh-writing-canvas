/**
 * DocumentStore 的真实行为测试。
 *
 * 这些测试不依赖 DSH 运行时，直接用 node:test 跑真实文件系统，覆盖
 * 「不可变版本 / 内容未变不产生噪音版本 / 冲突拒绝写入 / 还原不改历史」
 * 这几条最容易写错的规则。
 *
 * 运行：node --test test/
 */

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { DocumentStore, assertSafeDocId, hashContent } from '../src/store.js';

/** 建一个用完即删的临时工作区。 */
async function withStore(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'writing-canvas-test-'));
  try {
    await fn(new DocumentStore(dir, '.writing-canvas'), dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('首次保存生成 v1，且正文与元信息正确', async () => {
  await withStore(async (store) => {
    const saved = await store.saveDoc('doc-a', '第一段正文。', { source: 'user', title: '测试文档' });
    assert.equal(saved.unchanged, false);
    assert.equal(saved.latest.n, 1);
    assert.equal(saved.latest.content, '第一段正文。');
    assert.equal(saved.latest.source, 'user');
    assert.equal(saved.latest.hash, hashContent('第一段正文。'));
    assert.equal(saved.meta.title, '测试文档');
    assert.equal(saved.meta.latest, 1);
    assert.equal(saved.meta.versionCount, 1);
  });
});

test('内容完全一致时不生成新版本（自动保存不会刷成噪音）', async () => {
  await withStore(async (store) => {
    await store.saveDoc('doc-a', '同样的内容');
    const again = await store.saveDoc('doc-a', '同样的内容');
    assert.equal(again.unchanged, true);
    assert.equal(again.latest.n, 1);
    const versions = await store.listVersions('doc-a');
    assert.equal(versions.length, 1);
  });
});

test('每次内容变化都生成新的不可变版本，历史按序保留', async () => {
  await withStore(async (store) => {
    await store.saveDoc('doc-a', 'v1 内容');
    await store.saveDoc('doc-a', 'v2 内容');
    await store.saveDoc('doc-a', 'v3 内容');

    const versions = await store.listVersions('doc-a');
    assert.deepEqual(
      versions.map((v) => v.n),
      [1, 2, 3],
    );

    // 历史版本只读且内容未被覆盖。
    assert.equal((await store.readVersion('doc-a', 1)).content, 'v1 内容');
    assert.equal((await store.readVersion('doc-a', 2)).content, 'v2 内容');
    assert.equal((await store.readVersion('doc-a', 3)).content, 'v3 内容');
  });
});

test('基于过期版本的保存被拒绝，且不写入任何内容（冲突保护）', async () => {
  await withStore(async (store) => {
    await store.saveDoc('doc-a', '用户版本'); // v1
    await store.saveDoc('doc-a', 'AI 写入的版本', { source: 'agent' }); // v2

    // 客户端仍以为自己在 v1 上编辑。
    const result = await store.saveDoc('doc-a', '用户基于 v1 的编辑', { baseVersion: 1 });
    assert.equal(result.conflict, true);
    assert.equal(result.latest.n, 2);
    assert.equal(result.latest.content, 'AI 写入的版本');

    // 关键：冲突时绝不能落盘。
    const versions = await store.listVersions('doc-a');
    assert.equal(versions.length, 2);
    assert.equal((await store.readDoc('doc-a')).latest.content, 'AI 写入的版本');
  });
});

test('用户明确选择覆盖时才写入（force）', async () => {
  await withStore(async (store) => {
    await store.saveDoc('doc-a', '用户版本');
    await store.saveDoc('doc-a', 'AI 写入的版本', { source: 'agent' });

    const forced = await store.saveDoc('doc-a', '用户决定覆盖的内容', { baseVersion: 1, force: true });
    assert.equal(forced.conflict, undefined);
    assert.equal(forced.latest.n, 3);
    assert.equal(forced.latest.content, '用户决定覆盖的内容');

    // 被覆盖的 AI 版本仍然完好在历史里，没有丢失。
    assert.equal((await store.readVersion('doc-a', 2)).content, 'AI 写入的版本');
  });
});

test('还原是把历史内容写成新版本，历史本身不被破坏', async () => {
  await withStore(async (store) => {
    await store.saveDoc('doc-a', '最初的内容');
    await store.saveDoc('doc-a', '改写后的内容');

    const restored = await store.restoreVersion('doc-a', 1);
    assert.equal(restored.latest.n, 3);
    assert.equal(restored.latest.content, '最初的内容');
    assert.equal(restored.latest.source, 'restore');

    const versions = await store.listVersions('doc-a');
    assert.deepEqual(
      versions.map((v) => v.n),
      [1, 2, 3],
    );
    assert.equal((await store.readVersion('doc-a', 2)).content, '改写后的内容');
  });
});

test('并发保存不会写坏版本索引', async () => {
  await withStore(async (store) => {
    await Promise.all(
      Array.from({ length: 12 }, (_, index) => store.saveDoc('doc-a', `并发内容 ${index}`)),
    );
    const versions = await store.listVersions('doc-a');
    assert.equal(versions.length, 12);
    assert.deepEqual(
      versions.map((v) => v.n),
      Array.from({ length: 12 }, (_, index) => index + 1),
    );
    const doc = await store.readDoc('doc-a');
    assert.equal(doc.meta.versionCount, 12);
  });
});

test('不同文档互不干扰，listDocuments 按更新时间倒序', async () => {
  await withStore(async (store) => {
    await store.saveDoc('doc-a', 'A');
    await new Promise((resolve) => setTimeout(resolve, 5));
    await store.saveDoc('doc-b', 'B');

    const docs = await store.listDocuments();
    assert.equal(docs.length, 2);
    assert.equal(docs[0].docId, 'doc-b');
    assert.equal(docs[1].docId, 'doc-a');
  });
});

test('未写入过的文档读取返回 null', async () => {
  await withStore(async (store) => {
    assert.equal(await store.readDoc('nope'), null);
    assert.deepEqual(await store.listVersions('nope'), []);
    assert.equal(await store.readVersion('nope', 1), null);
  });
});

test('空白内容不能静默覆盖非空文档（防数据丢失）', async () => {
  await withStore(async (store) => {
    await store.saveDoc('doc-a', '这是用户辛苦写下的内容。');
    const blocked = await store.saveDoc('doc-a', '');
    assert.equal(blocked.emptyRejected, true, '空覆盖必须被拦下');
    // 关键：原内容必须还在。
    assert.equal((await store.readDoc('doc-a')).latest.content, '这是用户辛苦写下的内容。');
    assert.equal((await store.listVersions('doc-a')).length, 1, '被拦下时不应产生新版本');
  });
});

test('只有空白字符（空格换行制表符）同样会被拦下', async () => {
  await withStore(async (store) => {
    await store.saveDoc('doc-a', '有内容');
    const blocked = await store.saveDoc('doc-a', '   \n\n\t  ');
    assert.equal(blocked.emptyRejected, true);
    assert.equal((await store.readDoc('doc-a')).latest.content, '有内容');
  });
});

test('显式 allowEmpty 时才允许清空（用户确实想清空的情况）', async () => {
  await withStore(async (store) => {
    await store.saveDoc('doc-a', '要清空的内容');
    const cleared = await store.saveDoc('doc-a', '', { allowEmpty: true });
    assert.equal(cleared.emptyRejected, undefined);
    assert.equal(cleared.latest.n, 2);
    assert.equal(cleared.latest.content, '');
    assert.equal((await store.readDoc('doc-a')).latest.content, '');
  });
});

test('空文档之间互相覆盖不受限制（首版为空是合法的）', async () => {
  await withStore(async (store) => {
    await store.saveDoc('doc-a', '');
    const again = await store.saveDoc('doc-a', '');
    assert.equal(again.emptyRejected, undefined);
    assert.equal(again.unchanged, true);
  });
});

test('落盘的是真实 JSON 文件，且拒绝路径穿越', async () => {
  await withStore(async (store, dir) => {
    await store.saveDoc('doc-a', '内容');
    const meta = JSON.parse(
      await readFile(join(dir, '.writing-canvas', 'docs', 'doc-a', 'meta.json'), 'utf8'),
    );
    assert.equal(meta.docId, 'doc-a');
    assert.equal(meta.latest, 1);

    assert.throws(() => assertSafeDocId('../escape'));
    assert.throws(() => assertSafeDocId('a/b'));
    assert.throws(() => assertSafeDocId(''));
    assert.equal(assertSafeDocId('s-session-1234_ab.c'), 's-session-1234_ab.c');
  });
});

// ---- 回归测试：2026-09-30「画布空白」事故的四条根因 --------------------------
//
// 背景：磁盘上正文明明在（v1 861 字节），右栏画布却渲染成空状态。
// 逐层查出来四个各自独立的缺陷，都补在这里，防止再退回去。

test('回归：只有 meta、还没有版本的文档，readDoc 不抛错且 latest 为 null', async () => {
  await withStore(async (store) => {
    // 选定写作类型会先落 meta（latest=0），此时还没有任何正文版本。
    // 曾经这里把 0 交给 readVersion，触发「版本号必须是正整数」抛出，
    // 导致画布完全读不出文档。
    await store.setType('doc-a', 'creative');
    const doc = await store.readDoc('doc-a');
    assert.notEqual(doc, null);
    assert.equal(doc.latest, null);
    assert.equal(doc.meta.writingType, 'creative');
    assert.equal(doc.meta.latest, 0);
  });
});

test('回归：写作类型跨版本保留，不会被 saveDoc 冲掉', async () => {
  await withStore(async (store) => {
    await store.setType('doc-a', 'creative');
    await store.saveDoc('doc-a', '第一版', { source: 'agent' });
    let doc = await store.readDoc('doc-a');
    assert.equal(doc.meta.writingType, 'creative', 'v1 之后类型必须还在');

    await store.saveDoc('doc-a', '第二版', { source: 'agent' });
    doc = await store.readDoc('doc-a');
    assert.equal(doc.meta.writingType, 'creative', 'v2 之后类型必须还在');

    await store.restoreVersion('doc-a', 1);
    doc = await store.readDoc('doc-a');
    assert.equal(doc.meta.writingType, 'creative', '还原之后类型必须还在');
  });
});

test('回归：正文未变时改标题要写回（不能静默吞掉）', async () => {
  await withStore(async (store) => {
    await store.saveDoc('doc-a', '正文', { title: '未命名文档' });
    // 内容一模一样，只改标题：会走「unchanged」分支。
    const again = await store.saveDoc('doc-a', '正文', { title: '那一栏' });
    assert.equal(again.unchanged, true);
    assert.equal(again.meta.title, '那一栏');
    assert.equal(again.latest.n, 1, '只改标题不应产生新版本');

    const doc = await store.readDoc('doc-a');
    assert.equal(doc.meta.title, '那一栏', '标题必须真的落盘');
  });
});

test('版本折叠：coalesce 窗口内的连续保存改写最新版本而非新增', async () => {
  await withStore(async (store) => {
    await store.saveDoc('doc', '第一版。', { source: 'user' });
    const r1 = await store.saveDoc('doc', '第一版。\n第二行。', {
      source: 'user', coalesce: true, coalesceMs: 60_000, note: '自动保存',
    });
    assert.equal(r1.coalesced, true);
    assert.equal(r1.latest.n, 1, '折叠不新增版本号');
    assert.equal(r1.latest.folds, 1);
    assert.equal(r1.meta.versionCount, 1);
    assert.ok(r1.latest.content.includes('第二行。'));
    const r2 = await store.saveDoc('doc', '第一版。\n第二行。\n第三行。', {
      source: 'user', coalesce: true, coalesceMs: 60_000,
    });
    assert.equal(r2.latest.n, 1);
    assert.equal(r2.latest.folds, 2);
    const versions = await store.listVersions('doc');
    assert.equal(versions.length, 1, '窗口内的三次保存只有一个版本文件');
    assert.equal(versions[0].note, '自动保存', '首次的 note 在无新 note 时保留');
  });
});

test('版本折叠：换来源或窗口外照常新增版本', async () => {
  await withStore(async (store, dir) => {
    await store.saveDoc('doc', '第一版。', { source: 'user' });
    // 换来源：用户 → Agent 不折叠
    const ra = await store.saveDoc('doc', '第一版。\nAI 补一段。', {
      source: 'agent', coalesce: true, coalesceMs: 60_000,
    });
    assert.equal(ra.coalesced, undefined);
    assert.equal(ra.latest.n, 2);
    // 把最新版本的 at 拨回 10 分钟前：窗口外不折叠
    const v2Path = join(dir, '.writing-canvas', 'docs', 'doc', 'v0002.json');
    const record = JSON.parse(await readFile(v2Path, 'utf8'));
    record.at = new Date(Date.now() - 10 * 60_000).toISOString();
    const { writeFile } = await import('node:fs/promises');
    await writeFile(v2Path, JSON.stringify(record, null, 2) + '\n', 'utf8');
    const rb = await store.saveDoc('doc', record.content + '\n窗口外的一行。', {
      source: 'agent', coalesce: true, coalesceMs: 60_000,
    });
    assert.equal(rb.coalesced, undefined);
    assert.equal(rb.latest.n, 3);
    const versions = await store.listVersions('doc');
    assert.equal(versions.length, 3);
  });
});

test('版本折叠：不带 coalesce 的调用（AI 写入/还原/建议接受）永不折叠', async () => {
  await withStore(async (store) => {
    await store.saveDoc('doc', '第一版。', { source: 'agent' });
    const r = await store.saveDoc('doc', '第一版。\n第二段。', { source: 'agent' });
    assert.equal(r.coalesced, undefined);
    assert.equal(r.latest.n, 2, 'AI 连续写入也各自成版（分段流式的语义）');
    const versions = await store.listVersions('doc');
    assert.equal(versions.length, 2);
  });
});
