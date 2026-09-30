/**
 * dsh-writing-canvas · 客户端半体（Browser half）· Release 0.2.0-rc.2
 *
 * 这是一个**零构建**的客户端 bundle：宿主 dsh-client-modules 直接读取
 * package.json 的 exports["./client"] 并把本文件作为该包的浏览器半体提供。
 * 文件本身就是产物。
 *
 * 因此不写 import，而使用宿主提供的 __ModuleLoader__ 工厂协议。可 require 的
 * 模块仅限 Release 0.2.0-rc.2 的平台基线表：
 *   react · react/jsx-runtime · react-dom · react-dom/client
 *   @deepseek-ai/cordis · dsh-client-store · dsh-client-ui-slots
 *   dsh-client-ui-primitives · dsh-client-ui-dockkit
 *
 * 同一份 Canvas 以两种形态存在：
 *   形态 A · 对话旁常驻画布
 *     - 标签页类型注册进 ctx.sidebarRightTabs（kind = writing-canvas）
 *     - body 注册进 sidebar.right.pane.tab
 *     - keepMounted: true → 官方语义是「跨标签页/会话切换、折叠、停靠都保留 body」
 *     - 每个会话一份文档，所以它天然跟着对话流走
 *   形态 B · 工作台整页
 *     - sidebar.panellist 入口 + main 键 writing-canvas 整页
 *     - 跨会话浏览/编辑工作区内的文档
 *
 * @module dsh-writing-canvas/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-writing-canvas',
  factory: (require) => {
    const React = require('react');
    const h = React.createElement;

    /** 工作台整页面板的 id：sidebar.panellist 与 main 必须使用同一个 id。 */
    const PANEL_ID = 'writing-canvas';
    /** 右栏标签页的 kind（按 kind 打开）与注册 id。 */
    const CANVAS_KIND = 'writing-canvas';
    const CANVAS_TAB_ID = 'dsh-writing-canvas';
    /** 「打开写作画布」命令的 id：导览卡片靠它显示平台快捷键。 */
    const OPEN_COMMAND_ID = 'writing.canvas';
    /** 本插件在设置页列表里的条目 id。 */
    const PLUGIN_ID = 'dsh-writing-canvas';
    /** 宿主 API 前缀，与 src/routes.js 的 API_PREFIX 一致。 */
    const API_BASE = '/writing-canvas/api';
    /** 停止输入后多久自动保存。 */
    const AUTOSAVE_DELAY_MS = 1200;
    /**
     * 自动开启记录在 localStorage 的前缀：只尝试一次，用户手动关掉后就不再打扰。
     * 末尾带版本号：修复自动开启逻辑后升版，可让旧的失败标记自然作废。
     */
    const AUTOOPEN_KEY_PREFIX = 'dsh-writing-canvas:autoopen:v2:';
    /** 工作台当前选中文档的记忆键。 */
    const WORKBENCH_SELECTION_KEY = 'dsh-writing-canvas:workbench-doc';

    const CSS = `
.wcv-root { box-sizing: border-box; display: flex; flex-direction: column; width: 100%; height: 100%;
  min-height: 0; background: var(--dsw-alias-bg-base, #fff); color: var(--dsw-alias-label-primary, #1a1a1a);
  font-size: 14px; }
.wcv-root--workbench { padding-top: var(--dsh-frame-top-clearance, 48px); }
.wcv-header { display: flex; align-items: baseline; gap: 10px; padding: 12px 16px 10px;
  border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.28)); flex: none; }
.wcv-root--pane .wcv-header { padding: 8px 12px; }
.wcv-title { font-size: 15px; font-weight: 700; }
.wcv-sub { font-size: 12px; color: var(--dsw-alias-label-secondary, #6b6b6b); min-width: 0;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wcv-pill { margin-left: auto; display: inline-flex; align-items: center; gap: 6px; padding: 3px 9px;
  border-radius: 999px; border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.28));
  font-size: 12px; color: var(--dsw-alias-label-secondary, #6b6b6b); flex: none; }
.wcv-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--dsw-alias-state-idle-primary, #9aa0a6); }
.wcv-dot[data-state="ok"] { background: var(--dsw-alias-state-success-primary, #1a9c53); }
.wcv-dot[data-state="busy"] { background: var(--dsw-alias-state-warn-primary, #d9822b); }
.wcv-dot[data-state="error"] { background: var(--dsw-alias-state-error-primary, #d93025); }
.wcv-body { flex: 1; min-height: 0; display: grid; grid-template-columns: 232px minmax(0, 1fr) 248px; }
.wcv-root--pane .wcv-body { grid-template-columns: minmax(0, 1fr); grid-template-rows: minmax(0, 1fr); }
.wcv-col { min-height: 0; display: flex; flex-direction: column; }
.wcv-col + .wcv-col { border-left: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.28)); }
.wcv-root--pane .wcv-col + .wcv-col { border-left: none; }
.wcv-colHead { padding: 9px 12px 5px; font-size: 11.5px; font-weight: 600; letter-spacing: 0.3px;
  color: var(--dsw-alias-label-secondary, #6b6b6b); flex: none; }
.wcv-colBody { flex: 1; min-height: 0; overflow: auto; padding: 0 10px 12px; }
.wcv-docRow { display: flex; flex-direction: column; gap: 2px; padding: 7px 9px; border-radius: 7px;
  cursor: pointer; font-size: 13px; }
.wcv-docRow:hover { background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,0.10)); }
.wcv-docRow[data-active="true"] { background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,0.14)); font-weight: 600; }
.wcv-docMeta { font-size: 11px; color: var(--dsw-alias-label-secondary, #6b6b6b); font-weight: 400;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wcv-canvasWrap { flex: 1; min-height: 0; display: flex; flex-direction: column; padding: 0 14px 10px; }
.wcv-root--pane .wcv-canvasWrap { padding: 0 10px 8px; }
.wcv-editor { flex: 1; min-height: 0; width: 100%; box-sizing: border-box; resize: none; padding: 16px 18px;
  border-radius: 10px; border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.4));
  background: var(--dsw-alias-bg-layer-1, rgba(128,128,128,0.05)); color: inherit; font-family: inherit;
  font-size: 15px; line-height: 1.85; outline: none; }
.wcv-root--pane .wcv-editor { font-size: 14px; padding: 12px 14px; }
.wcv-editor:focus { border-color: var(--dsw-alias-brand-primary, #4d6bfe); }
.wcv-banner { margin: 0 14px 8px; padding: 8px 11px; border-radius: 8px; font-size: 12px; line-height: 1.6;
  border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.24));
  background: var(--dsw-alias-bg-layer-1, rgba(128,128,128,0.07)); color: var(--dsw-alias-label-secondary, #6b6b6b); }
.wcv-banner--warn { border-color: var(--dsw-alias-state-warn-primary, #d9822b); color: var(--dsw-alias-label-primary, #1a1a1a); }
.wcv-banner--error { border-color: var(--dsw-alias-state-error-primary, #d93025); color: var(--dsw-alias-state-error-primary, #d93025); }
.wcv-actions { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 7px; }
.wcv-btn { font: inherit; font-size: 12px; padding: 3px 10px; border-radius: 6px; cursor: pointer;
  border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.4));
  background: var(--dsw-alias-bg-layer-1, rgba(128,128,128,0.06)); color: inherit; }
.wcv-btn:hover { border-color: var(--dsw-alias-brand-primary, #4d6bfe); }
.wcv-btn--primary { border-color: var(--dsw-alias-brand-primary, #4d6bfe);
  background: var(--dsw-alias-brand-primary, #4d6bfe); color: #fff; }
.wcv-ver { display: flex; flex-direction: column; gap: 1px; padding: 6px 8px; border-radius: 7px; cursor: pointer; }
.wcv-ver:hover { background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,0.10)); }
.wcv-ver[data-active="true"] { background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,0.14)); }
.wcv-verTop { display: flex; align-items: baseline; gap: 6px; font-size: 12.5px; font-weight: 600; }
.wcv-verMeta { font-size: 11px; color: var(--dsw-alias-label-secondary, #6b6b6b); }
.wcv-preview { margin: 6px 0 0; padding: 8px 10px; border-radius: 7px; font-size: 12px; line-height: 1.7;
  white-space: pre-wrap; word-break: break-word; max-height: 240px; overflow: auto;
  background: var(--dsw-alias-bg-layer-1, rgba(128,128,128,0.07));
  border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.2)); }
.wcv-empty { padding: 8px 2px; font-size: 12.5px; line-height: 1.8; color: var(--dsw-alias-label-secondary, #6b6b6b); }
.wcv-foot { flex: none; display: flex; gap: 10px; align-items: center; padding: 6px 14px;
  border-top: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.28));
  font-size: 11.5px; color: var(--dsw-alias-label-secondary, #6b6b6b); }
.wcv-typeBar { flex: none; display: flex; align-items: center; gap: 8px; padding: 7px 14px;
  border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.28)); flex-wrap: wrap; }
.wcv-root--pane .wcv-typeBar { padding: 6px 10px; }
.wcv-typeLabel { font-size: 12px; color: var(--dsw-alias-label-secondary, #6b6b6b); }
.wcv-select { font: inherit; font-size: 12.5px; padding: 3px 8px; border-radius: 6px; cursor: pointer;
  border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.4));
  background: var(--dsw-alias-bg-layer-1, rgba(128,128,128,0.06)); color: inherit; }
.wcv-select:focus { outline: none; border-color: var(--dsw-alias-brand-primary, #4d6bfe); }
.wcv-formatTag { font-size: 11.5px; padding: 2px 8px; border-radius: 999px;
  border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.28));
  color: var(--dsw-alias-label-secondary, #6b6b6b); }
.wcv-constraintList { margin: 6px 0 0; padding-left: 20px; font-size: 12px; line-height: 1.75; }
.wcv-constraintList li { margin-bottom: 3px; }
.wcv-settings { display: flex; flex-direction: column; gap: 10px; padding: 4px 2px 12px; max-width: 720px; }
.wcv-settingsTitle { font-size: 15px; font-weight: 700; }
.wcv-settingsHint { font-size: 12.5px; line-height: 1.75; color: var(--dsw-alias-label-secondary, #6b6b6b); }
.wcv-settingsRow { display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  padding: 10px 12px; border-radius: 9px;
  border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.28));
  background: var(--dsw-alias-bg-layer-1, rgba(128,128,128,0.05)); }
.wcv-settingsLabel { font-size: 13.5px; font-weight: 600; min-width: 96px; }
.wcv-keycaps { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px;
  letter-spacing: 0.5px; color: var(--dsw-alias-label-primary, #1a1a1a); min-width: 120px; }

/* ---- 格式工具栏 ---- */
.wcv-toolbar { flex: none; display: flex; align-items: center; gap: 4px; flex-wrap: wrap;
  padding: 6px 14px; border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.28)); }
.wcv-root--pane .wcv-toolbar { padding: 5px 10px; gap: 3px; }
.wcv-tool { font: inherit; font-size: 12.5px; line-height: 1; min-width: 26px; height: 26px;
  padding: 0 6px; border-radius: 6px; cursor: pointer; border: 1px solid transparent;
  background: transparent; color: var(--dsw-alias-label-secondary, #6b6b6b); }
.wcv-tool:hover { background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,0.12));
  color: var(--dsw-alias-label-primary, #1a1a1a); }
.wcv-tool[data-active="true"] { background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,0.16));
  color: var(--dsw-alias-label-primary, #1a1a1a); border-color: var(--dsw-alias-border-l2, rgba(128,128,128,0.4)); }
.wcv-tool--strong { font-weight: 700; }
.wcv-tool--italic { font-style: italic; }
.wcv-toolSep { width: 1px; height: 16px; margin: 0 3px;
  background: var(--dsw-alias-border-l1, rgba(128,128,128,0.3)); }

/* ---- 选区浮动工具条 ---- */
.wcv-float { position: absolute; z-index: 40; display: flex; align-items: center; gap: 2px;
  padding: 4px 5px; border-radius: 9px; box-shadow: 0 6px 22px rgba(0,0,0,0.16);
  background: var(--dsw-alias-bg-overlay, #fff); color: var(--dsw-alias-label-primary, #1a1a1a);
  border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.35)); }
.wcv-floatBtn { font: inherit; font-size: 12.5px; line-height: 1; height: 26px; padding: 0 8px;
  border-radius: 6px; cursor: pointer; border: none; background: transparent; color: inherit;
  white-space: nowrap; }
.wcv-floatBtn:hover { background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,0.14)); }
.wcv-floatBtn--ai { color: var(--dsw-alias-brand-primary, #4d6bfe); font-weight: 600; }

/* ---- 正文 + 批注高亮层 ---- */
.wcv-editorWrap { position: relative; flex: 1; min-height: 0; display: flex; }
.wcv-highlight { position: absolute; inset: 0; overflow: hidden; pointer-events: none;
  border: 1px solid transparent; border-radius: 10px; }
.wcv-highlightInner { white-space: pre-wrap; word-break: break-word; font-size: 15px; line-height: 1.85;
  padding: 16px 18px; color: transparent; }
.wcv-root--pane .wcv-highlightInner { font-size: 14px; padding: 12px 14px; }
.wcv-mark { background: rgba(255, 176, 32, 0.28); border-radius: 3px; color: transparent; }
.wcv-mark[data-status="resolved"] { background: rgba(26, 156, 83, 0.20); }
.wcv-mark[data-kind="ask"] { background: rgba(77, 107, 254, 0.20); }
.wcv-editor--over { position: relative; z-index: 1; background: transparent !important; }

/* ---- 撰写中 ---- */
.wcv-writing { display: inline-flex; align-items: center; gap: 7px; padding: 4px 11px;
  border-radius: 999px; font-size: 12px; font-weight: 600;
  background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,0.14));
  border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.3)); }
.wcv-writingDot { width: 6px; height: 6px; border-radius: 50%; background: var(--dsw-alias-brand-primary, #4d6bfe);
  animation: wcv-pulse 1.1s ease-in-out infinite; }
@keyframes wcv-pulse { 0%,100% { opacity: 0.25; transform: scale(0.8); } 50% { opacity: 1; transform: scale(1.15); } }

/* ---- 批注面板 ---- */
.wcv-anno { display: flex; flex-direction: column; gap: 5px; padding: 9px 10px; border-radius: 9px;
  margin-bottom: 8px; border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.26));
  background: var(--dsw-alias-bg-layer-1, rgba(128,128,128,0.05)); }
.wcv-anno[data-status="resolved"] { opacity: 0.62; }
.wcv-anno[data-status="dismissed"] { opacity: 0.45; }
.wcv-annoHead { display: flex; align-items: center; gap: 6px; font-size: 11.5px;
  color: var(--dsw-alias-label-secondary, #6b6b6b); }
.wcv-annoKind { padding: 1px 6px; border-radius: 999px; font-weight: 600;
  border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.3)); }
.wcv-annoQuote { font-size: 12px; line-height: 1.6; padding-left: 8px;
  border-left: 2px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.4));
  color: var(--dsw-alias-label-secondary, #6b6b6b); max-height: 66px; overflow: hidden; }
.wcv-annoText { font-size: 12.5px; line-height: 1.65; }
.wcv-annoLost { font-size: 11.5px; color: var(--dsw-alias-state-warn-primary, #d9822b); }
.wcv-annoThread { font-size: 12px; line-height: 1.6; padding: 6px 8px; border-radius: 6px;
  background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,0.10)); }
.wcv-annoInput { width: 100%; box-sizing: border-box; font: inherit; font-size: 12px;
  padding: 5px 7px; border-radius: 6px; resize: none;
  border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.35));
  background: var(--dsw-alias-bg-base, #fff); color: inherit; }
.wcv-annoActions { display: flex; gap: 5px; flex-wrap: wrap; }
.wcv-mini { font: inherit; font-size: 11.5px; padding: 2px 8px; border-radius: 5px; cursor: pointer;
  border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.35));
  background: transparent; color: inherit; }
.wcv-mini:hover { border-color: var(--dsw-alias-brand-primary, #4d6bfe); }
`;

    /** 注入样式（模块体副作用，仅在 bundle 首次 materialize 时执行一次）。 */
    function insertStyles() {
      if (document.querySelector('style[data-dsh-writing-canvas]') !== null) return () => {};
      const el = document.createElement('style');
      el.dataset.dshWritingCanvas = '';
      el.textContent = CSS;
      document.head.appendChild(el);
      return () => el.remove();
    }

    /** 把目标拼成查询串（要么按会话，要么按工作区+文档）。 */
    function targetQuery(target) {
      const params = new URLSearchParams();
      if (typeof target.sessionId === 'string' && target.sessionId !== '') {
        params.set('sessionId', target.sessionId);
      } else {
        if (typeof target.workspace === 'string') params.set('workspace', target.workspace);
        if (typeof target.docId === 'string') params.set('docId', target.docId);
      }
      return params;
    }

    /** 把目标拼成请求体字段。 */
    function targetBody(target) {
      if (typeof target.sessionId === 'string' && target.sessionId !== '') return { sessionId: target.sessionId };
      return { workspace: target.workspace, docId: target.docId };
    }

    /** GET 一个 JSON 接口；HTTP 错误也解析为数据返回，交由调用方判断。 */
    async function apiGet(path, params) {
      const query = params instanceof URLSearchParams ? `?${params.toString()}` : '';
      const response = await fetch(`${API_BASE}${path}${query}`, { headers: { accept: 'application/json' } });
      const data = await response.json().catch(() => null);
      return { status: response.status, ok: response.ok, data };
    }

    /** POST 一个 JSON 接口。 */
    async function apiPost(path, body) {
      const response = await fetch(`${API_BASE}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await response.json().catch(() => null);
      return { status: response.status, ok: response.ok, data };
    }

    /** 人类可读的时间。 */
    function formatTime(iso) {
      if (typeof iso !== 'string' || iso === '') return '';
      const date = new Date(iso);
      if (Number.isNaN(date.getTime())) return iso;
      const pad = (n) => String(n).padStart(2, '0');
      return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
    }

    /** 把任意值变成可安全 JSON 化的描述（Error 直接 stringify 会变成 {}）。 */
    function describe(value) {
      if (value instanceof Error) return `${value.name}: ${value.message}`;
      try {
        return JSON.parse(JSON.stringify(value));
      } catch {
        return String(value);
      }
    }

    /**
     * 把界面里的关键步骤上报给宿主，供开发时用
     * GET /writing-canvas/api/client-report 读取真实原因。
     * 上报失败绝不能影响任何功能，所以整体吞掉异常。
     */
    function report(event, detail) {
      try {
        void fetch(`${API_BASE}/client-report`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ event, detail: detail ?? null }),
        }).catch(() => {});
      } catch {
        // 忽略：诊断通道本身不允许影响功能。
      }
    }

    /** 版本来源标签。 */
    function sourceLabel(source) {
      if (source === 'agent') return 'AI';
      if (source === 'restore') return '还原';
      return '我';
    }

    /**
     * Canvas：正文编辑 + 自动保存 + 不可变版本历史 + 还原。
     *
     * 冲突策略（对应硬约束第 9 条）：保存时带上 baseVersion，若服务端已前进，
     * 宿主**拒绝写入**并返回 409；界面明确询问用户，绝不静默覆盖。
     *
     * @param props.target - { sessionId } 或 { workspace, docId }。
     * @param props.variant - 'pane'（对话旁）| 'workbench'（整页）。
     */
    function Canvas(props) {
      const target = props.target;
      const variant = props.variant ?? 'pane';
      const targetKey = JSON.stringify(target);

      const [doc, setDoc] = React.useState(null);
      const [text, setText] = React.useState('');
      const [baseVersion, setBaseVersion] = React.useState(0);
      const [status, setStatus] = React.useState('loading');
      const [message, setMessage] = React.useState(null);
      const [conflict, setConflict] = React.useState(null);
      const [viewing, setViewing] = React.useState(null);
      const [types, setTypes] = React.useState([]);
      const [showConstraints, setShowConstraints] = React.useState(false);
      const [reloadToken, setReloadToken] = React.useState(0);
      const [annotations, setAnnotations] = React.useState([]);
      const [writing, setWriting] = React.useState({ active: false, startedAt: null, note: '' });
      const [selection, setSelection] = React.useState(null);

      // 写作类型清单来自宿主（每个类型都是独立的插件行，可单独启用/停用）。
      React.useEffect(() => {
        let cancelled = false;
        apiGet('/types')
          .then(({ ok, data }) => {
            if (!cancelled && ok && Array.isArray(data?.types)) setTypes(data.types);
          })
          .catch(() => {});
        return () => {
          cancelled = true;
        };
      }, [reloadToken]);

      // 自动保存需要读到最新的输入，用 ref 避免把 effect 绑到 text 上反复重跑。
      const textRef = React.useRef('');
      textRef.current = text;
      const baseVersionRef = React.useRef(0);
      baseVersionRef.current = baseVersion;
      const dirtyRef = React.useRef(false);
      const savingRef = React.useRef(false);
      /** 正文输入框与批注高亮层：高亮层用同样的排版镜像正文，用来给批注上色。 */
      const editorRef = React.useRef(null);
      const highlightRef = React.useRef(null);
      /** 逐字呈现用的定时器，切换目标时必须清掉。 */
      const revealTimerRef = React.useRef(null);

      /** 用服务端返回的结果刷新本地状态。 */
      const applyServer = React.useCallback((data) => {
        setDoc({
          exists: data.exists !== false,
          docId: data.docId,
          workspace: data.workspace,
          meta: data.meta,
          latest: data.latest,
          versions: data.versions ?? [],
        });
        if (data.latest !== null && data.latest !== undefined) {
          setBaseVersion(data.latest.n);
          baseVersionRef.current = data.latest.n;
        }
      }, []);

      // ---- 载入 ----------------------------------------------------------
      React.useEffect(() => {
        let cancelled = false;
        setStatus('loading');
        setMessage(null);
        setConflict(null);
        setViewing(null);
        apiGet('/doc', targetQuery(target))
          .then(({ ok, data }) => {
            if (cancelled) return;
            if (!ok) throw new Error(data?.message ?? data?.error ?? '读取失败');
            applyServer(data);
            setText(data.latest?.content ?? '');
            setAnnotations(Array.isArray(data.annotations) ? data.annotations : []);
            setWriting(data.writing ?? { active: false, startedAt: null, note: '' });
            dirtyRef.current = false;
            setStatus('ready');
            report('canvas:loaded', {
              variant,
              docId: data.docId,
              exists: data.exists,
              version: data.latest?.n ?? 0,
            });
          })
          .catch((error) => {
            if (cancelled) return;
            setStatus('error');
            setMessage(`读取文档失败：${String(error)}`);
          });
        return () => {
          cancelled = true;
        };
      }, [targetKey, applyServer, reloadToken]);

      /** 清掉正在跑的逐字呈现动画。 */
      const stopReveal = React.useCallback(() => {
        if (revealTimerRef.current !== null) {
          clearInterval(revealTimerRef.current);
          revealTimerRef.current = null;
        }
      }, []);

      /**
       * 把新内容呈现出来：如果是在旧内容尾巴上追加（AI 分段写作的典型形态），
       * 就逐字揭示，做出「正在写」的观感；否则直接替换。
       */
      const revealContent = React.useCallback(
        (next) => {
          const previous = textRef.current;
          stopReveal();
          if (typeof next !== 'string') return;
          if (previous !== '' && next.startsWith(previous) && next.length > previous.length) {
            let cursor = previous.length;
            const step = Math.max(1, Math.ceil((next.length - previous.length) / 80));
            revealTimerRef.current = setInterval(() => {
              cursor = Math.min(next.length, cursor + step);
              setText(next.slice(0, cursor));
              if (cursor >= next.length) stopReveal();
            }, 16);
            return;
          }
          setText(next);
        },
        [stopReveal],
      );

      React.useEffect(() => stopReveal, [stopReveal]);

      /**
       * 订阅宿主的事件流。
       *
       * 这是「AI 一边写、画布一边长出来」的关键：宿主每次落盘都会推 doc-changed，
       * 我们据此拉取新版本。用户正在编辑时**不覆盖**他的内容，只提示有新版。
       */
      React.useEffect(() => {
        if (typeof EventSource !== 'function') return undefined;
        const query = targetQuery(target);
        const source = new EventSource(`${API_BASE}/events?${query.toString()}`);
        let disposed = false;

        const refresh = async () => {
          const { ok, data } = await apiGet('/doc', targetQuery(target));
          if (disposed || !ok) return;
          applyServer(data);
          setAnnotations(Array.isArray(data.annotations) ? data.annotations : []);
          setWriting(data.writing ?? { active: false, startedAt: null, note: '' });
          if (dirtyRef.current) {
            setMessage('AI 刚写入了新版本，但你本地还有未保存的改动，所以没有自动替换。');
            return;
          }
          revealContent(data.latest?.content ?? '');
        };

        source.onmessage = (event) => {
          let payload = null;
          try {
            payload = JSON.parse(event.data);
          } catch {
            return;
          }
          if (payload?.type === 'doc-changed') void refresh();
          else if (payload?.type === 'writing') {
            setWriting({
              active: payload.active === true,
              startedAt: payload.startedAt ?? null,
              note: payload.note ?? '',
            });
          } else if (payload?.type === 'annotations-changed') {
            void apiGet('/annotations', targetQuery(target)).then(({ ok, data }) => {
              if (!disposed && ok) setAnnotations(data.annotations ?? []);
            });
          }
        };
        source.onerror = () => {
          // EventSource 会自动重连，这里不额外处理，避免制造噪音。
        };

        return () => {
          disposed = true;
          source.close();
          report('sse:closed', { docId: target.docId ?? null });
        };
      }, [targetKey, applyServer, revealContent]);

      /**
       * 对当前选区应用 Markdown 格式。
       * @param kind - 格式种类。
       */
      const applyFormat = (kind) => {
        const el = editorRef.current;
        const start = el === null ? 0 : el.selectionStart;
        const end = el === null ? 0 : el.selectionEnd;
        const next = transformSelection(textRef.current, start, end, kind);
        setText(next.value);
        dirtyRef.current = true;
        setStatus('dirty');
        // 光标位置要在 React 提交之后再设，否则会被 value 覆盖掉。
        requestAnimationFrame(() => {
          const node = editorRef.current;
          if (node === null) return;
          node.focus();
          node.setSelectionRange(next.start, next.end);
        });
      };

      /** 选区变化时更新浮动工具条的位置与内容。 */
      const syncSelection = () => {
        const el = editorRef.current;
        if (el === null) {
          setSelection(null);
          return;
        }
        const start = el.selectionStart;
        const end = el.selectionEnd;
        if (end <= start) {
          setSelection(null);
          return;
        }
        const point = measureCaret(highlightRef.current, start);
        setSelection({
          start,
          end,
          text: textRef.current.slice(start, end),
          top: point?.top ?? 0,
          left: point?.left ?? 0,
        });
      };

      /** 新建批注（用户在浮动工具条上选了一个 AI 动作或「批注」）。 */
      const addAnnotation = async (kind, instruction, quote, range) => {
        try {
          const { ok, data } = await apiPost('/annotations', {
            ...targetBody(target),
            kind,
            instruction,
            quote,
            range,
            author: 'user',
            anchorVersion: baseVersionRef.current,
          });
          if (!ok || data?.ok !== true) throw new Error(data?.error ?? '创建失败');
          setAnnotations(data.annotations ?? []);
          setMessage(`已记下批注（${ANNOTATION_KIND_LABEL[kind] ?? kind}）。在对话里说一句「处理画布上的批注」，AI 就会读到它。`);
          report('annotation:created', { kind, length: quote.length });
        } catch (error) {
          setStatus('error');
          setMessage(`创建批注失败：${String(error)}`);
        }
      };

      /** 更新批注（回复 / 标记已处理 / 忽略）。 */
      const updateAnnotation = async (id, patch) => {
        try {
          const { ok, data } = await apiPost('/annotations/update', { ...targetBody(target), id, ...patch });
          if (!ok) throw new Error(data?.error ?? '更新失败');
          setAnnotations(data.annotations ?? []);
        } catch (error) {
          setStatus('error');
          setMessage(`更新批注失败：${String(error)}`);
        }
      };

      /** 删除批注。 */
      const deleteAnnotation = async (id) => {
        try {
          const { ok, data } = await apiPost('/annotations/delete', { ...targetBody(target), id });
          if (!ok) throw new Error(data?.error ?? '删除失败');
          setAnnotations(data.annotations ?? []);
        } catch (error) {
          setStatus('error');
          setMessage(`删除批注失败：${String(error)}`);
        }
      };

      /** 选定写作类型（写入文档元信息，不产生正文版本）。 */
      const chooseType = async (typeId) => {
        setStatus('saving');
        try {
          const { ok, data } = await apiPost('/doc/type', { ...targetBody(target), typeId });
          if (!ok || data?.ok !== true) {
            throw new Error(data?.message ?? data?.error ?? '设定失败');
          }
          const label = data.writingType === null ? null : data.label;
          const mustConfirm = Array.isArray(data.mustConfirm) ? data.mustConfirm : [];
          setMessage(
            label === null
              ? '已清空写作类型。'
              : `已设为「${label}」。${
                  mustConfirm.length > 0 ? `生成正文前需确认：${mustConfirm.join('、')}。` : ''
                }`,
          );
          setShowConstraints(false);
          setReloadToken((n) => n + 1);
          setStatus('ready');
          report('type:set', { typeId, label });
        } catch (error) {
          setStatus('error');
          setMessage(`设定写作类型失败：${String(error)}`);
        }
      };

      // ---- 保存 ----------------------------------------------------------
      const save = React.useCallback(
        async (options = {}) => {
          if (savingRef.current) return;
          savingRef.current = true;
          setStatus('saving');
          try {
            const { status: httpStatus, data } = await apiPost('/doc', {
              ...targetBody(target),
              content: textRef.current,
              baseVersion: baseVersionRef.current,
              source: options.source ?? 'user',
              note: options.note ?? '',
              force: options.force === true,
            });

            if (httpStatus === 409 && data?.conflict === true) {
              setConflict({ latest: data.latest, versions: data.versions ?? [], meta: data.meta });
              setDoc((current) => (current === null ? current : { ...current, versions: data.versions ?? current.versions }));
              setMessage(`服务端已更新到 v${data.latest.n}，你的编辑基于 v${baseVersionRef.current}。`);
              setStatus('ready');
              return;
            }
            if (!data || data.ok !== true) {
              throw new Error(data?.message ?? data?.error ?? `HTTP ${httpStatus}`);
            }
            applyServer({ ...data, exists: true });
            setConflict(null);
            dirtyRef.current = false;
            setMessage(data.unchanged === true ? '内容未变化，未生成新版本。' : `已保存为 v${data.latest.n}。`);
            setStatus('ready');
          } catch (error) {
            setStatus('error');
            setMessage(`保存失败：${String(error)}`);
          } finally {
            savingRef.current = false;
          }
        },
        [targetKey, applyServer],
      );

      // ---- 自动保存（停止输入后）------------------------------------------
      React.useEffect(() => {
        if (status !== 'dirty') return undefined;
        const timer = setTimeout(() => {
          void save();
        }, AUTOSAVE_DELAY_MS);
        return () => clearTimeout(timer);
      }, [text, status, save]);

      /** 输入处理：内容变了才标记为待保存。 */
      const onChange = (event) => {
        const next = event.target.value;
        setText(next);
        const latestContent = doc?.latest?.content ?? '';
        if (next !== latestContent) {
          dirtyRef.current = true;
          setStatus('dirty');
        } else {
          dirtyRef.current = false;
          setStatus('ready');
        }
      };

      // ---- 还原 ----------------------------------------------------------
      const restore = async (n) => {
        setStatus('saving');
        try {
          const { ok, data } = await apiPost('/doc/restore', { ...targetBody(target), n });
          if (!ok || data?.ok !== true) throw new Error(data?.message ?? data?.error ?? '还原失败');
          applyServer({ ...data, exists: true });
          setText(data.latest.content);
          setViewing(null);
          setConflict(null);
          setMessage(`已还原 v${n}，并记为 v${data.latest.n}（历史保持完整）。`);
          setStatus('ready');
        } catch (error) {
          setStatus('error');
          setMessage(`还原失败：${String(error)}`);
        }
      };

      // ---- 渲染 ----------------------------------------------------------
      const state = status === 'error' ? 'error' : status === 'saving' ? 'busy' : status === 'dirty' ? 'busy' : 'ok';
      const stateText =
        status === 'loading'
          ? '读取中…'
          : status === 'saving'
            ? '保存中…'
            : status === 'dirty'
              ? '未保存'
              : status === 'error'
                ? '出错'
                : doc?.exists === false
                  ? '新文档'
                  : `v${baseVersion}`;

      const versions = doc?.versions ?? [];
      const title = doc?.meta?.title ?? (doc?.exists === false ? '未命名文档' : '写作画布');
      const currentTypeId = doc?.meta?.writingType ?? '';
      const currentType = types.find((type) => type.id === currentTypeId);

      return h(
        'div',
        { className: `wcv-root wcv-root--${variant}` },
        h(
          'div',
          { className: 'wcv-header' },
          h('div', { className: 'wcv-title' }, variant === 'pane' ? '写作画布' : '写作工作台'),
          h('div', { className: 'wcv-sub' }, variant === 'pane' ? title : `${title} · ${doc?.workspace ?? ''}`),
          props.headerExtra === undefined ? null : props.headerExtra(),
          h('div', { className: 'wcv-pill' }, h('span', { className: 'wcv-dot', 'data-state': state }), stateText),
        ),

        conflict !== null
          ? h(
              'div',
              { className: 'wcv-banner wcv-banner--warn' },
              `冲突：服务端已经是 v${conflict.latest?.n}，你的编辑基于 v${baseVersion}。`,
              h(
                'div',
                null,
                '为避免静默覆盖，宿主拒绝写入。请选择：',
              ),
              h(
                'div',
                { className: 'wcv-actions' },
                h(
                  'button',
                  {
                    className: 'wcv-btn wcv-btn--primary',
                    onClick: () => void save({ force: true, note: '用户选择覆盖服务端新版本' }),
                  },
                  '用我的版本覆盖',
                ),
                h(
                  'button',
                  {
                    className: 'wcv-btn',
                    onClick: () => {
                      setText(conflict.latest?.content ?? '');
                      setBaseVersion(conflict.latest?.n ?? 0);
                      baseVersionRef.current = conflict.latest?.n ?? 0;
                      setConflict(null);
                      setMessage('已载入服务端最新版本，你的本地修改已丢弃。');
                      setStatus('ready');
                    },
                  },
                  '放弃我的修改',
                ),
              ),
            )
          : null,

        message !== null
          ? h('div', { className: `wcv-banner${status === 'error' ? ' wcv-banner--error' : ''}` }, message)
          : null,

        // 写作类型选择条：用户可以直接指定文种，Agent 也能通过工具读到这里的选择。
        h(
          'div',
          { className: 'wcv-typeBar' },
          h('span', { className: 'wcv-typeLabel' }, '写作类型'),
          h(
            'select',
            {
              className: 'wcv-select',
              value: currentTypeId,
              onChange: (event) => void chooseType(event.target.value),
            },
            h('option', { value: '' }, '未指定'),
            ...types.map((type) => h('option', { key: type.id, value: type.id }, type.label)),
          ),
          currentType !== undefined
            ? h(
                'span',
                { className: 'wcv-formatTag' },
                currentType.format?.kind === 'docx'
                  ? `DOCX · ${currentType.format.spec ?? '未命名规格'}`
                  : 'Markdown',
              )
            : null,
          currentType !== undefined && (currentType.constraints?.length ?? 0) > 0
            ? h(
                'button',
                { className: 'wcv-btn', onClick: () => setShowConstraints((v) => !v) },
                showConstraints ? '收起硬约束' : `查看硬约束（${currentType.constraints.length}）`,
              )
            : null,
          types.length === 0
            ? h('span', { className: 'wcv-formatTag' }, '尚未启用任何写作类型插件')
            : null,
        ),

        showConstraints && currentType !== undefined
          ? h(
              'div',
              { className: 'wcv-banner' },
              (currentType.mustConfirm?.length ?? 0) > 0
                ? h('div', null, `生成前必须确认：${currentType.mustConfirm.join('、')}`)
                : null,
              h(
                'ol',
                { className: 'wcv-constraintList' },
                ...(currentType.constraints ?? []).map((item, index) => h('li', { key: index }, item)),
              ),
            )
          : null,

        h(
          'div',
          { className: 'wcv-body' },
          variant === 'workbench' && props.renderDocs !== undefined ? props.renderDocs() : null,

          h(
            'div',
            { className: 'wcv-col' },
            variant === 'workbench' ? h('div', { className: 'wcv-colHead' }, '正文') : null,

            // 格式工具栏：与豆包一致，工具条压在正文上方。
            h(
              'div',
              { className: 'wcv-toolbar' },
              ...[
                ['h1', 'H1', '一级标题'],
                ['h2', 'H2', '二级标题'],
                ['h3', 'H3', '三级标题'],
                ['sep'],
                ['bold', 'B', '加粗'],
                ['italic', 'I', '斜体'],
                ['strike', 'S', '删除线'],
                ['code', '</>', '行内代码'],
                ['codeblock', '{ }', '代码块'],
                ['sep'],
                ['quote', '❝', '引用'],
                ['ul', '•', '无序列表'],
                ['ol', '1.', '有序列表'],
                ['sep'],
                ['link', '🔗', '链接'],
                ['hr', '—', '分隔线'],
              ].map((item, index) =>
                item[0] === 'sep'
                  ? h('span', { key: `sep${index}`, className: 'wcv-toolSep' })
                  : h(
                      'button',
                      {
                        key: item[0],
                        className: `wcv-tool${item[0] === 'bold' ? ' wcv-tool--strong' : ''}${
                          item[0] === 'italic' ? ' wcv-tool--italic' : ''
                        }`,
                        title: item[2],
                        onMouseDown: (event) => event.preventDefault(),
                        onClick: () => applyFormat(item[0]),
                      },
                      item[1],
                    ),
              ),
              writing.active
                ? h(
                    'span',
                    { className: 'wcv-writing', style: { marginLeft: 'auto' } },
                    h('span', { className: 'wcv-writingDot' }),
                    '撰写中…',
                  )
                : null,
            ),

            h(
              'div',
              { className: 'wcv-canvasWrap' },
              h(
                'div',
                { className: 'wcv-editorWrap' },
                // 批注高亮层：用相同排版镜像正文，给被批注的区间上色。
                h(
                  'div',
                  { className: 'wcv-highlight', ref: highlightRef, 'aria-hidden': 'true' },
                  h(
                    'div',
                    { className: 'wcv-highlightInner' },
                    ...buildHighlightSegments(text, annotations).map((segment, index) =>
                      segment.mark === true
                        ? h(
                            'mark',
                            {
                              key: index,
                              className: 'wcv-mark',
                              'data-status': segment.status,
                              'data-kind': segment.kind,
                            },
                            segment.text,
                          )
                        : h('span', { key: index }, segment.text),
                    ),
                  ),
                ),
                h('textarea', {
                  className: 'wcv-editor wcv-editor--over',
                  ref: editorRef,
                  value: text,
                  spellCheck: false,
                  placeholder: '在这里开始写，或让 Agent 把草稿写进这份文档……',
                  onChange,
                  onScroll: (event) => {
                    const layer = highlightRef.current;
                    if (layer !== null) layer.scrollTop = event.target.scrollTop;
                  },
                  onSelect: syncSelection,
                  onKeyUp: syncSelection,
                  onMouseUp: syncSelection,
                  onBlur: () => setSelection(null),
                }),
                // 选区浮动工具条：格式按钮 + AI 动作。
                selection !== null
                  ? h(
                      'div',
                      {
                        className: 'wcv-float',
                        style: {
                          top: `${Math.max(2, selection.top - 42)}px`,
                          left: `${Math.max(4, selection.left)}px`,
                        },
                        onMouseDown: (event) => event.preventDefault(),
                      },
                      ...['bold', 'italic', 'strike', 'code'].map((kind) =>
                        h(
                          'button',
                          {
                            key: kind,
                            className: 'wcv-floatBtn',
                            title: { bold: '加粗', italic: '斜体', strike: '删除线', code: '行内代码' }[kind],
                            onClick: () => applyFormat(kind),
                          },
                          { bold: 'B', italic: 'I', strike: 'S', code: '</>' }[kind],
                        ),
                      ),
                      h('span', { className: 'wcv-toolSep' }),
                      ...['rewrite', 'expand', 'shorten', 'polish'].map((kind) =>
                        h(
                          'button',
                          {
                            key: kind,
                            className: 'wcv-floatBtn wcv-floatBtn--ai',
                            onClick: () => {
                              const value = window.prompt(
                                `对选中内容「${ANNOTATION_KIND_LABEL[kind]}」——请写下你的要求：`,
                                '',
                              );
                              if (value === null) return;
                              void addAnnotation(kind, value, selection.text, {
                                start: selection.start,
                                end: selection.end,
                              });
                              setSelection(null);
                            },
                          },
                          ANNOTATION_KIND_LABEL[kind],
                        ),
                      ),
                      h(
                        'button',
                        {
                          className: 'wcv-floatBtn',
                          onClick: () => {
                            const value = window.prompt('批注内容：', '');
                            if (value === null) return;
                            void addAnnotation('comment', value, selection.text, {
                              start: selection.start,
                              end: selection.end,
                            });
                            setSelection(null);
                          },
                        },
                        '批注',
                      ),
                    )
                  : null,
              ),
            ),
          ),

          // 批注面板
          h(
            'div',
            { className: 'wcv-col' },
            h('div', { className: 'wcv-colHead' }, `批注（${annotations.filter((a) => a.status === 'open').length} 待处理 / ${annotations.length}）`),
            h(
              'div',
              { className: 'wcv-colBody' },
              annotations.length === 0
                ? h('div', { className: 'wcv-empty' }, '选中正文里的一段文字，就会浮出工具条：可以直接加格式，也可以让 AI 改写、扩写、缩写、润色，或留一条批注。')
                : annotations.map((annotation) =>
                    h(
                      'div',
                      { key: annotation.id, className: 'wcv-anno', 'data-status': annotation.status },
                      h(
                        'div',
                        { className: 'wcv-annoHead' },
                        h('span', { className: 'wcv-annoKind' }, ANNOTATION_KIND_LABEL[annotation.kind] ?? annotation.kind),
                        h('span', null, annotation.author === 'agent' ? 'AI' : '我'),
                        h('span', { style: { marginLeft: 'auto' } }, formatTime(annotation.createdAt)),
                      ),
                      annotation.quote !== ''
                        ? h('div', { className: 'wcv-annoQuote' }, annotation.quote)
                        : null,
                      annotation.anchorLost === true
                        ? h('div', { className: 'wcv-annoLost' }, '需重新标注：这段文字已不在正文中（正文被改过）。')
                        : null,
                      annotation.instruction !== ''
                        ? h('div', { className: 'wcv-annoText' }, annotation.instruction)
                        : null,
                      ...(Array.isArray(annotation.thread) ? annotation.thread : []).map((entry, index) =>
                        h(
                          'div',
                          { key: index, className: 'wcv-annoThread' },
                          `${entry.author === 'agent' ? 'AI' : '我'}：${entry.text}`,
                        ),
                      ),
                      annotation.status === 'open'
                        ? h(
                            'div',
                            { className: 'wcv-annoActions' },
                            h(
                              'button',
                              {
                                className: 'wcv-mini',
                                onClick: () => void updateAnnotation(annotation.id, { status: 'resolved', resolvedVersion: baseVersionRef.current }),
                              },
                              '已处理',
                            ),
                            h(
                              'button',
                              { className: 'wcv-mini', onClick: () => void updateAnnotation(annotation.id, { status: 'dismissed' }) },
                              '忽略',
                            ),
                            h('button', { className: 'wcv-mini', onClick: () => void deleteAnnotation(annotation.id) }, '删除'),
                          )
                        : h(
                            'div',
                            { className: 'wcv-annoActions' },
                            h('span', { className: 'wcv-annoHead' }, annotation.status === 'resolved' ? '已处理' : '已忽略'),
                            h('button', { className: 'wcv-mini', onClick: () => void deleteAnnotation(annotation.id) }, '删除'),
                          ),
                    ),
                  ),
            ),
          ),

          h(
            'div',
            { className: 'wcv-col' },
            h('div', { className: 'wcv-colHead' }, `版本历史（${versions.length}）`),
            h(
              'div',
              { className: 'wcv-colBody' },
              versions.length === 0
                ? h('div', { className: 'wcv-empty' }, '还没有版本。开始输入并停止片刻，就会自动生成第一个不可变版本。')
                : [...versions].reverse().map((version) =>
                    h(
                      'div',
                      { key: version.n, className: 'wcv-ver', 'data-active': viewing?.n === version.n ? 'true' : 'false' },
                      h(
                        'div',
                        {
                          className: 'wcv-verTop',
                          onClick: () => {
                            void apiGet('/doc/version', new URLSearchParams({ ...Object.fromEntries(targetQuery(target)), n: String(version.n) }))
                              .then(({ ok, data }) => {
                                if (ok) setViewing(data.version);
                              });
                          },
                        },
                        `v${version.n}`,
                        h('span', { className: 'wcv-verMeta' }, sourceLabel(version.source)),
                      ),
                      h(
                        'div',
                        { className: 'wcv-verMeta' },
                        `${formatTime(version.at)} · ${version.bytes} 字节`,
                      ),
                      viewing?.n === version.n
                        ? h(
                            'div',
                            null,
                            h('div', { className: 'wcv-preview' }, viewing.content.slice(0, 400)),
                            h(
                              'div',
                              { className: 'wcv-actions' },
                              h(
                                'button',
                                { className: 'wcv-btn', onClick: () => void restore(version.n) },
                                '还原到此版本',
                              ),
                              h('button', { className: 'wcv-btn', onClick: () => setViewing(null) }, '收起'),
                            ),
                          )
                        : null,
                    ),
                  ),
            ),
          ),
        ),

        h(
          'div',
          { className: 'wcv-foot' },
          h('span', null, `文档 ${doc?.docId ?? '—'}`),
          h('span', null, `工作区 ${doc?.workspace ?? '—'}`),
          h(
            'span',
            { style: { marginLeft: 'auto' } },
            doc?.meta?.updatedAt !== undefined ? `最近更新 ${formatTime(doc.meta.updatedAt)}` : '',
          ),
        ),
      );
    }

    /**
     * 侧边栏入口图标（一支笔）。
     * 官方 owner props 契约：{ size: number, active: boolean }。
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

    /** 右栏标签页 body：绑定当前会话的那一份文档。 */
    function CanvasTabBody(props) {
      const sessionId = props?.sessionId;
      // 用会话 id 作为 key，切换会话时强制重新挂载 Canvas，避免串内容。
      return h(Canvas, { key: String(sessionId), target: { sessionId }, variant: 'pane' });
    }

    /** 工作台整页：跨会话浏览/编辑工作区内的文档。 */
    function WorkbenchPanel(props) {
      const [index, setIndex] = React.useState(null);
      const [selected, setSelected] = React.useState(null);
      const [reloadToken, setReloadToken] = React.useState(0);

      /** 「在对话旁打开画布」按钮 —— 自动开启之外的手动兜底。 */
      const headerExtra =
        typeof props?.openBeside !== 'function'
          ? undefined
          : () =>
              h(
                'button',
                {
                  className: 'wcv-btn',
                  style: { marginLeft: '12px' },
                  onClick: () => props.openBeside('workbench'),
                },
                '在对话旁打开画布',
              );

      React.useEffect(() => {
        let cancelled = false;
        apiGet('/docs')
          .then(({ ok, data }) => {
            if (cancelled || !ok) return;
            setIndex(data);
            if (selected === null && Array.isArray(data.documents) && data.documents.length > 0) {
              let remembered = null;
              try {
                remembered = localStorage.getItem(WORKBENCH_SELECTION_KEY);
              } catch {
                remembered = null;
              }
              const match =
                remembered === null
                  ? undefined
                  : data.documents.find((d) => `${d.workspace}|${d.docId}` === remembered);
              const first = match ?? data.documents[0];
              setSelected({ workspace: first.workspace, docId: first.docId });
            }
          })
          .catch(() => {});
        return () => {
          cancelled = true;
        };
      }, [reloadToken]);

      const pick = (doc) => {
        setSelected({ workspace: doc.workspace, docId: doc.docId });
        try {
          localStorage.setItem(WORKBENCH_SELECTION_KEY, `${doc.workspace}|${doc.docId}`);
        } catch {
          // 记忆失败不影响使用。
        }
      };

      const renderDocs = () =>
        h(
          'div',
          { className: 'wcv-col' },
          h('div', { className: 'wcv-colHead' }, `工作区文档（${index?.documents?.length ?? 0}）`),
          h(
            'div',
            { className: 'wcv-colBody' },
            index === null
              ? h('div', { className: 'wcv-empty' }, '读取中…')
              : index.documents.length === 0
                ? h(
                    'div',
                    { className: 'wcv-empty' },
                    '这个工作区还没有文档。在对话旁的写作画布里写点什么，或直接点右侧开始输入，第一个版本就会出现在这里。',
                  )
                : index.documents.map((doc) =>
                    h(
                      'div',
                      {
                        key: `${doc.workspace}|${doc.docId}`,
                        className: 'wcv-docRow',
                        'data-active':
                          selected !== null && selected.docId === doc.docId && selected.workspace === doc.workspace
                            ? 'true'
                            : 'false',
                        onClick: () => pick(doc),
                      },
                      h('div', null, doc.title),
                      h('div', { className: 'wcv-docMeta' }, `${doc.workspaceTitle ?? doc.workspace}`),
                      h('div', { className: 'wcv-docMeta' }, `v${doc.latest} · ${formatTime(doc.updatedAt)}`),
                    ),
                  ),
            h(
              'div',
              { className: 'wcv-actions' },
              h('button', { className: 'wcv-btn', onClick: () => setReloadToken((n) => n + 1) }, '刷新列表'),
            ),
          ),
        );

      if (selected === null) {
        return h(
          'div',
          { className: 'wcv-root wcv-root--workbench' },
          h(
            'div',
            { className: 'wcv-header' },
            h('div', { className: 'wcv-title' }, '写作工作台'),
            h('div', { className: 'wcv-sub' }, '选择一个文档开始'),
            headerExtra === undefined ? null : headerExtra(),
          ),
          h(
            'div',
            { className: 'wcv-body' },
            renderDocs(),
            h('div', { className: 'wcv-col' }, h('div', { className: 'wcv-empty', style: { padding: '16px' } }, '左侧还没有可编辑的文档。')),
            h('div', { className: 'wcv-col' }),
          ),
        );
      }

      return h(Canvas, {
        key: `${selected.workspace}|${selected.docId}|${reloadToken}`,
        target: { workspace: selected.workspace, docId: selected.docId },
        variant: 'workbench',
        renderDocs,
        headerExtra,
      });
    }

    /**
     * 给工作台注入"在对话旁打开画布"的能力。
     * @param openBeside - 由 apply 提供的打开函数（携带 ctx）。
     * @returns 工作台面板组件。
     */
    function makeWorkbenchPanel(openBeside) {
      return function WorkbenchPanelWithActions(props) {
        return h(WorkbenchPanel, { ...props, openBeside });
      };
    }

    /**
     * 导览卡片用的彩色图标（自己画，不依赖内部 artwork 导出）。
     * 浅蓝纸张 + 蓝色文字线 + 橙色笔尖，在明暗两种主题下都能看清。
     */
    function WritingArtwork(props) {
      const size =
        props !== null && typeof props === 'object' && typeof props.size === 'number' && props.size > 0
          ? props.size
          : 20;
      return h(
        'svg',
        { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': 'true' },
        // 纸张
        h('path', {
          d: 'M6 3h8l4 4v14H6z',
          fill: '#e8f0ff',
          stroke: '#7ba7f0',
          strokeWidth: 1.2,
          strokeLinejoin: 'round',
        }),
        // 折角
        h('path', { d: 'M14 3v4h4', fill: 'none', stroke: '#7ba7f0', strokeWidth: 1.2, strokeLinejoin: 'round' }),
        // 文字线
        h('path', {
          d: 'M9 12.5h5.5M9 15.5h3.5',
          stroke: '#9dbcf5',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
        }),
        // 笔
        h('path', {
          d: 'M20.6 8.4 15 14l-2.3.7.7-2.3 5.6-5.6a1.15 1.15 0 0 1 1.6 1.6Z',
          fill: '#ffb020',
          stroke: '#e08a00',
          strokeWidth: 1.1,
          strokeLinejoin: 'round',
        }),
      );
    }

    /** 纯修饰键的 code：录制时要忽略，它们不能单独成为快捷键。 */
    const MODIFIER_CODES = [
      'ShiftLeft',
      'ShiftRight',
      'ControlLeft',
      'ControlRight',
      'AltLeft',
      'AltRight',
      'MetaLeft',
      'MetaRight',
    ];

    /** 把一次的按键事件转成物理修饰键列表（与快捷键服务的命名一致）。 */
    function modifiersOf(event) {
      const modifiers = [];
      if (event.ctrlKey) modifiers.push('control');
      if (event.altKey) modifiers.push('alt');
      if (event.shiftKey) modifiers.push('shift');
      if (event.metaKey) modifiers.push('meta');
      return modifiers;
    }

    /**
     * 生成设置页组件（需要闭包里的 ctx）。
     * @param ctx - 客户端 Cordis 上下文。
     * @returns 设置页组件。
     */
    function makeSettingsPage(ctx) {
      return function WritingSettingsPageInner() {
        const [rows, setRows] = React.useState(null);
        const [recording, setRecording] = React.useState(false);
        const [message, setMessage] = React.useState(null);
        const [preview, setPreview] = React.useState(null);

        /** 读取命令目录中我们这一条。 */
        const readRow = React.useCallback(() => {
          const shortcuts = optionalService(ctx, 'shortcuts');
          if (shortcuts === undefined || shortcuts.catalog === undefined) return null;
          const all = shortcuts.catalog.getSnapshot();
          if (!Array.isArray(all)) return null;
          return all.find((row) => row.id === OPEN_COMMAND_ID) ?? null;
        }, []);

        const refresh = React.useCallback(() => {
          setRows(readRow());
        }, [readRow]);

        // 订阅目录变化（用户在系统快捷键页改动时这里也会跟着更新）。
        React.useEffect(() => {
          refresh();
          const shortcuts = optionalService(ctx, 'shortcuts');
          const catalog = shortcuts?.catalog;
          if (catalog === undefined || typeof catalog.subscribe !== 'function') return undefined;
          return catalog.subscribe(() => refresh());
        }, [refresh]);

        /** 执行一次偏好编辑，并用**实际生效的键位**回显结果。 */
        const applyEdit = async (edit) => {
          const shortcuts = optionalService(ctx, 'shortcuts');
          if (shortcuts === undefined || typeof shortcuts.edit !== 'function') {
            setMessage('快捷键服务不可用，无法修改。');
            return;
          }
          try {
            const snapshot = typeof shortcuts.readCurrent === 'function' ? await shortcuts.readCurrent() : undefined;
            const revision = snapshot?.revision;
            const result = await shortcuts.edit(edit, revision);
            const status = result?.status ?? '未知';
            // 等一下让目录刷新，再以实际生效的键位为准回显。
            await new Promise((resolve) => setTimeout(resolve, 60));
            refresh();
            const row = readRow();
            const effective = row?.keys ?? row?.binding?.keys ?? null;
            setMessage(
              status === 'accepted' || status === 'ok' || status === 'applied'
                ? `已生效：${formatKeys(effective)}`
                : `修改未生效（服务返回 ${status}）。当前键位：${formatKeys(effective)}`,
            );
            report('shortcut:edit', { edit, status, keys: effective });
          } catch (error) {
            setMessage(`修改快捷键失败：${String(error)}`);
            report('shortcut:edit-failed', { edit, reason: describe(error) });
          }
        };

        /** 录制按键。 */
        const onKeyDown = (event) => {
          event.preventDefault();
          event.stopPropagation();
          if (event.key === 'Escape') {
            setRecording(false);
            setPreview(null);
            setMessage('已取消录制。');
            return;
          }
          if (MODIFIER_CODES.includes(event.code)) return; // 等真正的键
          const binding = { code: event.code, modifiers: modifiersOf(event) };
          if (binding.modifiers.length === 0) {
            setPreview({ binding, issue: '至少需要一个修饰键（⌘/Ctrl/Alt/Shift）。', conflicts: [] });
            return;
          }
          const shortcuts = optionalService(ctx, 'shortcuts');
          const described =
            shortcuts !== undefined && typeof shortcuts.describeBinding === 'function'
              ? shortcuts.describeBinding(binding)
              : { binding, keys: [event.code], issue: null, conflicts: [] };
          setPreview(described);
          if (described.issue !== null && described.issue !== undefined) {
            setMessage(`这个组合不可用：${described.issue}`);
            return;
          }
          const conflicts = (described.conflicts ?? []).filter((id) => id !== OPEN_COMMAND_ID);
          if (conflicts.length > 0) {
            setMessage(`这个组合与已有命令冲突：${conflicts.join('、')}。请换一个。`);
            return;
          }
          setRecording(false);
          void applyEdit({ type: 'set', id: OPEN_COMMAND_ID, binding });
        };

        const current = rows;
        const currentKeys = current?.keys ?? null;

        return h(
          'div',
          { className: 'wcv-settings' },
          h('div', { className: 'wcv-settingsTitle' }, '写作插件'),
          h(
            'div',
            { className: 'wcv-settingsHint' },
            '写作画布固定住在对话右侧，正文自动保存、可回溯版本。这里可以改打开它的快捷键。',
          ),

          h('div', { className: 'wcv-settingsRow' },
            h('div', { className: 'wcv-settingsLabel' }, '打开写作画布'),
            h('div', { className: 'wcv-keycaps' }, formatKeys(currentKeys)),
            recording
              ? h(
                  'button',
                  {
                    className: 'wcv-btn wcv-btn--primary',
                    // 自动聚焦，用户按下组合时能被这个按钮接住。
                    ref: (node) => {
                      if (node !== null && document.activeElement !== node) node.focus();
                    },
                    onKeyDown,
                    onBlur: () => {
                      setRecording(false);
                      setPreview(null);
                    },
                  },
                  '请按下组合键…（Esc 取消）',
                )
              : h(
                  'button',
                  { className: 'wcv-btn', onClick: () => { setMessage(null); setPreview(null); setRecording(true); } },
                  '录制新快捷键',
                ),
            h(
              'button',
              { className: 'wcv-btn', onClick: () => void applyEdit({ type: 'reset', id: OPEN_COMMAND_ID }) },
              '恢复默认',
            ),
          ),

          preview !== null && preview.keys !== undefined
            ? h('div', { className: 'wcv-settingsHint' }, `将设置为：${formatKeys(preview.keys)}`)
            : null,

          message !== null ? h('div', { className: 'wcv-settingsHint' }, message) : null,

          h(
            'div',
            { className: 'wcv-settingsHint' },
            '提示：自动开启只在每个会话第一次进入时尝试一次，之后你关掉它就不会再打扰；',
            '随时可以用上面的快捷键、右侧面板的「+」导览卡片，或工作台里的按钮重新打开。',
          ),
          h(
            'div',
            { className: 'wcv-settingsHint' },
            '这些键位同样会出现在「设置 → 快捷键」的统一下拉里，两处改的是同一份配置。',
          ),
        );
      };
    }

    /** 把键位数组渲染成按键胶囊。 */
    function formatKeys(keys) {
      if (!Array.isArray(keys) || keys.length === 0) return '未绑定';
      return keys.map((key) => `[${key}]`).join(' ');
    }

    /** 批注种类的中文名。 */
    const ANNOTATION_KIND_LABEL = {
      comment: '批注',
      rewrite: '改写',
      expand: '扩写',
      shorten: '缩写',
      polish: '润色',
      continue: '续写',
      ask: '提问',
    };

    /** 需要行首前缀的块级格式。 */
    const LINE_FORMATS = {
      h1: { prefix: '# ', toggle: ['# ', '## ', '### '] },
      h2: { prefix: '## ', toggle: ['# ', '## ', '### '] },
      h3: { prefix: '### ', toggle: ['# ', '## ', '### '] },
      quote: { prefix: '> ', toggle: ['> '] },
      ul: { prefix: '- ', toggle: ['- ', '* ', '1. '] },
      ol: { prefix: '1. ', toggle: ['- ', '* ', '1. '] },
    };

    /** 行内格式的包裹标记。 */
    const INLINE_FORMATS = {
      bold: '**',
      italic: '*',
      strike: '~~',
      code: '`',
    };

    /**
     * 对选区应用 Markdown 格式。
     *
     * 全部变换都是纯函数：给定文本与选区，返回新文本与新选区，
     * 这样工具栏、浮动工具条、快捷键都能复用同一套逻辑，且易于测试。
     *
     * @param value - 当前全文。
     * @param start - 选区起点。
     * @param end - 选区终点。
     * @param kind - 格式种类。
     * @returns { value, start, end }
     */
    function transformSelection(value, start, end, kind) {
      const from = Math.max(0, Math.min(start, end));
      const to = Math.min(value.length, Math.max(start, end));
      const selected = value.slice(from, to);

      // 行内格式：在选区两侧加标记；若已包裹则去掉（再次点击即取消）。
      if (Object.hasOwn(INLINE_FORMATS, kind)) {
        const marker = INLINE_FORMATS[kind];
        const before = value.slice(0, from);
        const after = value.slice(to);

        // 情况一：选区自己就把标记包了进去（用户连标记一起选中）。
        if (
          selected.length >= marker.length * 2 &&
          selected.startsWith(marker) &&
          selected.endsWith(marker)
        ) {
          const inner = selected.slice(marker.length, selected.length - marker.length);
          return { value: `${before}${inner}${after}`, start: from, end: from + inner.length };
        }

        // 情况二：标记在选区外侧。
        const alreadyWrapped = before.endsWith(marker) && after.startsWith(marker) && to > from;
        if (alreadyWrapped) {
          return {
            value: before.slice(0, before.length - marker.length) + selected + after.slice(marker.length),
            start: from - marker.length,
            end: to - marker.length,
          };
        }

        const inner = selected === '' ? '文字' : selected;
        return {
          value: `${before}${marker}${inner}${marker}${after}`,
          start: from + marker.length,
          end: from + marker.length + inner.length,
        };
      }

      // 块级格式：找到选区覆盖的整行范围，逐行加/去前缀。
      if (Object.hasOwn(LINE_FORMATS, kind)) {
        const spec = LINE_FORMATS[kind];
        const lineStart = value.lastIndexOf('\n', Math.max(0, from - 1)) + 1;
        let lineEnd = value.indexOf('\n', to);
        if (lineEnd === -1) lineEnd = value.length;
        const block = value.slice(lineStart, lineEnd);
        const lines = block.split('\n');
        const allHavePrefix = lines.every((line) => spec.prefix === '' || line.startsWith(spec.prefix));
        const nextLines = lines.map((line) => {
          const stripped = spec.toggle.reduce(
            (acc, prefix) => (acc.startsWith(prefix) ? acc.slice(prefix.length) : acc),
            line,
          );
          return allHavePrefix ? stripped : `${spec.prefix}${stripped}`;
        });
        const nextBlock = nextLines.join('\n');
        return {
          value: value.slice(0, lineStart) + nextBlock + value.slice(lineEnd),
          start: lineStart,
          end: lineStart + nextBlock.length,
        };
      }

      if (kind === 'codeblock') {
        const before = value.slice(0, from);
        const after = value.slice(to);
        const inner = selected === '' ? '代码' : selected;
        // 代码块必须自成一行：前面不是行首就补一个换行。
        const lead = before === '' || before.endsWith('\n') ? '' : '\n';
        const block = `${lead}\`\`\`\n${inner}\n\`\`\``;
        const innerStart = from + lead.length + 4;
        return { value: `${before}${block}${after}`, start: innerStart, end: innerStart + inner.length };
      }

      if (kind === 'hr') {
        const before = value.slice(0, from);
        const after = value.slice(to);
        const block = `${before.endsWith('\n') || before === '' ? '' : '\n'}---\n`;
        return { value: `${before}${block}${after}`, start: from + block.length, end: from + block.length };
      }

      if (kind === 'link') {
        const before = value.slice(0, from);
        const after = value.slice(to);
        const text = selected === '' ? '链接文字' : selected;
        const block = `[${text}](url)`;
        return { value: `${before}${block}${after}`, start: from + text.length + 3, end: from + text.length + 6 };
      }

      return { value, start: from, end: to };
    }

    /**
     * 在被批注的区间两侧插入高亮标记，用于「批注高亮层」。
     * @param content - 正文。
     * @param annotations - 批注数组（含 range）。
     * @returns [{ text, status, kind }] 片段数组。
     */
    function buildHighlightSegments(content, annotations) {
      const ranges = annotations
        .filter((item) => item.anchorLost !== true && Number.isInteger(item.range?.start))
        .map((item) => ({
          start: Math.max(0, Math.min(item.range.start, content.length)),
          end: Math.max(0, Math.min(item.range.end, content.length)),
          status: item.status,
          kind: item.kind,
        }))
        .filter((item) => item.end > item.start)
        .sort((a, b) => a.start - b.start);

      const segments = [];
      let cursor = 0;
      for (const range of ranges) {
        if (range.start < cursor) continue; // 重叠的批注只画第一段，避免标记错乱
        if (range.start > cursor) segments.push({ text: content.slice(cursor, range.start), mark: false });
        segments.push({
          text: content.slice(range.start, range.end),
          mark: true,
          status: range.status,
          kind: range.kind,
        });
        cursor = range.end;
      }
      if (cursor < content.length) segments.push({ text: content.slice(cursor), mark: false });
      return segments;
    }

    /** 由选区起点算出浮动工具条该出现的位置（基于高亮层的镜像排版）。 */
    function measureCaret(layer, offset) {
      if (layer === null || layer === undefined) return null;
      const inner = layer.firstElementChild;
      if (inner === null || inner === undefined) return null;
      const walker = document.createTreeWalker(inner, NodeFilter.SHOW_TEXT);
      let remaining = offset;
      let node = walker.nextNode();
      while (node !== null) {
        const length = node.textContent?.length ?? 0;
        if (remaining <= length) {
          const range = document.createRange();
          range.setStart(node, remaining);
          range.setEnd(node, Math.min(length, remaining));
          const rect = range.getBoundingClientRect();
          if (rect.width === 0 && rect.height === 0) return { top: 0, left: 0 };
          const layerRect = layer.getBoundingClientRect();
          return { top: rect.top - layerRect.top, left: rect.left - layerRect.left };
        }
        remaining -= length;
        node = walker.nextNode();
      }
      return null;
    }

    /** 安全取一个可选服务：拿不到就返回 undefined，绝不抛错。 */
    function optionalService(scoped, name) {
      let value;
      try {
        value = typeof scoped.get === 'function' ? scoped.get(name) : undefined;
      } catch {
        value = undefined;
      }
      if (value === undefined || value === null) {
        try {
          value = scoped[name];
        } catch {
          value = undefined;
        }
      }
      return value === null ? undefined : value;
    }

    /**
     * 生成"自动开启画布"的无渲染组件。
     *
     * 挂在 conversation.composer.dock（会话级槽位）上：只要会话在屏幕上，它就在。
     *
     * 重要：**只有真正打开成功才写"已尝试"标记**。如果服务还没就绪或 openTab 抛错，
     * 就每 500ms 重试一次（最多 20 次），绝不把一次失败当成永久结果——
     * 否则用户会看到"明明说会自动出现，却什么都没有"。
     */
    function makeAutoOpen(ctx) {
      return function CanvasAutoOpen(props) {
        const sessionId = props?.sessionId;
        React.useEffect(() => {
          if (typeof sessionId !== 'string' || sessionId === '') return undefined;
          const key = `${AUTOOPEN_KEY_PREFIX}${sessionId}`;
          let remembered = false;
          try {
            remembered = localStorage.getItem(key) === '1';
          } catch {
            remembered = false;
          }
          if (remembered) {
            report('autoopen:skip', { sessionId, reason: 'already-opened-once' });
            return undefined;
          }

          let cancelled = false;
          let timer = null;
          let attempts = 0;

          const attempt = () => {
            if (cancelled) return;
            attempts += 1;
            const sidebarRight = optionalService(ctx, 'sidebarRight');
            if (sidebarRight === undefined || typeof sidebarRight.openTab !== 'function') {
              if (attempts < 20) {
                timer = setTimeout(attempt, 500);
                return;
              }
              report('autoopen:fail', { sessionId, reason: 'sidebarRight-unavailable', attempts });
              return;
            }
            try {
              sidebarRight.openTab(CANVAS_KIND);
              try {
                localStorage.setItem(key, '1');
              } catch {
                // 记不住也没关系，本次已经打开。
              }
              report('autoopen:ok', { sessionId, attempts });
            } catch (error) {
              if (attempts < 20) {
                timer = setTimeout(attempt, 500);
                return;
              }
              report('autoopen:fail', { sessionId, reason: describe(error), attempts });
            }
          };

          timer = setTimeout(attempt, 400);
          return () => {
            cancelled = true;
            if (timer !== null) clearTimeout(timer);
          };
        }, [sessionId]);
        return null;
      };
    }

    /**
     * Cordis 依赖。
     *
     * `sidebarRightTabs` 必须在这里硬依赖：右栏的两个服务是通过 ctx.reflect.provide
     * 提供的，apply 早于它们就绪时既拿不到服务、也收不到 internal/service 事件，
     * 结果就是标签页类型永远注册不上、自动开启必然失败。
     */
    const inject = ['slots', 'sidebarRightTabs'];

    /**
     * 客户端半体入口。
     * @param ctx - 浏览器侧 Cordis 上下文。
     */
    function apply(ctx) {
      const disposeStyles = insertStyles();
      const CanvasAutoOpen = makeAutoOpen(ctx);

      /** 手动在对话旁打开画布（工作台按钮与 guide 入口共用）。 */
      const openBeside = (origin) => {
        const sidebarRight = optionalService(ctx, 'sidebarRight');
        if (sidebarRight === undefined || typeof sidebarRight.openTab !== 'function') {
          report('manual-open:fail', { origin, reason: 'sidebarRight-unavailable' });
          return false;
        }
        try {
          sidebarRight.openTab(CANVAS_KIND);
          report('manual-open:ok', { origin });
          return true;
        } catch (error) {
          report('manual-open:fail', { origin, reason: describe(error) });
          return false;
        }
      };

      /** 注册右栏标签页类型（keepMounted = 跨切换保留 body）。 */
      const tabs = optionalService(ctx, 'sidebarRightTabs');
      if (tabs !== undefined && typeof tabs.register === 'function') {
        ctx.effect(
          () => {
            const dispose = tabs.register({
              id: CANVAS_TAB_ID,
              kind: CANVAS_KIND,
              title: () => '写作画布',
              keepMounted: true,
              // guide 入口：右栏「+」打开的导览页里会出现一张卡片。
              // commandId 让卡片右侧自动显示该命令在当前平台的有效快捷键。
              guide: [
                {
                  id: 'writing-canvas',
                  commandId: OPEN_COMMAND_ID,
                  order: 30,
                  title: () => '写作画布',
                  description: () => '启用实时写作',
                  icon: WritingArtwork,
                },
              ],
            });
            report('tabtype:registered', { id: CANVAS_TAB_ID, kind: CANVAS_KIND });
            return dispose;
          },
          'writing-canvas: 右栏标签页类型',
        );
      } else {
        report('tabtype:unavailable', { hasService: tabs !== undefined });
      }

      // 打开画布的命令 + 平台默认快捷键（导览卡片据此显示 ⌘⇧W / Ctrl+Shift+W）。
      //
      // 幂等注册：开发期客户端 bundle 会被热重载反复 apply，而快捷键服务对重复 id
      // 直接抛错（Duplicate shortcut command）。因此这里先查命令目录，已存在就不重复注册；
      // 同时延迟补试一次，覆盖「旧注册还没被销毁 → 新注册被拒」这一反向竞态。
      ctx.inject(['shortcuts'], (shortcutsCtx) => {
        let registered = false;
        // 跨热重载记住上一次的注销函数，好让每次注册都用**新鲜的闭包**。
        const HANDLE_KEY = '__dshWritingCanvasShortcutDispose__';

        const commandPresent = () => {
          const catalog = shortcutsCtx.shortcuts?.catalog;
          if (catalog === undefined || typeof catalog.getSnapshot !== 'function') return false;
          const rows = catalog.getSnapshot();
          return Array.isArray(rows) && rows.some((row) => row.id === OPEN_COMMAND_ID);
        };

        const ensureCommand = () => {
          if (registered) return;
          const shortcuts = shortcutsCtx.shortcuts;
          if (shortcuts === undefined || typeof shortcuts.register !== 'function') return;

          // 已经注册过就直接复用。
          //
          // 为什么必须先查：客户端 bundle 热重载时会再次执行 apply，但**旧的 Cordis
          // fiber 并不会被销毁**，旧注册仍然活着；此时再注册会撞上 duplicate id。
          // 复用是安全的——旧 fiber 既然还活着，它的闭包与 ctx 就都还有效。
          // 生产环境只 apply 一次，走不到这个分支。
          if (commandPresent()) {
            registered = true;
            report('shortcut:reused', { id: OPEN_COMMAND_ID });
            return;
          }

          // 命令不存在（首次加载，或旧 fiber 确实已销毁）：撤掉句柄后重新注册。
          const previous = globalThis[HANDLE_KEY];
          if (typeof previous === 'function') {
            try {
              previous();
            } catch {
              // 旧注销失败不影响后面重新注册。
            }
            globalThis[HANDLE_KEY] = undefined;
          }

          try {
            const dispose = shortcuts.register({
              id: OPEN_COMMAND_ID,
              label: () => '写作画布',
              aliases: ['writing canvas', '写作画布', '写作'],
              defaults: {
                // 默认用 ⌘⌥W / Ctrl+Alt+W。
                //
                // 为什么不用 ⌘⇧W：它会撞上微信等国内软件的全局热键（用户实测按下去
                // 唤出的是微信）。⌘⌥W 在国内常用软件里极少被占用，也不是浏览器或
                // 系统的保留组合。用户仍可在「设置 → 写作插件」里随时改。
                'desktop:macos': { code: 'KeyW', modifiers: ['primary', 'alt'] },
                'desktop:windows': { code: 'KeyW', modifiers: ['primary', 'alt'] },
                'desktop:linux': { code: 'KeyW', modifiers: ['primary', 'alt'] },
                // Web 端浏览器会先截获部分组合，因此再加一个 shift。
                // 注意：Web 只有 macOS/Windows 允许 3 个修饰键，Linux 保留受限集合，
                // 所以 web:linux 故意留空（不绑定），与官方 files / terminal 插件一致。
                'web:macos': { code: 'KeyW', modifiers: ['primary', 'alt', 'shift'] },
                'web:windows': { code: 'KeyW', modifiers: ['primary', 'alt', 'shift'] },
              },
              regions: ['page', 'editable', 'terminal'],
              modals: [],
              resolve: () => ({
                status: 'handled',
                run: () => {
                  openBeside('shortcut');
                },
              }),
            });
            registered = true;
            globalThis[HANDLE_KEY] = dispose;
            shortcutsCtx.effect(
              () => () => {
                if (globalThis[HANDLE_KEY] === dispose) globalThis[HANDLE_KEY] = undefined;
                dispose();
              },
              'writing-canvas: 打开画布快捷键',
            );
            report('shortcut:registered', { id: OPEN_COMMAND_ID });
          } catch (error) {
            // 旧注册可能由 Cordis 稍后才销毁；此时退化为复用现有命令，绝不让插件加载失败。
            if (commandPresent()) {
              registered = true;
              report('shortcut:reused', { id: OPEN_COMMAND_ID, reason: describe(error) });
              return;
            }
            report('shortcut:failed', { id: OPEN_COMMAND_ID, reason: describe(error) });
          }
        };

        ensureCommand();
        const retry = setTimeout(ensureCommand, 1500);
        shortcutsCtx.effect(() => () => clearTimeout(retry), 'writing-canvas: 快捷键注册补试');
      });

      // 形态 A：右栏标签页 body（声明感知注入，右栏存在时才生效）。
      ctx.slots.inject('sidebar.right.pane.tab', () =>
        ctx.slots.register({ name: 'sidebar.right.pane.tab', key: CANVAS_TAB_ID }, CanvasTabBody),
      );

      // 形态 A 的自动开启：会话在屏幕上时把画布钉到对话旁。
      ctx.slots.inject('conversation.composer.dock', () =>
        ctx.slots.register(
          { name: 'conversation.composer.dock', id: 'writing-canvas-autoopen', order: 40 },
          CanvasAutoOpen,
        ),
      );

      // 形态 B：侧边栏入口 + 整页工作台（带「在对话旁打开」按钮）。
      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register(
          { name: 'sidebar.panellist', id: PANEL_ID, order: 30, label: '写作工作台' },
          PanelIcon,
        ),
      );
      ctx.slots.inject('main', () =>
        ctx.slots.register({ name: 'main', key: PANEL_ID }, makeWorkbenchPanel(openBeside)),
      );

      // 形态 C：插件设置页（含快捷键录制器）。
      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          { name: 'settings.section', id: PLUGIN_ID, order: 55, label: '写作插件' },
          makeSettingsPage(ctx),
        ),
      );

      ctx.effect(() => disposeStyles, 'writing-canvas: 客户端样式');
    }

    // 模拟 ESM 命名空间，供宿主按 apply / inject 读取。
    const exports = {};
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
    exports.apply = apply;
    exports.inject = inject;
    // 纯函数暴露给单元测试。它们不依赖 DOM，也不产生副作用，
    // 但内联在 bundle 里无法被 import，所以留这个测试入口。
    exports.__internals = { transformSelection, buildHighlightSegments, formatKeys, modifiersOf };
    return exports;
  },
});

