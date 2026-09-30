/**
 * 写作类型提示词覆盖的共享缓存。
 *
 * 用户在画布上点开「提示词」改过的内容存在工作区库里（`library/type-prompts.json`）。
 * 但注入系统提示这一段（`typesSectionText`）是**同步渲染**的，而库是异步读的，
 * 两者接不上。所以这里放一份内存缓存：
 *
 *   - 接口保存覆盖后 → 刷新缓存并通知订阅者
 *   - mode/writing 挂载的提示段 → 订阅通知，重新注册那一段
 *
 * 为什么是全局 Map 而不是按工作区分桶：写作类型注册表本身就是**进程级全局**的
 * （内置类型是独立插件行，自定义类型也在同一张表里），所以类型的可见性从来不分工作区。
 * 覆盖跟着同一套语义走，避免出现「同一个类型在不同会话里约束不一样」这种更难解释的行为。
 *
 * @module dsh-writing-canvas/prompt-overrides
 */

/** typeId → 用户改过的提示词。 */
const overrides = new Map();

/** 变更订阅者。 */
const listeners = new Set();

/**
 * 整体替换缓存（保存后由接口调用）。
 * @param map - { [typeId]: text }
 */
export function replaceOverrides(map) {
  overrides.clear();
  if (map !== null && typeof map === 'object') {
    for (const [typeId, text] of Object.entries(map)) {
      if (typeof text === 'string' && text.trim() !== '') overrides.set(typeId, text);
    }
  }
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch {
      // 单个订阅者出错不能影响保存流程本身。
    }
  }
}

/**
 * 合并一批覆盖（多工作区时后写的生效）。
 * @param map - { [typeId]: text }
 */
export function mergeOverrides(map) {
  if (map === null || typeof map !== 'object') return;
  for (const [typeId, text] of Object.entries(map)) {
    if (typeof text === 'string' && text.trim() !== '') overrides.set(typeId, text);
  }
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch {
      // 忽略。
    }
  }
}

/**
 * 读当前覆盖快照（提示段渲染时用）。
 * @returns { [typeId]: text }
 */
export function currentOverrides() {
  return Object.fromEntries(overrides);
}

/**
 * 订阅覆盖变化。
 * @param listener - 无参回调。
 * @returns 取消订阅函数。
 */
export function onOverridesChanged(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
