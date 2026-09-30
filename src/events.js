/**
 * 文档事件总线 + 「撰写中」状态。
 *
 * 这是「AI 一边写、画布一边实时呈现」的地基：
 *   - 文档每次落盘都广播 doc-changed，界面据此拉取新版本并做逐字呈现
 *   - Agent 可以声明自己正在写（final=false），界面据此显示「撰写中…」
 *
 * 为什么用内存总线而不是轮询：SSE 是单向推送，浏览器侧实现简单（EventSource），
 * 且不需要界面反复问「变了没」。进程重启后连接会自然断开并由浏览器重连。
 *
 * @module dsh-writing-canvas/events
 */

/** 撰写状态多久没有更新就视为已结束（防止 Agent 中途失败导致永久转圈）。 */
const WRITING_IDLE_TIMEOUT_MS = 120_000;

/** SSE 心跳间隔：防止中间层因空闲而断开连接。 */
const HEARTBEAT_INTERVAL_MS = 20_000;

/**
 * 创建事件总线。
 * @returns 总线对象。
 */
export function createEventBus() {
  /** docId → Set<res>，同一个文档可能有多个界面在看着（画布 + 工作台）。 */
  const subscribers = new Map();
  /** docId → { active, startedAt, updatedAt, note }。 */
  const writing = new Map();

  /** 向一个文档的所有订阅者推送。 */
  const publish = (docId, payload) => {
    const peers = subscribers.get(docId);
    if (peers === undefined || peers.size === 0) return;
    const frame = `data: ${JSON.stringify(payload)}\n\n`;
    for (const res of [...peers]) {
      try {
        res.write(frame);
      } catch {
        // 写失败说明连接已经断了，交给 close 处理。
        peers.delete(res);
      }
    }
  };

  return {
    /**
     * 订阅一个文档的事件流。
     * @param docId - 文档标识。
     * @param res - node:http 响应对象（已写好 SSE 响应头）。
     * @returns 取消订阅函数。
     */
    subscribe(docId, res) {
      let peers = subscribers.get(docId);
      if (peers === undefined) {
        peers = new Set();
        subscribers.set(docId, peers);
      }
      peers.add(res);

      // 立刻把当前撰写状态告诉新订阅者，避免它错过已经开始的那一轮。
      const state = writing.get(docId);
      try {
        res.write(
          `data: ${JSON.stringify({
            type: 'writing',
            active: state !== undefined && state.active === true,
            startedAt: state?.startedAt ?? null,
          })}\n\n`,
        );
      } catch {
        // 忽略：连接可能已经断了。
      }

      const heartbeat = setInterval(() => {
        try {
          res.write(': ping\n\n');
        } catch {
          // 忽略
        }
      }, HEARTBEAT_INTERVAL_MS);

      return () => {
        clearInterval(heartbeat);
        peers.delete(res);
        if (peers.size === 0) subscribers.delete(docId);
      };
    },

    /** 文档内容变化（新版本落盘）。 */
    publishDocChanged(docId, detail) {
      publish(docId, { type: 'doc-changed', docId, ...detail });
    },

    /** 批注集合变化。 */
    publishAnnotationsChanged(docId, detail) {
      publish(docId, { type: 'annotations-changed', docId, ...detail });
    },

    /**
     * 标记/取消「正在撰写」。
     * @param docId - 文档标识。
     * @param active - 是否正在撰写。
     * @param note - 可选说明（例如「正在写第三节」）。
     */
    setWriting(docId, active, note) {
      const now = Date.now();
      if (active) {
        const previous = writing.get(docId);
        writing.set(docId, {
          active: true,
          startedAt: previous?.active === true ? previous.startedAt : new Date(now).toISOString(),
          updatedAt: now,
          note: note ?? '',
        });
      } else {
        writing.delete(docId);
      }
      const state = writing.get(docId);
      publish(docId, {
        type: 'writing',
        active: state !== undefined,
        startedAt: state?.startedAt ?? null,
        note: state?.note ?? '',
      });
    },

    /**
     * 读取当前撰写状态，并顺手清理超时未更新的记录。
     * @param docId - 文档标识。
     * @returns { active, startedAt, note }
     */
    writingState(docId) {
      const state = writing.get(docId);
      if (state === undefined) return { active: false, startedAt: null, note: '' };
      if (Date.now() - state.updatedAt > WRITING_IDLE_TIMEOUT_MS) {
        writing.delete(docId);
        return { active: false, startedAt: null, note: '' };
      }
      return { active: true, startedAt: state.startedAt, note: state.note };
    },

    /** 当前订阅者数量（诊断用）。 */
    size() {
      let total = 0;
      for (const peers of subscribers.values()) total += peers.size;
      return total;
    },
  };
}
