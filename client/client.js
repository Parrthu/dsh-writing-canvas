/**
 * dsh-writing-canvas · 客户端半体（Browser half）· Release 0.2.0-rc.2
 *
 * 这是一个**零构建**的客户端 bundle：宿主 dsh-client-modules 直接读取
 * package.json 的 exports["./client"] 并把本文件作为该包的浏览器半体提供
 * （路由 /plugins/dsh-writing-canvas/client.js）。文件本身就是产物。
 *
 * 因此本文件不写 import，而是使用宿主提供的 __ModuleLoader__ 工厂协议；
 * 可 require 的模块仅限 Release 0.2.0-rc.2 的平台基线表：
 *   react · react/jsx-runtime · react-dom · react-dom/client
 *   @deepseek-ai/cordis · dsh-client-store · dsh-client-ui-slots
 *   dsh-client-ui-primitives · dsh-client-ui-dockkit
 *
 * 界面入口（官方契约）：
 *   - sidebar.panellist 列表：放 { id, order, label } + 图标组件
 *   - main 键控槽：用**同一个 id** 注册整页组件
 * 二者配对后，侧边栏点击该 id 即切换到我们的整页界面。
 *
 * @module dsh-writing-canvas/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-writing-canvas',
  factory: (require) => {
    const React = require('react');
    const h = React.createElement;

    /** 面板 id：sidebar.panellist 与 main 必须使用同一个 id 才能配对。 */
    const PANEL_ID = 'writing-canvas';

    /** 宿主 API 前缀，与 src/index.js 的 API_PREFIX 保持一致。 */
    const API_BASE = '/writing-canvas/api';

    /** P0 阶段界面用到的样式（全部走当前 Release 的主题 token）。 */
    const CSS = `
.wcv-root {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  min-height: 0;
  padding-top: var(--dsh-frame-top-clearance, 48px);
  background: var(--dsw-alias-bg-base, #ffffff);
  color: var(--dsw-alias-label-primary, #1a1a1a);
  font-size: 14px;
}
.wcv-header {
  display: flex;
  align-items: baseline;
  gap: 10px;
  padding: 14px 20px 12px;
  border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.28));
}
.wcv-title { font-size: 17px; font-weight: 700; }
.wcv-sub { font-size: 12px; color: var(--dsw-alias-label-secondary, #6b6b6b); }
.wcv-pill {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 9px;
  border-radius: 999px;
  border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.28));
  font-size: 12px;
  color: var(--dsw-alias-label-secondary, #6b6b6b);
}
.wcv-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--dsw-alias-state-idle-primary, #9aa0a6); }
.wcv-dot[data-state="ok"] { background: var(--dsw-alias-state-success-primary, #1a9c53); }
.wcv-dot[data-state="error"] { background: var(--dsw-alias-state-error-primary, #d93025); }
.wcv-body {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: 216px minmax(0, 1fr) 260px;
}
.wcv-col { min-height: 0; display: flex; flex-direction: column; }
.wcv-col + .wcv-col { border-left: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.28)); }
.wcv-colHead {
  padding: 10px 14px 6px;
  font-size: 12px;
  font-weight: 600;
  color: var(--dsw-alias-label-secondary, #6b6b6b);
  letter-spacing: 0.3px;
}
.wcv-colBody { flex: 1; min-height: 0; overflow: auto; padding: 0 12px 14px; }
.wcv-type {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 9px;
  border-radius: 7px;
  font-size: 13px;
  color: var(--dsw-alias-label-secondary, #6b6b6b);
}
.wcv-type[data-active="true"] {
  background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,0.12));
  color: var(--dsw-alias-label-primary, #1a1a1a);
  font-weight: 600;
}
.wcv-tag {
  margin-left: auto;
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 999px;
  border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.28));
}
.wcv-canvasWrap { flex: 1; min-height: 0; display: flex; flex-direction: column; padding: 0 16px 14px; }
.wcv-note {
  margin: 0 16px 10px;
  padding: 8px 11px;
  border-radius: 8px;
  font-size: 12px;
  line-height: 1.6;
  color: var(--dsw-alias-label-secondary, #6b6b6b);
  background: var(--dsw-alias-bg-layer-1, rgba(128,128,128,0.07));
  border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.22));
}
.wcv-editor {
  flex: 1;
  min-height: 0;
  width: 100%;
  box-sizing: border-box;
  resize: none;
  padding: 18px 20px;
  border-radius: 10px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.4));
  background: var(--dsw-alias-bg-layer-1, rgba(128,128,128,0.05));
  color: inherit;
  font-family: inherit;
  font-size: 15px;
  line-height: 1.85;
  outline: none;
}
.wcv-editor:focus { border-color: var(--dsw-alias-brand-primary, #4d6bfe); }
.wcv-empty { padding: 10px 2px; font-size: 12.5px; line-height: 1.8; color: var(--dsw-alias-label-secondary, #6b6b6b); }
.wcv-kv { display: flex; gap: 8px; font-size: 12px; padding: 3px 0; }
.wcv-kv > span:first-child { color: var(--dsw-alias-label-secondary, #6b6b6b); min-width: 92px; }
.wcv-kv > span:last-child { word-break: break-all; }
`;

    /** 注入样式（模块体副作用，仅在 bundle 首次 materialize 时执行）。 */
    function insertStyles() {
      if (document.querySelector('style[data-dsh-writing-canvas]') !== null) return () => {};
      const el = document.createElement('style');
      el.dataset.dshWritingCanvas = '';
      el.textContent = CSS;
      document.head.appendChild(el);
      return () => el.remove();
    }

    /**
     * 侧边栏入口图标（一支笔）。
     * 官方 owner props 契约：{ size: number, active: boolean }。
     * 选中态的配色由 sidebar 外壳负责，这里只遵守尺寸，并透出 active 供样式挂钩。
     */
    function PanelIcon(props) {
      const size =
        props !== null && typeof props === 'object' && typeof props.size === 'number' && props.size > 0
          ? props.size
          : 17;
      const active = props !== null && typeof props === 'object' && props.active === true;
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.8,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'data-active': active ? 'true' : 'false',
          'aria-hidden': 'true',
        },
        h('path', { d: 'M12 20h9' }),
        h('path', { d: 'M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z' }),
      );
    }

    /** P0 阶段先列出规划中的写作类型；P2 改为由写作类型插件提供。 */
    const PLANNED_TYPES = [
      { id: 'creative', label: '创意写作', phase: 'P2' },
      { id: 'gongwen', label: '公文写作', phase: 'P2' },
      { id: 'video-script', label: '视频文案', phase: 'P2' },
      { id: 'xiaohongshu', label: '小红书文案', phase: 'P2' },
      { id: 'news', label: '新闻写作', phase: 'P2' },
    ];

    /** 写作工作台整页组件。 */
    function WritingCanvasPanel() {
      const [health, setHealth] = React.useState(null);
      const [error, setError] = React.useState(null);
      const [draft, setDraft] = React.useState('');

      React.useEffect(() => {
        let cancelled = false;
        fetch(`${API_BASE}/health`, { headers: { accept: 'application/json' } })
          .then((response) => (response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`))))
          .then((value) => {
            if (!cancelled) {
              setHealth(value);
              setError(null);
            }
          })
          .catch((cause) => {
            if (!cancelled) setError(String(cause));
          });
        return () => {
          cancelled = true;
        };
      }, []);

      const state = error !== null ? 'error' : health !== null ? 'ok' : 'pending';
      const stateText =
        error !== null ? '宿主未连通' : health !== null ? '宿主已连通' : '正在连接宿主…';

      return h(
        'div',
        { className: 'wcv-root' },
        h(
          'div',
          { className: 'wcv-header' },
          h('div', { className: 'wcv-title' }, '写作工作台'),
          h('div', { className: 'wcv-sub' }, 'dsh-writing-canvas · 阶段 P0 骨架'),
          h(
            'div',
            { className: 'wcv-pill' },
            h('span', { className: 'wcv-dot', 'data-state': state }),
            stateText,
          ),
        ),
        h(
          'div',
          { className: 'wcv-body' },
          // 左：写作类型
          h(
            'div',
            { className: 'wcv-col' },
            h('div', { className: 'wcv-colHead' }, '写作类型'),
            h(
              'div',
              { className: 'wcv-colBody' },
              ...PLANNED_TYPES.map((type) =>
                h(
                  'div',
                  { className: 'wcv-type', key: type.id, 'data-active': type.id === 'creative' ? 'true' : 'false' },
                  type.label,
                  h('span', { className: 'wcv-tag' }, type.phase),
                ),
              ),
              h(
                'div',
                { className: 'wcv-empty' },
                'P2 起这些类型由各自的写作类型插件提供，可单独启用/停用，并各自携带专属的强约束与格式规格。',
              ),
            ),
          ),
          // 中：Canvas
          h(
            'div',
            { className: 'wcv-col' },
            h('div', { className: 'wcv-colHead' }, '正文'),
            h(
              'div',
              { className: 'wcv-note' },
              'P0 临时状态：这个框可以真实输入，但内容只存在于当前页面内存，刷新即丢失。',
              ' P1 会把它接到文档存储上，届时自动保存、不可变版本与批注都会真实生效。',
            ),
            h(
              'div',
              { className: 'wcv-canvasWrap' },
              h('textarea', {
                className: 'wcv-editor',
                value: draft,
                spellCheck: false,
                placeholder: '在这里开始写，或让 Agent 把草稿写进这份文档……',
                onChange: (event) => setDraft(event.target.value),
              }),
            ),
          ),
          // 右：版本历史 + 宿主状态
          h(
            'div',
            { className: 'wcv-col' },
            h('div', { className: 'wcv-colHead' }, '版本历史'),
            h(
              'div',
              { className: 'wcv-colBody' },
              h('div', { className: 'wcv-empty' }, 'P1 接入：每次写入都会生成一个不可变版本，可查看差异与还原。'),
            ),
            h('div', { className: 'wcv-colHead' }, '宿主状态'),
            h(
              'div',
              { className: 'wcv-colBody' },
              error !== null
                ? h('div', { className: 'wcv-empty' }, `连接失败：${error}`)
                : health === null
                  ? h('div', { className: 'wcv-empty' }, '读取中…')
                  : h(
                      'div',
                      null,
                      h('div', { className: 'wcv-kv' }, h('span', null, '插件'), h('span', null, String(health.plugin))),
                      h('div', { className: 'wcv-kv' }, h('span', null, '目标 Release'), h('span', null, String(health.release))),
                      h('div', { className: 'wcv-kv' }, h('span', null, '状态目录'), h('span', null, String(health.stateDir))),
                      h('div', { className: 'wcv-kv' }, h('span', null, '约束段'), h('span', null, String(health.constraintsSection))),
                    ),
            ),
          ),
        ),
      );
    }

    /** Cordis 依赖：等待 slots 服务就绪。 */
    const inject = ['slots'];

    /**
     * 客户端半体入口。
     * @param ctx - 浏览器侧 Cordis 上下文。
     */
    function apply(ctx) {
      const disposeStyles = insertStyles();

      // 侧边栏全局面板入口：id 必须与 main 的 key 一致。
      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register(
          { name: 'sidebar.panellist', id: PANEL_ID, order: 30, label: '写作工作台' },
          PanelIcon,
        ),
      );

      // 整页界面：占据中央主区域。
      ctx.slots.inject('main', () =>
        ctx.slots.register({ name: 'main', key: PANEL_ID }, WritingCanvasPanel),
      );

      ctx.effect(() => disposeStyles, 'writing-canvas: 客户端样式');
    }

    // 模拟 ESM 命名空间，供宿主按 apply / inject 读取。
    const exports = {};
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
    exports.apply = apply;
    exports.inject = inject;
    return exports;
  },
});
