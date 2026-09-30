/**
 * 共享的存储工厂。
 *
 * 路由层（浏览器界面用）与工具层（Agent 用）必须落在**同一批实例**上，
 * 否则每个文档的写入串行链会各自为政，并发写就可能写坏版本索引。
 *
 * @module dsh-writing-canvas/stores
 */

import { AnnotationStore } from './annotations.js';
import { WorkspaceLibrary } from './library.js';
import { DocumentStore } from './store.js';
import { SuggestionStore } from './suggestions.js';

/**
 * 创建工作区维度的存储工厂。
 * @param config - 已解析配置（需要 stateDir）。
 * @returns { storeFor, annotationsFor, suggestionsFor }
 */
export function createStoreRegistry(config) {
  const documents = new Map();
  const annotations = new Map();
  const suggestions = new Map();
  const libraries = new Map();

  return {
    /**
     * 取某工作区的文档存储。
     * @param workspacePath - 工作区绝对路径。
     * @returns DocumentStore
     */
    storeFor(workspacePath) {
      let store = documents.get(workspacePath);
      if (store === undefined) {
        store = new DocumentStore(workspacePath, config.stateDir);
        documents.set(workspacePath, store);
      }
      return store;
    },

    /**
     * 取某工作区的批注存储。
     * @param workspacePath - 工作区绝对路径。
     * @returns AnnotationStore
     */
    annotationsFor(workspacePath) {
      let store = annotations.get(workspacePath);
      if (store === undefined) {
        store = new AnnotationStore(workspacePath, config.stateDir);
        annotations.set(workspacePath, store);
      }
      return store;
    },

    /**
     * 取某工作区的修改建议存储。
     * @param workspacePath - 工作区绝对路径。
     * @returns SuggestionStore
     */
    suggestionsFor(workspacePath) {
      let store = suggestions.get(workspacePath);
      if (store === undefined) {
        store = new SuggestionStore(workspacePath, config.stateDir);
        suggestions.set(workspacePath, store);
      }
      return store;
    },

    /**
     * 取某工作区的用户库（自定义格式集 + 自定义写作类型）。
     * @param workspacePath - 工作区绝对路径。
     * @returns WorkspaceLibrary
     */
    libraryFor(workspacePath) {
      let library = libraries.get(workspacePath);
      if (library === undefined) {
        library = new WorkspaceLibrary(workspacePath, config.stateDir);
        libraries.set(workspacePath, library);
      }
      return library;
    },
  };
}
