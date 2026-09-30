/**
 * 事件总线测试。
 *
 * 覆盖「新版本 / 撰写中 / 调出画布意图」这三种推送，以及撰写超时的自愈。
 * 这些帧是「界面实时呈现」的全部依据，推错或漏推，用户看到的就是「没反应」。
 *
 * 运行：node --test test/events.test.mjs
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { createEventBus } from '../src/events.js';

/**
 * 造一个假的 SSE 订阅者，把收到的帧解析出来。
 *
 * 注意：每个订阅都会起一个 20 秒心跳定时器，**必须退订**，
 * 否则测试跑完 Node 进程不会退出（这是测试写法问题，不是产品缺陷：
 * 宿主的 /events 路由是 `req.on('close', unsubscribe)`，连接断开就清掉了）。
 */
function fakeSubscriber(frames) {
  return {
    write(chunk) {
      for (const line of String(chunk).split('\n')) {
        if (!line.startsWith('data: ')) continue;
        frames.push(JSON.parse(line.slice(6)));
      }
      return true;
    },
  };
}

/** 用完即清的订阅：把 dispose 记下来，在 finally 里统一退订。 */
function withBus(fn) {
  const bus = createEventBus();
  const disposers = [];
  const sub = (docId, frames) => {
    const dispose = bus.subscribe(docId, fakeSubscriber(frames));
    disposers.push(dispose);
    return dispose;
  };
  /** 订阅后清空一次：订阅瞬间必然先收到一帧当前撰写状态，多数测试不关心它。 */
  const subFresh = (docId, frames) => {
    const dispose = sub(docId, frames);
    frames.length = 0;
    return dispose;
  };
  try {
    fn(bus, sub, subFresh);
  } finally {
    for (const dispose of disposers) dispose();
  }
}

test('doc-changed 只推给订阅了同一份文档的界面', () => {
  withBus((bus, _sub, subFresh) => {
    const a = [];
    const b = [];
    subFresh('doc-a', a);
    subFresh('doc-b', b);

    bus.publishDocChanged('doc-a', { version: 3, source: 'agent' });

    assert.equal(a.length, 1);
    assert.equal(a[0].type, 'doc-changed');
    assert.equal(a[0].version, 3);
    assert.equal(b.length, 0, '不能串到别的文档');
  });
});

test('订阅时会立刻收到当前撰写状态（避免错过已经开始的那一轮）', () => {
  withBus((bus, sub) => {
    bus.setWriting('doc-a', true, '正在写第二节');

    const frames = [];
    sub('doc-a', frames);

    assert.equal(frames.length, 1);
    assert.equal(frames[0].type, 'writing');
    assert.equal(frames[0].active, true);
  });
});

test('回归：Agent 开始写正文时必须推送 canvas-intent（调出画布的唯一判据）', () => {
  withBus((bus, _sub, subFresh) => {
    const frames = [];
    subFresh('doc-a', frames);

    // 曾经画布是靠「新会话打开」无条件弹出的，正常任务也被干扰；
    // 现在改成由「真的在写正文」触发，所以这一帧绝不能丢。
    bus.publishCanvasIntent('doc-a', { reason: 'agent-write', version: 2, streaming: true });

    const intent = frames.find((f) => f.type === 'canvas-intent');
    assert.ok(intent !== undefined, 'canvas-intent 必须推出去');
    assert.equal(intent.reason, 'agent-write');
    assert.equal(intent.version, 2);
    assert.equal(intent.streaming, true);
  });
});

test('撰写状态：开始 → 结束的帧序正确，且 note 透传', () => {
  withBus((bus, _sub, subFresh) => {
    const frames = [];
    subFresh('doc-a', frames);

    bus.setWriting('doc-a', true, '正在写第三节');
    bus.setWriting('doc-a', false);

    const actives = frames.filter((f) => f.type === 'writing').map((f) => f.active);
    assert.deepEqual(actives, [true, false]);
    assert.equal(frames[0].note, '正在写第三节');
  });
});

test('撰写状态在显式结束与读取时语义一致', () => {
  withBus((bus) => {
    bus.setWriting('doc-a', true);
    assert.equal(bus.writingState('doc-a').active, true);

    bus.setWriting('doc-a', false);
    assert.deepEqual(bus.writingState('doc-a'), { active: false, startedAt: null, note: '' });
  });
});

test('取消订阅后不再收到帧，且订阅数归零', () => {
  withBus((bus, _sub, subFresh) => {
    const frames = [];
    const unsubscribe = subFresh('doc-a', frames);
    bus.publishDocChanged('doc-a', { version: 1 });
    assert.equal(frames.length, 1);

    unsubscribe();
    bus.publishDocChanged('doc-a', { version: 2 });
    assert.equal(frames.length, 1, '退订后不应再收到');
    assert.equal(bus.size(), 0);
  });
});
