/**
 * 写作类型注册表与 5 个内置类型包的真实行为测试。
 *
 * 覆盖：每个类型包都能独立注册、定义完整、可单独注销、id 冲突被拒、
 * 变化通知会触发、以及类型段提示词确实包含全部硬约束。
 *
 * 运行：node --test test/types.test.mjs
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { typesSectionText } from '../src/prompt.js';
import * as creative from '../src/types/creative.js';
import * as gongwen from '../src/types/gongwen.js';
import * as news from '../src/types/news.js';
import { getType, listTypes, onTypesChanged, registerType } from '../src/types/registry.js';
import * as videoScript from '../src/types/video-script.js';
import * as xiaohongshu from '../src/types/xiaohongshu.js';

/** 内置类型包（顺序即 order）。 */
const PACKS = [creative, gongwen, videoScript, xiaohongshu, news];

/** 期望的 id 与顺序。 */
const EXPECTED_IDS = ['creative', 'gongwen', 'video-script', 'xiaohongshu', 'news'];

/**
 * 用一个最小 Cordis 上下文应用一个类型包，返回注销函数。
 * @param pack - 类型包模块。
 * @returns 注销函数。
 */
function applyPack(pack) {
  const disposers = [];
  const ctx = {
    effect(callback) {
      const disposer = callback();
      if (typeof disposer === 'function') disposers.push(disposer);
      return disposer;
    },
  };
  pack.apply(ctx);
  return () => {
    for (const dispose of disposers) dispose();
  };
}

/** 在启用全部内置类型的前提下跑一段断言，结束后彻底清理注册表。 */
async function withAllTypes(fn) {
  const disposes = PACKS.map(applyPack);
  try {
    await fn();
  } finally {
    for (const dispose of disposes) dispose();
  }
}

test('每个类型包都以合法的 Cordis 插件形态导出', () => {
  for (const pack of PACKS) {
    assert.equal(typeof pack.name, 'string', '插件必须有 name');
    assert.match(pack.name, /^writing-type-/, 'name 必须以 writing-type- 开头');
    assert.equal(typeof pack.apply, 'function', '插件必须有 apply');
  }
});

test('5 个内置类型都能注册，且按 order 排序', async () => {
  await withAllTypes(() => {
    assert.deepEqual(
      listTypes().map((type) => type.id),
      EXPECTED_IDS,
    );
  });
});

test('注册表清空后类型段提示词会如实说明没有启用类型', () => {
  const text = typesSectionText();
  assert.match(text, /没有启用任何写作类型/);
});

test('每个类型的定义都是完整的（硬约束、自检、必确认项、格式）', async () => {
  await withAllTypes(() => {
    for (const type of listTypes()) {
      assert.equal(typeof type.label, 'string', `${type.id} 缺 label`);
      assert.ok(type.label.length > 0, `${type.id} 的 label 不能为空`);
      assert.equal(typeof type.summary, 'string', `${type.id} 缺 summary`);
      assert.ok(Array.isArray(type.mustConfirm) && type.mustConfirm.length > 0, `${type.id} 缺 mustConfirm`);
      assert.ok(Array.isArray(type.constraints) && type.constraints.length >= 5, `${type.id} 的硬约束太少`);
      assert.ok(Array.isArray(type.structure) && type.structure.length > 0, `${type.id} 缺 structure`);
      assert.ok(Array.isArray(type.checklist) && type.checklist.length >= 3, `${type.id} 的自检项太少`);
      assert.ok(type.format && (type.format.kind === 'markdown' || type.format.kind === 'docx'), `${type.id} 格式非法`);
      for (const item of type.constraints) {
        assert.ok(typeof item === 'string' && item.trim().length > 8, `${type.id} 有空的或过短的约束`);
      }
    }
  });
});

test('只有公文类型默认走受约束 DOCX，其余默认 Markdown', async () => {
  await withAllTypes(() => {
    for (const type of listTypes()) {
      if (type.id === 'gongwen') {
        assert.equal(type.format.kind, 'docx');
        assert.equal(type.format.spec, 'gongwen-gb9704');
      } else {
        assert.equal(type.format.kind, 'markdown', `${type.id} 应当默认 Markdown`);
      }
    }
  });
});

test('类型段提示词包含全部类型的全部硬约束（约束绕不过去）', async () => {
  await withAllTypes(() => {
    const text = typesSectionText();
    for (const type of listTypes()) {
      assert.ok(text.includes(`## ${type.label}（id: \`${type.id}\`）`) || text.includes(type.label), `缺 ${type.id} 的标题`);
      for (const constraint of type.constraints) {
        assert.ok(text.includes(constraint), `${type.id} 的约束没有进入提示词：${constraint.slice(0, 20)}…`);
      }
      for (const item of type.mustConfirm) {
        assert.ok(text.includes(item), `${type.id} 的必确认项没有进入提示词：${item}`);
      }
    }
  });
});

test('类型包可以单独停用，停用后从清单与提示词中同时消失', async () => {
  const disposeCreative = applyPack(creative);
  const disposeNews = applyPack(news);
  try {
    assert.deepEqual(
      listTypes().map((type) => type.id),
      ['creative', 'news'],
    );
    disposeCreative();
    assert.deepEqual(
      listTypes().map((type) => type.id),
      ['news'],
    );
    const text = typesSectionText();
    assert.ok(!text.includes('id: `creative`'), '停用后不应再出现在提示词里');
    assert.ok(text.includes('id: `news`'));
  } finally {
    disposeCreative();
    disposeNews();
  }
});

test('id 冲突被拒绝，非法定义被拒绝', async () => {
  const dispose = applyPack(creative);
  try {
    assert.throws(() => registerType({ id: 'creative', label: '重复' }), /重复/);
    assert.throws(() => registerType({ id: '', label: '空 id' }), /id/);
    assert.throws(() => registerType({ id: 'x', label: '' }), /label/);
    assert.throws(() => registerType(null), /对象/);
  } finally {
    dispose();
  }
  assert.equal(getType('creative'), undefined);
});

test('类型集合变化会通知订阅者（提示词段落据此刷新）', () => {
  let count = 0;
  const unsubscribe = onTypesChanged(() => {
    count += 1;
  });
  const dispose = applyPack(gongwen);
  assert.equal(count, 1, '注册应触发一次通知');
  dispose();
  assert.equal(count, 2, '注销也应触发一次通知');
  unsubscribe();
  const disposeAgain = applyPack(news);
  assert.equal(count, 2, '取消订阅后不应再收到通知');
  disposeAgain();
});
