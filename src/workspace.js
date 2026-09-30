/**
 * 会话 → 工作区解析。
 *
 * 写作画布是「对话流的一部分」，所以文档归属该会话所在的工作区：
 *   - 先按 sessionId 在 workspaceRegistry 中反查所属工作区（Workspace.sessionIds）
 *   - 查不到时退回列表中的第一个工作区，保证功能不中断
 *
 * @module dsh-writing-canvas/workspace
 */

/**
 * 列出当前登记的工作区，供 API 校验寻址合法性并生成总览。
 * @param ctx - Cordis 上下文。
 * @returns [{ id, path, title }]
 */
export function createWorkspaceLister(ctx) {
  return () => {
    const registry = ctx.get('workspaceRegistry');
    if (registry === undefined || registry === null || typeof registry.list !== 'function') return [];
    try {
      return registry.list().map((workspace) => ({
        id: String(workspace.id ?? ''),
        path: workspace.path,
        title: workspace.title ?? workspace.path,
      }));
    } catch {
      return [];
    }
  };
}

/**
 * 创建一个把 sessionId 解析为工作区绝对路径的函数。
 * @param ctx - Cordis 上下文。
 * @returns async (sessionId) => workspacePath
 */
export function createWorkspaceResolver(ctx) {
  return async (sessionId) => {
    const registry = ctx.get('workspaceRegistry');
    if (registry === undefined || registry === null || typeof registry.list !== 'function') {
      throw new Error('workspaceRegistry 服务不可用，无法确定写作状态目录');
    }
    const workspaces = registry.list();
    if (!Array.isArray(workspaces) || workspaces.length === 0) {
      throw new Error('当前没有任何工作区，无法存放写作状态');
    }

    if (typeof sessionId === 'string' && sessionId !== '') {
      for (const workspace of workspaces) {
        try {
          const ids = workspace.sessionIds;
          if (Array.isArray(ids) && ids.includes(sessionId)) return workspace.path;
        } catch {
          // 单个工作区读取失败不影响整体解析，继续尝试下一个。
        }
      }
    }

    return workspaces[0].path;
  };
}
