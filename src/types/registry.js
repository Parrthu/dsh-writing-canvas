/**
 * 写作类型注册表。
 *
 * 这是「插件中的插件」的通信中枢：每个写作类型是**独立的 Cordis 插件行**
 * （见 cordis.patch.yml），启用时调用 registerType 把自己登记进来，
 * 停用时由 Cordis fiber 自动注销。核心半体、Agent 工具、界面都从这里读取。
 *
 * 为什么用模块级单例而不是 ctx 服务：类型包与本文件同属一个包、同一份模块图，
 * 直接 import 最稳；同时对外暴露 ctx.reflect.provide 形态的 API，
 * 让**本包之外**的第三方插件也能注册新类型。
 *
 * @module dsh-writing-canvas/types/registry
 */

/** id → 类型定义。 */
const registered = new Map();

/** 类型集合变化时的订阅者。 */
const listeners = new Set();

/** 通知所有订阅者类型集合已变化。 */
function notifyChanged() {
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch {
      // 单个订阅者出错不能影响注册流程本身。
    }
  }
}

/**
 * 订阅"类型集合发生变化"。
 *
 * 为什么需要：写作类型是**独立的插件行**，加载顺序在核心之后，而系统提示段是
 * 核心注册的。没有通知机制，提示段就会永远停在"没有启用任何写作类型"。
 *
 * @param listener - 变化回调。
 * @returns 取消订阅函数。
 */
export function onTypesChanged(listener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * 校验并登记一个写作类型。
 * @param definition - 类型定义。
 * @returns 注销函数。
 */
export function registerType(definition) {
  if (definition === null || typeof definition !== 'object') {
    throw new Error('写作类型定义必须是对象');
  }
  const { id, label } = definition;
  if (typeof id !== 'string' || id === '') throw new Error('写作类型必须有非空的 id');
  if (typeof label !== 'string' || label === '') throw new Error(`写作类型 ${id} 必须有非空的 label`);
  if (registered.has(id)) throw new Error(`写作类型 id 重复：${id}`);
  registered.set(id, definition);
  notifyChanged();
  return () => {
    registered.delete(id);
    notifyChanged();
  };
}

/**
 * 列出全部已启用的写作类型，按 order 升序。
 * @returns 类型定义数组。
 */
export function listTypes() {
  return [...registered.values()].sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
}

/**
 * 按 id 取类型。
 * @param id - 类型 id。
 * @returns 类型定义或 undefined。
 */
export function getType(id) {
  return registered.get(id);
}

/**
 * 面向第三方插件的服务对象。
 *
 * 核心半体会尝试用 `ctx.reflect.provide('writingCanvasTypes', writingCanvasTypes)`
 * 把它挂到 ctx 上，其它包即可通过 `ctx.inject(['writingCanvasTypes'], ...)` 注册类型。
 */
export const writingCanvasTypes = {
  register: registerType,
  list: listTypes,
  get: getType,
};
