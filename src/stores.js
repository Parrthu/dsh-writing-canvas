/**
 * 共享的文档存储工厂。
 *
 * 路由层（浏览器界面用）与工具层（Agent 用）必须落在**同一批 DocumentStore 实例**上，
 * 否则每个文档的写入串行链会各自为政，并发写就可能写坏版本索引。
 *
 * @module dsh-writing-canvas/stores
 */

import { DocumentStore } from './store.js';

/**
 * 创建一个按工作区缓存的存储工厂。
 * @param config - 已解析配置（需要 stateDir）。
 * @returns (workspacePath) => DocumentStore
 */
export function createStoreRegistry(config) {
  const stores = new Map();
  return (workspacePath) => {
    let store = stores.get(workspacePath);
    if (store === undefined) {
      store = new DocumentStore(workspacePath, config.stateDir);
      stores.set(workspacePath, store);
    }
    return store;
  };
}
