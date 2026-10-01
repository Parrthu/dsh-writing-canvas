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
    /**
     * 写作模式的 agent preset id。
     *
     * 只有会话跑在这个 preset 下，画布才自动调出；其他模式一律不自动开。
     * 必须与写作模式预设声明里的 `config.id` 保持一致
     * （见本插件的 cordis.patch.yml 里 `preset-writing` 那一行）。
     */
    const WRITING_PRESET_ID = 'writing';
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
     *
     * v2 → v3：判据从「文档有没有正文」改成「会话是不是写作模式」。
     * 旧版本会在普通任务的会话里记下「已开启」，升版让这些标记一并作废，
     * 新逻辑才能在所有会话上重新评估一次。
     */
    const AUTOOPEN_KEY_PREFIX = 'dsh-writing-canvas:autoopen:v3:';
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
.wcv-banner { position: relative; margin: 0 14px 8px; padding: 8px 30px 8px 11px; border-radius: 8px;
  font-size: 12px; line-height: 1.6;
  border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.24));
  background: var(--dsw-alias-bg-layer-1, rgba(128,128,128,0.07)); color: var(--dsw-alias-label-secondary, #6b6b6b); }
.wcv-bannerText { display: block; }
.wcv-bannerClose { position: absolute; top: 4px; right: 6px; width: 20px; height: 20px;
  display: inline-flex; align-items: center; justify-content: center;
  font: inherit; font-size: 15px; line-height: 1; padding: 0; cursor: pointer;
  border: none; border-radius: 999px; background: transparent;
  color: var(--dsw-alias-label-secondary, #6b6b6b); }
.wcv-bannerClose:hover { background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,0.16));
  color: var(--dsw-alias-label-primary, #1a1a1a); }
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
/* 类型 / 格式集：并进工具栏的 chip 按钮。
   外观是按钮，底下压着一个透明原生 select——键盘与无障碍能力都不丢。 */
.wcv-meta { position: relative; box-sizing: border-box; display: inline-flex; align-items: center; gap: 4px;
  font-size: 12px; line-height: 1; height: 26px; padding: 0 9px; border-radius: 999px;
  cursor: pointer; white-space: nowrap; max-width: 190px;
  border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.3));
  background: var(--dsw-alias-bg-layer-1, rgba(128,128,128,0.06));
  color: var(--dsw-alias-label-secondary, #6b6b6b); }
.wcv-meta:hover { background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,0.14));
  color: var(--dsw-alias-label-primary, #1a1a1a); }
.wcv-meta[data-set="true"] { color: var(--dsw-alias-brand-primary, #4d6bfe);
  border-color: var(--dsw-alias-brand-primary, #4d6bfe); font-weight: 600; }
.wcv-metaText { pointer-events: none; overflow: hidden; text-overflow: ellipsis; }
.wcv-metaCaret { pointer-events: none; font-size: 9px; opacity: 0.65; }
.wcv-metaSelect { position: absolute; inset: 0; width: 100%; height: 100%; margin: 0;
  padding: 0; border: none; opacity: 0; cursor: pointer; appearance: none; }
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
.wcv-tool { box-sizing: border-box; font: inherit; font-size: 12.5px; line-height: 1; min-width: 26px;
  height: 26px; padding: 0 6px; border-radius: 999px; cursor: pointer; border: 1px solid transparent;
  background: transparent; color: var(--dsw-alias-label-secondary, #6b6b6b); }
.wcv-tool:hover { background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,0.12));
  color: var(--dsw-alias-label-primary, #1a1a1a); }
.wcv-tool[data-active="true"] { background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,0.16));
  color: var(--dsw-alias-label-primary, #1a1a1a); border-color: var(--dsw-alias-border-l2, rgba(128,128,128,0.4)); }
.wcv-tool--strong { font-weight: 700; }
.wcv-toolSpacer { flex: 1; }
/* 工具栏分两行：上行是类型/格式集与状态，下行整行留给格式按钮。
   这样格式按钮不会被 chip 挤到中间断开。 */
.wcv-toolbar { flex-direction: column; align-items: stretch; }
.wcv-toolRow { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; min-width: 0; }
.wcv-toolRow + .wcv-toolRow { margin-top: 5px; }
.wcv-root--pane .wcv-toolRow { gap: 3px; }
.wcv-tool--italic { font-style: italic; }
.wcv-toolSep { width: 1px; height: 16px; margin: 0 3px;
  background: var(--dsw-alias-border-l1, rgba(128,128,128,0.3)); }

/* ---- 选区浮动工具条 ---- */
.wcv-float { position: absolute; z-index: 40; display: flex; align-items: center; gap: 2px;
  /* 兜底：容器极窄时宁可换行也不要溢出到正文上。 */
  max-width: calc(100% - 8px); flex-wrap: wrap;
  padding: 4px 5px; border-radius: 9px; box-shadow: 0 6px 22px rgba(0,0,0,0.16);
  background: var(--dsw-alias-bg-overlay, #fff); color: var(--dsw-alias-label-primary, #1a1a1a);
  border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.35)); }
.wcv-floatBtn { font: inherit; font-size: 12.5px; line-height: 1; height: 26px; padding: 0 8px;
  border-radius: 6px; cursor: pointer; border: none; background: transparent; color: inherit;
  white-space: nowrap; }
.wcv-floatBtn:hover { background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,0.14)); }
.wcv-floatBtn--ai { color: var(--dsw-alias-brand-primary, #4d6bfe); font-weight: 600; }
.wcv-floatBtn--primary { background: var(--dsw-alias-brand-primary, #4d6bfe); color: #fff; font-weight: 600; }
.wcv-floatBtn--primary:hover { filter: brightness(1.06); }
.wcv-floatBtn:disabled { opacity: 0.4; cursor: default; }
/* 输入态：先说要求再落批注。原来是 window.prompt —— Electron 不支持，点了没反应。 */
.wcv-float--input { padding: 4px 6px; gap: 4px; }
.wcv-floatLabel { font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-secondary, #6b6b6b);
  white-space: nowrap; }
.wcv-floatInput { font: inherit; font-size: 12.5px; height: 26px; width: 240px; padding: 0 8px;
  border-radius: 6px; outline: none; color: inherit;
  border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.4));
  background: var(--dsw-alias-bg-layer-1, rgba(128,128,128,0.06)); }
.wcv-floatInput:focus { border-color: var(--dsw-alias-brand-primary, #4d6bfe); }

/* ---- 正文 + 批注高亮层 ---- */
.wcv-editorWrap { position: relative; flex: 1; min-height: 0; display: flex; }
.wcv-highlight { position: absolute; inset: 0; overflow: hidden; pointer-events: none;
  border: 1px solid transparent; border-radius: 10px; }
.wcv-highlightInner { white-space: pre-wrap; word-break: break-word; font-size: 15px; line-height: 1.85;
  padding: 16px 18px; color: transparent; }
/* 富文本（Markdown 所见即所得）：文字画在镜像层上，textarea 只负责光标与选区。
   两层共用同一套字体、字号、行高、内边距，且语法标记用 visibility 占位而非删除，
   所以字符宽度与换行位置完全一致——这也是这套做法不必换编辑内核的前提。 */
.wcv-root--rich .wcv-highlightInner { color: inherit; }
.wcv-root--rich .wcv-editor { color: transparent; caret-color: var(--dsw-alias-label-primary, #1a1a1a); }
.wcv-root--rich .wcv-editor::selection { background: rgba(77, 107, 254, 0.22); }
/* 语法标记：不可见但**占位**，删掉它就会立刻错位。 */
.wcv-tool--wide { min-width: 32px; padding: 0 8px; font-size: 11px; letter-spacing: 0.02em; }
.wcv-followBack { font: inherit; font-size: 11px; margin-left: 8px; padding: 1px 7px; border-radius: 999px;
  cursor: pointer; border: 1px solid currentColor; background: transparent; color: inherit; opacity: 0.85; }
.wcv-followBack:hover { opacity: 1; }
.wcv-tool--on { color: var(--dsw-alias-brand-primary, #4d6bfe);
  background: var(--dsw-alias-bg-layer-2, rgba(77,107,254,0.12)); }
.wcv-mdHidden { visibility: hidden; }
.wcv-md-bold { font-weight: 700; }
.wcv-md-italic { font-style: italic; }
.wcv-md-strike { text-decoration: line-through; }
.wcv-md-code { background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,0.16)); border-radius: 3px;
  color: var(--dsw-alias-link, #4d6bfe); }
/* 标题只改颜色与字重，**不改字号**：字号一变宽度就变，光标立刻错位。 */
/* 用 alias-link（品牌蓝）而不是 brand-primary：后者在本主题里就等于主文字色，
   标题会跟正文一样黑，等于没有强调。这个变量随深浅主题自适应。 */
.wcv-md-heading { font-weight: 700; color: var(--dsw-alias-link, #4d6bfe); }
.wcv-md-quote { color: var(--dsw-alias-label-secondary, #6b6b6b); }
.wcv-md-link { color: var(--dsw-alias-link, #4d6bfe); text-decoration: underline;
  text-underline-offset: 2px; }
.wcv-root--pane .wcv-highlightInner { font-size: 14px; padding: 12px 14px; }
.wcv-mark { background: rgba(255, 176, 32, 0.28); border-radius: 3px; color: transparent; }
.wcv-mark[data-status="resolved"] { background: rgba(26, 156, 83, 0.20); }
.wcv-mark[data-kind="ask"] { background: rgba(77, 107, 254, 0.20); }
/* 修改建议：波浪下划线标记，原文与改法在面板里对照 */
.wcv-mark[data-mark="suggestion"] { background: rgba(217, 130, 43, 0.14);
  text-decoration: underline wavy var(--dsw-alias-state-warn-primary, #d9822b);
  text-decoration-thickness: 1px; text-underline-offset: 3px; }
.wcv-sugg { display: flex; flex-direction: column; gap: 5px; padding: 9px 10px; border-radius: 9px;
  margin-bottom: 8px; border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.26));
  background: var(--dsw-alias-bg-layer-1, rgba(128,128,128,0.05)); }
.wcv-sugg[data-status="accepted"] { opacity: 0.62; }
.wcv-sugg[data-status="rejected"] { opacity: 0.45; }
.wcv-diffDel { font-size: 12px; line-height: 1.6; padding: 5px 8px; border-radius: 6px;
  background: rgba(217, 48, 37, 0.08); color: var(--dsw-alias-label-secondary, #6b6b6b);
  text-decoration: line-through; white-space: pre-wrap; }
.wcv-diffIns { font-size: 12px; line-height: 1.6; padding: 5px 8px; border-radius: 6px;
  background: rgba(26, 156, 83, 0.10); white-space: pre-wrap; }
/* 版本对比：行级差异 */
.wcv-diffStat { font-size: 11.5px; color: var(--dsw-alias-label-secondary, #6b6b6b); margin: 6px 0 4px; }
.wcv-diff { max-height: 220px; overflow: auto; border-radius: 6px; padding: 5px 0;
  background: var(--dsw-alias-bg-layer-1, rgba(128,128,128,0.06));
  border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.2)); }
.wcv-diffLine { display: flex; gap: 6px; font-size: 11.5px; line-height: 1.6;
  padding: 0 8px; white-space: pre-wrap; word-break: break-word; }
.wcv-diffLine[data-type="add"] { background: rgba(26, 156, 83, 0.13); }
.wcv-diffLine[data-type="del"] { background: rgba(217, 48, 37, 0.10);
  color: var(--dsw-alias-label-secondary, #6b6b6b); text-decoration: line-through; }
.wcv-diffSign { flex: none; width: 9px; opacity: 0.7; font-family: ui-monospace, monospace; }
.wcv-editor--over { position: relative; z-index: 1; background: transparent !important; }
/* 撰写期间锁定：只读，光标与边框都给出「现在轮不到你改」的信号。 */
.wcv-editor--locked { cursor: default; caret-color: transparent; border-color: var(--dsw-alias-brand-primary, #4d6bfe) !important; }
.wcv-editor--locked::selection { background: transparent; }

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
.wcv-mini { box-sizing: border-box; display: inline-flex; align-items: center; justify-content: center;
  font: inherit; font-size: 12px; height: 26px; padding: 0 10px; border-radius: 999px;
  cursor: pointer; white-space: nowrap;
  border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.3));
  background: var(--dsw-alias-bg-layer-1, rgba(128,128,128,0.06));
  color: var(--dsw-alias-label-secondary, #6b6b6b); }
.wcv-mini:hover { border-color: var(--dsw-alias-brand-primary, #4d6bfe); }
/* 工具栏上的所有按钮统一成同一尺寸、同一胶囊形状：
   chip（.wcv-meta）、图标按钮（.wcv-iconBtn）、文字按钮（.wcv-mini）都是 26px 高、全圆角，
   边框与底色一致。此前三种按钮各有各的圆角与留白，排在一起显得很杂。 */
.wcv-iconBtn { box-sizing: border-box; display: inline-flex; align-items: center; justify-content: center;
  width: 26px; height: 26px; padding: 0; border-radius: 999px; cursor: pointer;
  border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.3));
  background: var(--dsw-alias-bg-layer-1, rgba(128,128,128,0.06));
  color: var(--dsw-alias-label-secondary, #6b6b6b); flex: none; }
.wcv-iconBtn:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,0.14));
  color: var(--dsw-alias-label-primary, #1a1a1a); }
.wcv-iconBtn:disabled { opacity: 0.4; cursor: default; }
.wcv-iconBtn--primary { border-color: var(--dsw-alias-border-l2, rgba(128,128,128,0.4));
  background: var(--dsw-alias-bg-layer-1, rgba(128,128,128,0.06)); }
.wcv-iconBtn--primary:hover:not(:disabled) { border-color: var(--dsw-alias-brand-primary, #4d6bfe); }
.wcv-docRow { display: flex; align-items: center; gap: 6px; }
.wcv-docMain { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }

/* ---- 窄栏底部抽屉：默认收起，绝不挤压正文 ---- */
.wcv-hidden { display: none !important; }
.wcv-drawer { flex: none; display: flex; flex-direction: column; max-height: 42%;
  border-top: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.28)); }
.wcv-drawerTabs { flex: none; display: flex; align-items: center; gap: 4px; padding: 4px 8px; }
.wcv-drawerTab { font: inherit; font-size: 11.5px; padding: 2px 9px; border-radius: 999px; cursor: pointer;
  border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.3));
  background: transparent; color: var(--dsw-alias-label-secondary, #6b6b6b); }
.wcv-drawerTab[data-active="true"] { background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,0.16));
  color: var(--dsw-alias-label-primary, #1a1a1a); border-color: var(--dsw-alias-border-l2, rgba(128,128,128,0.45)); }
/* 有待决定项：用品牌色提示，否则这些小标签用户根本不会点。 */
.wcv-drawerTab[data-alert="true"] { color: var(--dsw-alias-brand-primary, #4d6bfe); font-weight: 600;
  border-color: var(--dsw-alias-brand-primary, #4d6bfe); }
.wcv-drawerTab[data-alert="true"][data-active="false"] { background: color-mix(in srgb, var(--dsw-alias-brand-primary, #4d6bfe) 10%, transparent); }
.wcv-drawerSpacer { flex: 1; }
.wcv-drawerMeta { font-size: 11px; color: var(--dsw-alias-label-secondary, #6b6b6b); }
.wcv-drawerBody { flex: 1; min-height: 0; overflow: auto; padding: 0 10px 10px; }
/* 提示词面板：用户可自行编辑写作类型的提示词 */
.wcv-prompt { flex: none; display: flex; flex-direction: column; gap: 6px; padding: 8px 14px 10px;
  border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.28)); }
.wcv-root--pane .wcv-prompt { padding: 6px 10px 8px; }
.wcv-promptHead { display: flex; align-items: center; gap: 6px; }
.wcv-promptTitle { font-size: 12px; font-weight: 600; }
.wcv-promptText { width: 100%; box-sizing: border-box; min-height: 132px; max-height: 300px; resize: vertical;
  font: inherit; font-size: 12.5px; line-height: 1.6; padding: 8px 10px; border-radius: 8px; outline: none;
  color: inherit; background: var(--dsw-alias-bg-layer-1, rgba(128,128,128,0.05));
  border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.3)); }
.wcv-promptText:focus { border-color: var(--dsw-alias-brand-primary, #4d6bfe); }
.wcv-promptHint { font-size: 11px; color: var(--dsw-alias-label-secondary, #6b6b6b); }
.wcv-mini--primary { color: var(--dsw-alias-brand-primary, #4d6bfe); font-weight: 600;
  border-color: var(--dsw-alias-brand-primary, #4d6bfe); }
.wcv-mini:disabled { opacity: 0.45; cursor: default; }
/* 开写前的写作模式选择 */
.wcv-onboard { position: absolute; inset: 0; z-index: 3; display: flex; flex-direction: column;
  align-items: center; justify-content: center; gap: 10px; padding: 20px;
  background: var(--dsw-alias-bg-base, #fff); border-radius: 10px; text-align: center; }
.wcv-onboardTitle { font-size: 17px; font-weight: 700; }
.wcv-onboardHint { font-size: 12.5px; color: var(--dsw-alias-label-secondary, #6b6b6b); max-width: 420px; line-height: 1.7; }
.wcv-chips { display: flex; flex-wrap: wrap; gap: 7px; justify-content: center; max-width: 460px; margin-top: 4px; }
.wcv-chip { font: inherit; font-size: 12.5px; padding: 5px 12px; border-radius: 999px; cursor: pointer;
  border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.4));
  background: var(--dsw-alias-bg-layer-1, rgba(128,128,128,0.06)); color: inherit; }
.wcv-chip:hover { border-color: var(--dsw-alias-brand-primary, #4d6bfe); }
.wcv-chip[data-custom="true"] { border-style: dashed; }
.wcv-chip--ghost { border-style: dashed; color: var(--dsw-alias-label-secondary, #6b6b6b); }
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
      const [suggestions, setSuggestions] = React.useState([]);
      const [writing, setWriting] = React.useState({ active: false, startedAt: null, note: '' });
      const [selection, setSelection] = React.useState(null);
      /**
       * 正在填写的 AI 选区动作：{ kind, text, start, end } 或 null。
       *
       * 为什么不用 window.prompt：**Electron 不支持它**（调用会直接抛错），
       * 所以原先那四个按钮（改写/扩写/缩短/润色）与「批注」点了毫无反应——
       * 用户看到的就是「按钮不可用」。改为在浮动工具条内联出输入框。
       */
      const [aiAction, setAiAction] = React.useState(null);
      /** AI 动作输入框里的文字。 */
      const [aiDraft, setAiDraft] = React.useState('');
      /**
       * 浮动工具条的实际落点。
       *
       * 不能直接拿选区坐标当 left：选区靠右时工具条会越出容器、反过来压住
       * 用户刚选中的那行字。所以先渲染再量宽度，把它夹在容器内。
       * 量出来之前先隐藏，避免闪一下再跳位。
       */
      const [floatPos, setFloatPos] = React.useState(null);
      const floatRef = React.useRef(null);
      /**
       * Markdown 所见即所得：文字画在镜像层上，textarea 退居幕后只管光标。
       *
       * 这套做法成立的前提是两层**逐字符对齐**。虽然语法标记用 visibility 占位
       * 保证了宽度不变，但字体渲染总有万一（比如某个字体下加粗会略宽），
       * 所以下面还有一道实测：两层的渲染高度对不上就自动退回纯文本，
       * 宁可不漂亮，也不能让光标和文字错位。
       */
      const [richText, setRichText] = React.useState(true);
      const [richSafe, setRichSafe] = React.useState(true);
      const richOn = richText && richSafe;
      /** 用户是否手动往上滚过（滚过就暂停「撰写中焦点跟随」）。 */
      const followPausedRef = React.useRef(false);
      const [followPaused, setFollowPaused] = React.useState(false);
      /** 当前这次滚动是不是代码自己发起的。 */
      const programmaticScrollRef = React.useRef(false);
      /** 定位 effect 的每秒调用计数，用于熔断渲染风暴。 */
      const floatBurstRef = React.useRef({ at: 0, count: 0 });
      /** 与 richSafe 同步的引用：体检里要读它又不想把它放进依赖（否则自触发循环）。 */
      const richSafeRef = React.useRef(true);
      const [sets, setSets] = React.useState([]);
      const [exportSpec, setExportSpec] = React.useState('');
      const [exporting, setExporting] = React.useState(false);
      const [exportResult, setExportResult] = React.useState(null);
      /** 窄栏模式底部抽屉当前展开的面板：默认 none（完全不占正文空间）。 */
      const [paneTab, setPaneTab] = React.useState('none');
      /** 空内容覆盖被拦下时的提示（只有用户显式确认才允许清空）。 */
      const [emptyBlocked, setEmptyBlocked] = React.useState(false);
      /** 界面开关（目前只有开发期交互自检）。 */
      const [uiFlags, setUiFlags] = React.useState({ interactionSelfTest: false, workbenchSelfTest: false });
      /**
       * 「提示词」面板：用户点开写作类型的提示词后可以自己改。
       * promptText 是编辑中的文本，promptSaved 是服务端当前的值（用来判断有没有改动）。
       */
      const [promptText, setPromptText] = React.useState('');
      const [promptSaved, setPromptSaved] = React.useState('');
      const [promptIsCustom, setPromptIsCustom] = React.useState(false);
      const [promptBusy, setPromptBusy] = React.useState(false);

      // 注意：这两个派生值必须定义在任何引用了它们的 effect **之前**。
      // 之前放在渲染段里，被 effect 的依赖数组引用，触发暂时性死区（TDZ）
      // 导致整个画布渲染崩溃——教训：依赖数组是在渲染期求值的。
      const openCount = annotations.filter((a) => a.status === 'open').length;
      const pendingSuggestions = suggestions.filter((s) => s.status === 'pending').length;

      /**
       * 新建议一到就把抽屉展开到建议面板。
       *
       * 事故复盘：Agent 用 writing_canvas_suggest 提交了 3 条建议，工具返回 ok:true、
       * 建议也确实落盘了，但用户说「并没有成功」——因为窄栏模式下建议面板默认收起，
       * 只有一个「建议 3」的小标签，用户根本不知道要点它。
       * 功能没问题，**看不见等于没做**，所以这里改成自动展开。
       *
       * 只在**数量增加**时展开：用户手动收起后不会又被弹开。
       */
      const prevPendingRef = React.useRef(0);
      React.useEffect(() => {
        if (variant === 'pane' && pendingSuggestions > prevPendingRef.current) {
          setPaneTab('suggestions');
        }
        prevPendingRef.current = pendingSuggestions;
      }, [pendingSuggestions, variant]);

      React.useEffect(() => {
        let cancelled = false;
        apiGet('/ui-flags')
          .then(({ ok, data }) => {
            if (!cancelled && ok) {
              setUiFlags({
                interactionSelfTest: data?.interactionSelfTest === true,
                workbenchSelfTest: data?.workbenchSelfTest === true,
              });
            }
          })
          .catch(() => {});
        return () => {
          cancelled = true;
        };
      }, []);

      // 格式集（Set）：内置 Markdown 体例 + 内置 DOCX 规格 + 用户自定义。
      React.useEffect(() => {
        let cancelled = false;
        apiGet('/format-sets', targetQuery(target))
          .then(({ ok, data }) => {
            if (!cancelled && ok && Array.isArray(data?.sets)) setSets(data.sets);
          })
          .catch(() => {});
        return () => {
          cancelled = true;
        };
      }, [targetKey]);

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
      /** 整个画布的根节点，用于界面自检。 */
      const rootRef = React.useRef(null);
      /** 插件上下文，供开发期自检使用（打开工作台等）。 */
      const ctxRef = React.useRef(null);
      ctxRef.current = props.ctx ?? null;
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
            setSuggestions(Array.isArray(data.suggestions) ? data.suggestions : []);
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
      /**
       * 把编辑器和它的高亮镜像层一起滚到底。
       *
       * 逐字呈现时，文字在下方不断长出来；不跟着滚的话用户的视野停在开头，
       * 根本不知道已经写完了。这里在每次推进后把视图拉到底，
       * 效果就是「看着字一行行打出来」。
       *
       * 高亮层是独立的一层（用相同排版镜像正文），必须同步滚动，否则批注色块会和文字错位。
       */
      const scrollEditorToEnd = () => {
        const el = editorRef.current;
        if (el !== null && el !== undefined) {
          // 标记为程序滚动，避免下面 onScroll 把它误判成「用户自己滚了」。
          programmaticScrollRef.current = true;
          el.scrollTop = el.scrollHeight;
          if (typeof requestAnimationFrame === 'function') {
            requestAnimationFrame(() => {
              programmaticScrollRef.current = false;
            });
          }
        }
        const layer = highlightRef.current;
        if (layer !== null && layer !== undefined && el !== null && el !== undefined) {
          layer.scrollTop = el.scrollTop;
        }
      };

      /**
       * 撰写中把视野拉到最新写出的那一段。
       *
       * **用户一旦自己往上翻，就必须停手**。原先每个 tick 都无条件拉到底，
       * 结果是想回看前文时会被一直拽回底部，既没法读也说不清为什么——
       * 用户反馈的「它一直往底部去，好诡异」说的就是这个。
       * 滚回底部附近即自动恢复跟随。
       */
      const followWritingTail = () => {
        if (followPausedRef.current) return;
        scrollEditorToEnd();
        if (typeof requestAnimationFrame === 'function') {
          requestAnimationFrame(() => scrollEditorToEnd());
        }
      };

      /**
       * 让高亮镜像层的换行宽度与编辑器完全一致。
       *
       * 重影的真正原因：textarea 内容超长时**会出现垂直滚动条并占掉约 15px 宽度**，
       * 而镜像层是 `overflow: hidden`，不占。两层内容宽度差一个滚动条，换行位置就会
       * 从某一行起分叉，越往下错得越多——看起来就是正文底部有重影（截图里已确认）。
       *
       * 这里把滚动条宽度量出来补到镜像层的内边距上，两层内容盒宽度就相等了。
       * 必须在内容变化和滚动时都同步：滚动条是随内容出现的。
       */
      const syncHighlightMetrics = () => {
        const el = editorRef.current;
        const layer = highlightRef.current;
        if (el === null || el === undefined || layer === null || layer === undefined) return;
        const inner = layer.firstElementChild;
        if (inner === null || inner === undefined) return;
        try {
          const style = window.getComputedStyle(el);
          const baseRight = Number.parseFloat(style.paddingRight) || 0;
          const border = (el.clientLeft || 0) * 2;
          const scrollbar = Math.max(0, el.offsetWidth - el.clientWidth - border);
          inner.style.paddingRight = `${baseRight + scrollbar}px`;
        } catch {
          // 量不到就不补：宁可保持原样，也不要抛错打断渲染。
        }
      };

      /**
       * 把服务端的正文呈现出来。
       *
       * **只有「正在被写出来」才跟随滚动**（follow: true）。这条区分是必须的：
       * 服务端每次落盘都会推 doc-changed，客户端据此调 refresh，而 refresh 也会
       * 走到这里——若不问场合一律拉到底部，用户就会看到「打着字，视图自己往下跑」，
       * 而且往上翻也会被立刻拽回去。这个现象与被动的自动滚动无关，纯粹是这里太粗。
       *
       * @param next - 新正文。
       * @param options.follow - 是否把视野跟到最新写出的位置，默认 false。
       */
      const revealContent = React.useCallback(
        (next, options) => {
          const previous = textRef.current;
          stopReveal();
          if (typeof next !== 'string') return;
          const follow = options !== null && typeof options === 'object' && options.follow === true;
          // 内容没变就什么都不做：既省一次渲染，也避免把光标顶到末尾、
          // 更避免把视图莫名拉到底（自动保存的回显走的正是这条路）。
          if (next === previous) return;
          if (follow) {
            // 新一次撰写/回放重新开始跟随：上一轮里用户可能手动滚动过。
            followPausedRef.current = false;
            setFollowPaused(false);
          }
          if (previous !== '' && next.startsWith(previous) && next.length > previous.length) {
            let cursor = previous.length;
            const step = Math.max(1, Math.ceil((next.length - previous.length) / 80));
            revealTimerRef.current = setInterval(() => {
              cursor = Math.min(next.length, cursor + step);
              setText(next.slice(0, cursor));
              if (follow) followWritingTail();
              syncHighlightMetrics();
              if (cursor >= next.length) stopReveal();
            }, 16);
            return;
          }
          setText(next);
          if (follow) followWritingTail();
        },
        [stopReveal],
      );

      React.useEffect(() => stopReveal, [stopReveal]);

      // 正文一变就重算镜像层的换行宽度：内容长短决定 textarea 有没有滚动条，
      // 不同步就会出现两层换行位置分叉（正文底部重影的根因）。
      React.useEffect(() => {
        syncHighlightMetrics();
        if (typeof requestAnimationFrame === 'function') {
          requestAnimationFrame(() => syncHighlightMetrics());
        }
      }, [text]);

      /**
       * 富文本对齐体检：两层的渲染高度必须一致。
       *
       * 高度一致才说明换行位置相同；一旦分叉，光标就会落在错的地方。
       * 对不上时自动退回纯文本并上报——这是安全网，不是常态。
       */
      React.useLayoutEffect(() => {
        if (!richOn) return;
        // 正文还是空的就别急着下结论：此刻两层都只有内边距高，
        // 拿这个去比会得出「差 600 多像素」的假警报（实测踩过）。
        if (text.trim() === '') return;
        const probe = () => {
          const el = editorRef.current;
          const layer = highlightRef.current;
          if (el === null || layer === null) return;
          const inner = layer.firstElementChild;
          if (inner === null) return;
          const delta = Math.abs(inner.scrollHeight - el.scrollHeight);
          if (delta > 3) {
            if (richSafeRef.current) {
              richSafeRef.current = false;
              setRichSafe(false);
              report('richtext:fallback', {
                delta,
                editor: el.scrollHeight,
                layer: inner.scrollHeight,
                reason: '两层渲染高度不一致，已退回纯文本以保证光标准确',
              });
            }
          } else if (!richSafeRef.current) {
            // 之前降级过但现在已经对齐（比如字体加载完成），自动恢复。
            richSafeRef.current = true;
            setRichSafe(true);
            report('richtext:restored', {});
          }
        };
        // 再等一帧：字体与布局稳定后再量，避免量到中间态。
        const id = typeof requestAnimationFrame === 'function' ? requestAnimationFrame(probe) : null;
        if (id === null) probe();
        return () => {
          if (id !== null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(id);
        };
      }, [text, richOn, annotations]);

      /**
       * 界面自检：把「实际渲染出了什么」回报给宿主。
       *
       * 为什么需要：客户端跑在浏览器里，宿主看不见它。开发者（包括 AI 自己）可以
       * 通过 GET /writing-canvas/api/client-report 读到结构化的自检结果，
       * 从而在没有截图权限的情况下也能验证界面是否真的渲染正确。
       */
      React.useEffect(() => {
        const timer = setTimeout(() => {
          const root = rootRef.current;
          if (root === null) return;
          const one = (selector) => root.querySelector(selector);
          const all = (selector) => root.querySelectorAll(selector);
          const editor = one('.wcv-editor');
          report('selfcheck', {
            variant,
            toolbarButtons: all('.wcv-tool').length,
            typeSelect: one('.wcv-select') !== null,
            formatTag: one('.wcv-formatTag') !== null,
            columns: all('.wcv-col').length,
            hiddenColumns: all('.wcv-hidden').length,
            drawer: one('.wcv-drawer') !== null,
            drawerOpen: one('.wcv-drawerBody') !== null,
            // 导出已改为图标按钮，用 title 判定
            exportButton: [...all('[title]')].some((node) => /套用|设为本文体例/.test(node.getAttribute('title') ?? '')),
            iconButtons: all('.wcv-iconBtn').length,
            setOptions: all('.wcv-select option').length,
            specOptions: all('.wcv-select option').length,
            annotationPanel: one('.wcv-colBody') !== null,
            annotationCards: all('.wcv-anno').length,
            highlightLayer: one('.wcv-highlight') !== null,
            highlightMarks: all('.wcv-mark').length,
            versionRows: all('.wcv-ver').length,
            editorPresent: editor !== null,
            editorChars: editor === null ? -1 : editor.value.length,
            editorHeight: editor === null ? -1 : Math.round(editor.getBoundingClientRect().height),
            rootHeight: Math.round(root.getBoundingClientRect().height),
            writingPill: one('.wcv-writing') !== null,
            bannerText: one('.wcv-banner') === null ? null : one('.wcv-banner').textContent.slice(0, 80),
            // 2026-10-01 界面重构的自检项：窄栏下抬头与底栏都必须不存在，
            // 类型/格式集必须已经并成工具栏上的 chip。
            headerPresent: one('.wcv-header') !== null,
            footPresent: one('.wcv-foot') !== null,
            metaChips: all('.wcv-meta').length,
            metaSelects: all('.wcv-metaSelect').length,
            promptPanel: one('.wcv-prompt') !== null,
            // 工具栏排版自检：按钮分布在第几行、有没有溢出、正文两层是否错位。
            toolbarHeight: one('.wcv-toolbar') === null ? -1 : Math.round(one('.wcv-toolbar').getBoundingClientRect().height),
            toolRows: [...all('.wcv-tool')].reduce((acc, node) => {
              const top = Math.round(node.getBoundingClientRect().top);
              acc[top] = (acc[top] ?? 0) + 1;
              return acc;
            }, {}),
            toolLabels: [...all('.wcv-tool')].map((node) => node.textContent).join('|'),
            toolbarOverflow: one('.wcv-toolbar') === null
              ? -1
              : one('.wcv-toolbar').scrollWidth - one('.wcv-toolbar').clientWidth,
            scrollSkew:
              editor === null || one('.wcv-highlight') === null
                ? -1
                : Math.abs(editor.scrollTop - one('.wcv-highlight').scrollTop),
            editorScrollTop: editor === null ? -1 : Math.round(editor.scrollTop),
            editorScrollHeight: editor === null ? -1 : Math.round(editor.scrollHeight),
            // 两层的内容盒宽度差：必须为 0，否则批注色块会与文字错位。
            editorContentWidth: editor === null ? -1 : Math.round(editor.clientWidth),
            highlightPadRight:
              one('.wcv-highlightInner') === null
                ? -1
                : Math.round(Number.parseFloat(window.getComputedStyle(one('.wcv-highlightInner')).paddingRight) || 0),
            scrollbarWidth: editor === null ? -1 : Math.round(editor.offsetWidth - editor.clientWidth),
            // 工具栏按钮尺寸是否统一（用户要求「所有按钮保持一致大小、同样的胶囊样式」）。
            toolButtonHeights: [
              ...new Set(
                [...all('.wcv-toolRow button'), ...all('.wcv-toolRow label')].map((node) =>
                  Math.round(node.getBoundingClientRect().height),
                ),
              ),
            ],
            toolButtonRadii: [
              ...new Set(
                [...all('.wcv-toolRow button'), ...all('.wcv-toolRow label')].map(
                  (node) => window.getComputedStyle(node).borderRadius,
                ),
              ),
            ],
            legacyCheckButton: all('.wcv-iconBtn').length,
            bannerClose: one('.wcv-bannerClose') !== null,
            // 所见即所得：是否开启、两层渲染高度差（差 0 才说明逐行对齐）
            richText: richOn,
            richSafe,
            richAlignDelta:
              editor === null || one('.wcv-highlightInner') === null
                ? -1
                : Math.round(one('.wcv-highlightInner').scrollHeight - editor.scrollHeight),
            mdHiddenMarks: all('.wcv-mdHidden').length,
            mdStyledRuns: all('[class^="wcv-md-"]').length,
          });

          // 开发期交互自检：程序化地选中一段文字，确认浮动工具条真的出现。
          // 不依赖鼠标模拟，因此不受辅助功能权限影响；只在开关打开时运行，
          // 且不抢用户焦点、结束后恢复原选区。
          if (uiFlags.interactionSelfTest !== true) return;
          const editorNode = editorRef.current;
          if (editorNode === null || document.activeElement === editorNode || editorNode.value.length === 0) {
            return;
          }
          const previous = [editorNode.selectionStart, editorNode.selectionEnd];
          editorNode.setSelectionRange(0, Math.min(6, editorNode.value.length));
          syncSelection();
          setTimeout(() => {
            const float = rootRef.current === null ? null : rootRef.current.querySelector('.wcv-float');
            report('selfcheck:interaction', {
              selectionMade: editorNode.selectionEnd > editorNode.selectionStart,
              selectedChars: editorNode.selectionEnd - editorNode.selectionStart,
              floatingToolbar: float !== null,
              floatButtons: float === null ? 0 : float.querySelectorAll('.wcv-floatBtn').length,
              floatAiButtons: float === null ? 0 : float.querySelectorAll('.wcv-floatBtn--ai').length,
              floatOffsetTop: float === null ? null : float.style.top,
            });
            editorNode.setSelectionRange(previous[0], previous[1]);
            setSelection(null);

            // 顺带点开第一个版本行，确认差异视图能渲染出来。
            const versionRow = rootRef.current === null ? null : rootRef.current.querySelector('.wcv-verTop');
            if (versionRow === null) {
              report('selfcheck:version-diff', { versionRow: false });
              return;
            }
            versionRow.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            setTimeout(() => {
              const root = rootRef.current;
              report('selfcheck:version-diff', {
                versionRow: true,
                diffRendered: root === null ? false : root.querySelector('.wcv-diff') !== null,
                diffLines: root === null ? 0 : root.querySelectorAll('.wcv-diffLine').length,
                addedLines: root === null ? 0 : root.querySelectorAll('.wcv-diffLine[data-type="add"]').length,
                removedLines: root === null ? 0 : root.querySelectorAll('.wcv-diffLine[data-type="del"]').length,
                diffStat:
                  root === null || root.querySelector('.wcv-diffStat') === null
                    ? null
                    : root.querySelector('.wcv-diffStat').textContent,
              });
            }, 500);

            // 再切到整页工作台看一眼「新建」入口在不在，然后切回来。
            const layout = optionalService(ctxRef.current ?? {}, 'layout');
            if (uiFlags.workbenchSelfTest !== true || layout === undefined || typeof layout.selectPanel !== 'function') {
              return;
            }
            layout.selectPanel(PANEL_ID);
            setTimeout(() => {
              const host = document.querySelector('.wcv-root--workbench');
              const titles = host === null ? [] : [...host.querySelectorAll('[title]')].map((n) => n.getAttribute('title'));
              report('selfcheck:workbench', {
                mounted: host !== null,
                iconButtons: host === null ? 0 : host.querySelectorAll('.wcv-iconBtn').length,
                titles,
                hasDocList: host === null ? false : host.querySelector('.wcv-colBody') !== null,
                hasPanelHeader: host === null ? false : host.querySelector('.wcv-header') !== null,
              });
              layout.selectPanel(null);
            }, 900);
          }, 300);
        }, 1500);
        return () => clearTimeout(timer);
      }, [variant, reloadToken, uiFlags]);

      /**
       * 订阅宿主的事件流。
       *
       * 这是「AI 一边写、画布一边长出来」的关键：宿主每次落盘都会推 doc-changed，
       * 我们据此拉取新版本。用户正在编辑时**不覆盖**他的内容，只提示有新版。
       *
       * 自愈式重连（必须有）：宿主插件每次热重载都会短暂摘掉 /events 路由，
       * 浏览器此时拿到 404，而按 EventSource 规范**永久放弃重连**。不自己重连的话，
       * 实时能力会静默失效——用户看到的就是「说好的流式没了」。
       */
      React.useEffect(() => {
        if (typeof EventSource !== 'function') return undefined;
        const query = targetQuery(target).toString();
        let source = null;
        let retryTimer = null;
        let disposed = false;
        let attempt = 0;

        const refresh = async () => {
          const { ok, data } = await apiGet('/doc', targetQuery(target));
          if (disposed || !ok) return;
          applyServer(data);
          setAnnotations(Array.isArray(data.annotations) ? data.annotations : []);
          setSuggestions(Array.isArray(data.suggestions) ? data.suggestions : []);
          setWriting(data.writing ?? { active: false, startedAt: null, note: '' });
          if (dirtyRef.current) {
            setMessage('AI 刚写入了新版本，但你本地还有未保存的改动，所以没有自动替换。');
            return;
          }
          // 只有 AI 正在写时才跟随：那是「字一个个长出来，视野跟着走」的场合。
          // 其余 doc-changed（例如用户自己打字触发的自动保存回显）只做同步，
          // 绝不能顺手把视图拉到底部。
          revealContent(data.latest?.content ?? '', { follow: data.writing?.active === true });
        };

        const scheduleRetry = () => {
          if (disposed) return;
          try {
            source?.close();
          } catch {
            // 忽略
          }
          source = null;
          const delay = Math.min(15_000, 800 * Math.max(1, attempt));
          retryTimer = setTimeout(connect, delay);
        };

        function connect() {
          if (disposed) return;
          attempt += 1;
          try {
            source = new EventSource(`${API_BASE}/events?${query}`);
          } catch (error) {
            report('sse:error', { phase: 'construct', reason: describe(error), attempt });
            scheduleRetry();
            return;
          }
          source.onopen = () => {
            attempt = 0;
            report('sse:open', {});
          };
          source.onmessage = (event) => {
            let payload = null;
            try {
              payload = JSON.parse(event.data);
            } catch {
              return;
            }
            if (payload?.type === 'doc-changed') void refresh();
            else if (payload?.type === 'canvas-intent') {
              // Agent 真的开始写正文了：把画布调到用户面前。
              // 这是「新建任务不再无条件弹画布」之后唯一的自动开启来源。
              openBeside('agent-write');
            } else if (payload?.type === 'writing') {
              setWriting({
                active: payload.active === true,
                startedAt: payload.startedAt ?? null,
                note: payload.note ?? '',
              });
            } else if (payload?.type === 'annotations-changed') {
              void apiGet('/annotations', targetQuery(target)).then(({ ok, data }) => {
                if (!disposed && ok) {
                  setAnnotations(data.annotations ?? []);
                  if (Array.isArray(data.suggestions)) setSuggestions(data.suggestions);
                }
              });
            }
          };
          source.onerror = () => {
            const state = source === null ? -1 : source.readyState;
            report('sse:error', { readyState: state, attempt });
            // CLOSED 表示浏览器已经放弃，必须由我们自己重连；
            // CONNECTING 表示它正在自动重连，交给它即可。
            if (state === 2 || state === -1) scheduleRetry();
          };
        }

        connect();

        /**
         * 切回窗口时补一次同步。
         *
         * 事件流是「推送才更新」，一旦错过一条（例如后端刚热重载完、连接正在重建），
         * 界面就会一直停在旧状态，而用户完全不知道要刷新。回到前台时主动拉一次，
         * 这类「明明已经有了却看不到」的问题就自愈了。
         */
        const syncOnReturn = () => {
          if (document.visibilityState === 'visible') void refresh();
        };
        document.addEventListener('visibilitychange', syncOnReturn);
        window.addEventListener('focus', syncOnReturn);

        return () => {
          disposed = true;
          if (retryTimer !== null) clearTimeout(retryTimer);
          document.removeEventListener('visibilitychange', syncOnReturn);
          window.removeEventListener('focus', syncOnReturn);
          try {
            source?.close();
          } catch {
            // 忽略
          }
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

      /**
       * 浮动工具条的定位锚点。
       *
       * AI 动作进入输入态后，textarea 会因输入框 autoFocus 而失焦，
       * onBlur 顺手清掉 selection——如果工具栏还挂在 selection 上，
       * 它连同刚出现的输入框会当场被卸载，用户看到的就是
       * 「点了改写什么都没出现，还得重新点一次」。
       * 所以 AI 动作自带选区快照，这里优先用它。
       */
      const floatAnchor = aiAction !== null ? { top: aiAction.top, left: aiAction.left } : selection;

      /**
       * 把浮动工具条夹进编辑器容器。
       *
       * 用 useLayoutEffect：必须在浏览器绘制前定好位，否则会先闪在错误位置。
       * 依赖里带上 aiAction 与选区，因为两者都会改变工具条的宽度（输入态更宽）。
       */
      React.useLayoutEffect(() => {
        if (floatAnchor === null) {
          setFloatPos(null);
          return;
        }
        const wrap = editorRef.current === null ? null : editorRef.current.parentElement;
        const bar = floatRef.current;
        if (wrap === null || bar === null) return;
        // 渲染风暴熔断：定位逻辑万一再次陷入「setState → 重渲染 → effect 再跑」的
        // 循环，界面会直接白屏且用户毫无办法。这里按秒计数，超限就放弃精确定位，
        // 让工具条退回左上角——难看总好过整块画布消失。
        const now = Date.now();
        if (now - floatBurstRef.current.at > 1000) {
          floatBurstRef.current = { at: now, count: 0 };
        }
        floatBurstRef.current.count += 1;
        if (floatBurstRef.current.count > 50) {
          if (floatBurstRef.current.count === 51) report('float:storm', { perSecond: 51 });
          return;
        }

        const next = clampFloatPosition({
          anchorLeft: floatAnchor.left,
          anchorTop: floatAnchor.top,
          barWidth: bar.offsetWidth,
          barHeight: bar.offsetHeight,
          wrapWidth: wrap.clientWidth,
          wrapHeight: wrap.clientHeight,
        });
        // 值没变就不要 setState：否则每次渲染都触发一次重渲染，直接死循环。
        setFloatPos((prev) =>
          prev !== null && prev.left === next.left && prev.top === next.top ? prev : next,
        );
        // 依赖必须用**原始值**。输入态下 floatAnchor 是每次渲染新建的对象
        // （{ top: aiAction.top, left: aiAction.left }），把它放进依赖会让 effect
        // 每次渲染都执行，配合 setState 就是无限循环——点一下「扩写」直接白屏。
      }, [floatAnchor?.left, floatAnchor?.top, aiAction]);

      /** 开始一个 AI 选区动作：快照选区，之后不再依赖实时 selection。 */
      const beginAiAction = (kind) => {
        if (selection === null) return;
        setAiDraft('');
        setAiAction({
          kind,
          range: { start: selection.start, end: selection.end },
          quote: selection.text,
          top: selection.top,
          left: selection.left,
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
          report('annotation:created', { kind, length: quote.length });
          return true;
        } catch (error) {
          setStatus('error');
          setMessage(`创建批注失败：${String(error)}`);
          return false;
        }
      };

      /**
       * 把一条批注交给 AI 处理：替用户把话发到输入框并提交。
       *
       * 桥没就绪时**不假装成功**——明说没发出去，并告诉用户怎么办。
       * 批注本身已经存好了，所以即使发送失败，用户仍可手动在对话里说一句。
       */
      const askAgentToHandle = (kind, instruction, quoteOverride) => {
        const label = ANNOTATION_KIND_LABEL[kind] ?? kind;
        const quote = (quoteOverride ?? '').trim();
        const brief = quote === '' ? '' : `\n选中内容：「${quote.slice(0, 60)}${quote.length > 60 ? '…' : ''}」`;
        // kind=comment 时 label 本身就是「批注」，再写成「批注（批注）」很别扭。
        const head =
          kind === 'comment' ? '请处理画布上的这条批注。' : `请处理画布上的批注（${label}）。`;
        const text =
          `${head}要求：${instruction}${brief}\n` +
          '用 writing_canvas_annotate 读取这条批注的准确位置与原文，改完把批注标记为 resolved。';
        const result = sendToConversation(target.sessionId, text);
        report('annotation:handoff', { kind, result });
        if (result === 'sent') {
          setMessage(`已交给 AI 处理（${label}）。它读取批注后会直接改画布，正文会实时更新。`);
        } else if (result === 'draft-busy') {
          setMessage(
            `批注已记下。但对话框里还有你没发出去的内容，我没有覆盖它——` +
              '请先把那段发出去或清空，再说一句「处理画布上的批注」。',
          );
        } else {
          setMessage(
            `批注已记下，但没能自动发到对话框（当前屏幕上不是这个会话，或输入框还没就绪）。` +
              '请在对话里说一句「处理画布上的批注」，AI 同样会读到它。',
          );
        }
      };

      /**
       * 提交浮动工具条上的 AI 选区动作。
       *
       * 选中文字 + 写明要求 = 一条带 anchor 的批注（author=user）。AI 用
       * writing_canvas_annotate 读走它并按位置改，改完把批注标为已处理。
       *
       * 这里是 window.prompt 的替代路径：Electron 不支持 prompt，
       * 原来那四个 AI 按钮因此点了没反应。
       */
      const submitAiAction = async () => {
        if (aiAction === null) return;
        const instruction = aiDraft.trim();
        if (instruction === '') return;
        const pending = aiAction;
        setAiAction(null);
        setAiDraft('');
        setSelection(null);
        // 用开始时的快照，不用实时 selection：这中间 textarea 已经失焦过一次。
        const created = await addAnnotation(pending.kind, instruction, pending.quote, pending.range);
        if (created === true) {
          // 留完批注直接把话替用户发出去，AI 收到就开始处理并实时写入画布。
          // 用户不必自己切到对话里复述一遍要求。
          askAgentToHandle(pending.kind, instruction);
        }
      };

      /**
       * 选中一个格式集就**立即生效**。
       *
       * 原先是「选中只改本地状态，必须再点一下对勾才写入文档」，用户反馈那个对勾
       * 又丑又多余（而且它的 Markdown 分支还写错了：提交的是 currentTypeId 而不是 set）。
       * 现在选中即写进文档 meta，不生成版本、不动正文。
       */
      const chooseSet = async (setId) => {
        setExportSpec(setId);
        setExportResult(null);
        try {
          const { ok, data } = await apiPost('/doc/format', { ...targetBody(target), setId });
          if (!ok || data?.ok !== true) throw new Error(data?.error ?? '保存失败');
          setDoc((current) =>
            current === null
              ? current
              : { ...current, meta: { ...(current.meta ?? {}), format: { ...(current.meta?.format ?? {}), set: setId === '' ? undefined : setId } } },
          );
          report('format:chosen', { setId });
        } catch (error) {
          setMessage(`保存格式集失败：${String(error)}`);
        }
      };

      /**
       * 打开「提示词」面板时把该类型的当前生效提示词拉下来。
       * 用户改过就是他那版，否则是内置拼装出来的默认值——都能继续编辑。
       */
      const loadTypePrompt = async (typeId) => {
        if (typeof typeId !== 'string' || typeId === '') return;
        try {
          const params = new URLSearchParams({ ...Object.fromEntries(targetQuery(target)), typeId });
          const { ok, data } = await apiGet('/type-prompt', params);
          if (!ok || data?.ok !== true) throw new Error(data?.error ?? '读取失败');
          setPromptText(data.text ?? '');
          setPromptSaved(data.text ?? '');
          setPromptIsCustom(data.isCustom === true);
        } catch (error) {
          setMessage(`读取提示词失败：${String(error)}`);
        }
      };

      /** 保存用户改过的提示词；传空串即恢复内置。 */
      const saveTypePrompt = async (text) => {
        if (currentTypeId === '') return;
        setPromptBusy(true);
        try {
          const { ok, data } = await apiPost('/type-prompt', {
            ...targetBody(target),
            typeId: currentTypeId,
            text,
          });
          if (!ok || data?.ok !== true) throw new Error(data?.error ?? '保存失败');
          setPromptIsCustom(data.isCustom === true);
          if (data.isCustom === true) {
            setPromptSaved(promptText);
            setMessage('已保存。这个写作类型的提示词现在用你的版本，Agent 已经能按它写作。');
          } else {
            // 恢复内置：把面板内容重新拉成内置版，避免显示与生效不一致。
            await loadTypePrompt(currentTypeId);
            setMessage('已恢复内置提示词。');
          }
        } catch (error) {
          setMessage(`保存提示词失败：${String(error)}`);
        } finally {
          setPromptBusy(false);
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

      /** 决定一条修改建议：接受才会真正写入正文（新版本），拒绝只改状态。 */
      const decideSuggestion = async (id, action) => {
        try {
          const { ok, data } = await apiPost('/suggestions/decide', { ...targetBody(target), id, action });
          if (!ok) {
            throw new Error(data?.message ?? data?.error ?? '操作失败');
          }
          setSuggestions(data.suggestions ?? []);
          if (data.applied === true && data.latest !== undefined) {
            applyServer({ ...data, exists: true, docId: target.docId, workspace: doc?.workspace });
            // 接受建议是用户主动要看的改写，跟随到新内容。
            revealContent(data.latest.content, { follow: true });
            setMessage(`已接受建议并写入 v${data.latest.n}。${data.message ?? ''}`);
          } else if (action === 'reject') {
            setMessage('已拒绝这条建议，正文未改动。');
          }
          report('suggestion:decide', { id, action, applied: data.applied === true });
        } catch (error) {
          setStatus('error');
          setMessage(`处理建议失败：${String(error)}`);
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

      /** 保存后清掉上一次的导出结论，避免显示过期的校验结果。 */
      React.useEffect(() => {
        setExportResult(null);
      }, [baseVersion]);

      /**
       * 有待决定的建议时自动展开抽屉——用户不该错过「AI 想改你的字」这件事。
       * 只在抽屉当前是收起状态时做一次，不会跟用户的手动操作打架。
       */
      React.useEffect(() => {
        if (pendingSuggestions > 0) {
          setPaneTab((current) => (current === 'none' ? 'suggestions' : current));
        }
      }, [pendingSuggestions]);

      /**
       * 一键套用格式：把当前正文按所选规格生成 DOCX，并展示**回读校验**的真实结果。
       * 校验未通过时如实显示失败项，不谎报成功。
       */
      /**
       * 导出 DOCX。
       *
       * 这里只做导出。原先它还兼着「确认使用这个格式集」，所以有一个 Markdown 分支；
       * 但那个分支写错了（提交的是 currentTypeId，不是 set），而且现在**选中格式集即生效**，
       * 不再需要确认动作，那个分支已经走不到——删掉，免得留下看着能用、实际是死路的代码。
       */
      const applyFormatSpec = async () => {
        setExporting(true);
        setExportResult(null);
        try {
          const { ok, data } = await apiPost('/export', {
            ...targetBody(target),
            specId: exportSpec === '' ? undefined : exportSpec,
            // 导出前先让用户选保存位置（系统目录选择框）。
            // 原先固定写进工作区的 exports/，用户没法选，这是明确被提过的问题。
            chooseDir: true,
          });
          // 用户在选择框里点了取消：不是错误，安静收场，也不生成文件。
          if (data?.error === 'cancelled') {
            setExporting(false);
            setMessage(null);
            report('export:cancelled', {});
            return;
          }
          setExportResult(data ?? null);
          report('export:done', {
            ok: data?.ok === true,
            specId: data?.specId ?? null,
            failed: data?.verification?.failed ?? null,
            total: data?.verification?.total ?? null,
            usedDefaultDir: data?.usedDefaultDir === true,
            pickerUnavailable: data?.pickerUnavailable === true,
          });
          if (data?.ok !== true) {
            setMessage(
              data?.error === 'python-unavailable'
                ? '套用格式失败：找不到可用的 Python（需要 python-docx）。'
                : `套用格式后校验未通过：${data?.message ?? data?.error ?? '未知原因'}`,
            );
            setStatus('error');
          } else {
            // 保存位置据实播报：没选成 / 没有选择器都要说清楚，不能让用户以为文件在别处。
            const where =
              data.usedDefaultDir !== true
                ? ''
                : data.pickerUnavailable === true
                  ? '（当前环境没有可用的目录选择器，已存到工作区的导出目录）'
                  : '（未选择位置，已存到工作区的导出目录）';
            setMessage(
              `已按「${data.specLabel}」生成 DOCX，${data.verification.total} 项回读校验全部通过：${data.relativePath}${where}`,
            );
            setStatus('ready');
          }
        } catch (error) {
          setStatus('error');
          setMessage(`套用格式失败：${String(error)}`);
        } finally {
          setExporting(false);
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
              allowEmpty: options.allowEmpty === true,
            });

            // 空内容覆盖被拦下：服务端有非空内容，而这次要写入的是空白。
            // 不静默清空，交给用户显式确认。
            if (httpStatus === 409 && data?.emptyRejected === true) {
              setEmptyBlocked(true);
              setMessage('正文为空，已阻止覆盖：服务端当前版本不是空的。如果确实要清空，请点下面的「确认清空」。');
              setStatus('ready');
              return;
            }

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
        // 撰写期间编辑框锁定为只读：Agent 正在逐字往这里写，
        // 双方同时写同一份正文必然冲突（客户端会拒绝用远端内容覆盖本地未保存改动，
        // 结果就是「边写边闪、内容对不上」）。写入结束即恢复可编辑。
        if (writing.active) return;
        const next = event.target.value;
        setText(next);
        if (next.trim() !== '') setEmptyBlocked(false);
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
      /** 当前选用的格式集：用户显式选择的优先，其次文档记录的，其次第一个。 */
      const currentSetId = exportSpec !== '' ? exportSpec : (doc?.meta?.format?.set ?? sets[0]?.id ?? '');
      const currentSet = sets.find((item) => item.id === currentSetId);

      /** 修改建议列表内容：原文与建议对照，逐条接受或拒绝。 */
      const renderSuggestionsBody = () =>
        suggestions.length === 0
          ? h(
              'div',
              { className: 'wcv-empty' },
              '还没有修改建议。当 AI 想改写你已有的文字时，它会以「建议」的形式出现在这里——原文与改法对照，由你决定接受或拒绝，正文不会在你点头之前被改动。',
            )
          : suggestions.map((item) =>
              h(
                'div',
                { key: item.id, className: 'wcv-sugg', 'data-status': item.status },
                h(
                  'div',
                  { className: 'wcv-annoHead' },
                  h('span', { className: 'wcv-annoKind' }, item.status === 'pending' ? '待决定' : item.status === 'accepted' ? '已接受' : '已拒绝'),
                  h('span', null, item.author === 'agent' ? 'AI' : '我'),
                  h('span', { style: { marginLeft: 'auto' } }, formatTime(item.createdAt)),
                ),
                item.anchorLost === true
                  ? h('div', { className: 'wcv-annoLost' }, '原文已不在正文中，无法应用（需重新生成建议）。')
                  : null,
                h('div', { className: 'wcv-diffDel' }, item.original),
                h('div', { className: 'wcv-diffIns' }, item.proposed),
                item.reason !== '' ? h('div', { className: 'wcv-annoText' }, item.reason) : null,
                item.status === 'pending'
                  ? h(
                      'div',
                      { className: 'wcv-annoActions' },
                      h(
                        'button',
                        { className: 'wcv-mini', disabled: item.anchorLost === true, onClick: () => void decideSuggestion(item.id, 'accept') },
                        '接受并写入',
                      ),
                      h('button', { className: 'wcv-mini', onClick: () => void decideSuggestion(item.id, 'reject') }, '拒绝'),
                    )
                  : null,
              ),
            );

      /** 批注列表内容（整页模式放右栏，窄栏模式放进底部抽屉）。 */
      const renderAnnotationsBody = () =>
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
                annotation.quote !== '' ? h('div', { className: 'wcv-annoQuote' }, annotation.quote) : null,
                annotation.anchorLost === true
                  ? h('div', { className: 'wcv-annoLost' }, '需重新标注：这段文字已不在正文中（正文被改过）。')
                  : null,
                annotation.instruction !== '' ? h('div', { className: 'wcv-annoText' }, annotation.instruction) : null,
                ...(Array.isArray(annotation.thread) ? annotation.thread : []).map((entry, index) =>
                  h('div', { key: index, className: 'wcv-annoThread' }, `${entry.author === 'agent' ? 'AI' : '我'}：${entry.text}`),
                ),
                annotation.status === 'open'
                  ? h(
                      'div',
                      { className: 'wcv-annoActions' },
                      // 让 AI 真的去改：把这条批注发到对话框，AI 读到后直接改画布。
                      // 原先只有「已处理/忽略/删除」，用户留了批注却没法让 AI 动手。
                      h(
                        'button',
                        {
                          className: 'wcv-mini wcv-mini--primary',
                          title: '把这条批注交给 AI：它会读取位置与原文，改完标记为已处理',
                          onClick: () =>
                            askAgentToHandle(annotation.kind, annotation.instruction, annotation.quote),
                        },
                        '让 AI 处理',
                      ),
                      h(
                        'button',
                        {
                          className: 'wcv-mini',
                          onClick: () =>
                            void updateAnnotation(annotation.id, {
                              status: 'resolved',
                              resolvedVersion: baseVersionRef.current,
                            }),
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
            );

      /** 版本历史列表内容。 */
      const renderVersionsBody = () =>
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
                      void apiGet(
                        '/doc/version',
                        new URLSearchParams({ ...Object.fromEntries(targetQuery(target)), n: String(version.n) }),
                      ).then(({ ok, data }) => {
                        if (ok) setViewing(data.version);
                      });
                    },
                  },
                  `v${version.n}`,
                  h('span', { className: 'wcv-verMeta' }, sourceLabel(version.source)),
                ),
                h('div', { className: 'wcv-verMeta' }, `${formatTime(version.at)} · ${version.bytes} 字节`),
                viewing?.n === version.n
                  ? h(
                      'div',
                      null,
                      // 差异视图：把这个历史版本与当前正文逐行对照
                      h(
                        'div',
                        { className: 'wcv-diffStat' },
                        (() => {
                          const lines = diffLines(viewing.content, text);
                          const added = lines.filter((l) => l.type === 'add').length;
                          const removed = lines.filter((l) => l.type === 'del').length;
                          return `与当前正文相比：+${added} 行 / -${removed} 行`;
                        })(),
                      ),
                      h(
                        'div',
                        { className: 'wcv-diff' },
                        ...diffLines(viewing.content, text).map((line, index) =>
                          h(
                            'div',
                            { key: index, className: 'wcv-diffLine', 'data-type': line.type },
                            h('span', { className: 'wcv-diffSign' }, line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' '),
                            h('span', null, line.text === '' ? ' ' : line.text),
                          ),
                        ),
                      ),
                      h(
                        'div',
                        { className: 'wcv-actions' },
                        h('button', { className: 'wcv-btn', onClick: () => void restore(version.n) }, '还原到此版本'),
                        h('button', { className: 'wcv-btn', onClick: () => setViewing(null) }, '收起'),
                      ),
                    )
                  : null,
              ),
            );

      // 右栏（pane）是多标签页形态：标签本身已经写着「写作画布」，
      // 画布内再顶一个同名抬头 + 一行文档副标题就是重复且诡异。
      // 所以 pane 不渲染抬头，状态徽标并入下面工具栏的右端。
      // 整页工作台（workbench）另有形态，保留标题。
      const pill = h(
        'span',
        { className: 'wcv-pill' },
        h('span', { className: 'wcv-dot', 'data-state': state }),
        stateText,
      );

      return h(
        'div',
        { className: `wcv-root wcv-root--${variant}${richOn ? ' wcv-root--rich' : ''}`, ref: rootRef },
        variant === 'pane'
          ? null
          : h(
              'div',
              { className: 'wcv-header' },
              h('div', { className: 'wcv-title' }, '写作工作台'),
              h('div', { className: 'wcv-sub' }, `${title} · ${doc?.workspace ?? ''}`),
              props.headerExtra === undefined ? null : props.headerExtra(),
              pill,
            ),

        emptyBlocked
          ? h(
              'div',
              { className: 'wcv-banner wcv-banner--warn' },
              '正文为空，已阻止覆盖：服务端当前版本不是空的。',
              h(
                'div',
                { className: 'wcv-actions' },
                h(
                  'button',
                  {
                    className: 'wcv-btn',
                    onClick: () => {
                      setEmptyBlocked(false);
                      void save({ allowEmpty: true, note: '用户确认清空文档' });
                    },
                  },
                  '确认清空',
                ),
                h(
                  'button',
                  {
                    className: 'wcv-btn wcv-btn--primary',
                    onClick: () => {
                      setEmptyBlocked(false);
                      setReloadToken((n) => n + 1);
                    },
                  },
                  '载入服务端版本',
                ),
              ),
            )
          : null,

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

        // 提示条：必须能关掉。此前它只能被下一条消息替换，用户点完「+ Set」
        // 或导出后那段说明就一直挂在那儿，怎么都去不掉。
        message !== null
          ? h(
              'div',
              { className: `wcv-banner${status === 'error' ? ' wcv-banner--error' : ''}` },
              h('span', { className: 'wcv-bannerText' }, message),
              h(
                'button',
                {
                  className: 'wcv-bannerClose',
                  title: '关闭这条提示',
                  'aria-label': '关闭这条提示',
                  onClick: () => {
                    setMessage(null);
                    if (status === 'error') setStatus('ready');
                  },
                },
                '×',
              ),
            )
          : null,

        // 提示词面板：不再是只读的硬约束清单，改成**可编辑**——
        // 用户点开就能改这个写作类型的提示词，保存后立刻对它生效。
        showConstraints && currentType !== undefined
          ? h(
              'div',
              { className: 'wcv-prompt' },
              h(
                'div',
                { className: 'wcv-promptHead' },
                h('span', { className: 'wcv-promptTitle' }, `${currentType.label} · 提示词`),
                promptIsCustom
                  ? h('span', { className: 'wcv-formatTag' }, '已用你的版本')
                  : h('span', { className: 'wcv-formatTag' }, '内置版本'),
                h('span', { className: 'wcv-toolSpacer' }),
                h(
                  'button',
                  {
                    className: 'wcv-mini',
                    title: '放弃当前改动，重新载入生效中的提示词',
                    onClick: () => {
                      setPromptText(promptSaved);
                    },
                  },
                  '撤销改动',
                ),
                h(
                  'button',
                  {
                    className: 'wcv-mini',
                    title: '删掉你的覆盖，回到内置提示词',
                    disabled: promptBusy || !promptIsCustom,
                    onClick: () => void saveTypePrompt(''),
                  },
                  '恢复内置',
                ),
                h(
                  'button',
                  {
                    className: 'wcv-mini wcv-mini--primary',
                    disabled: promptBusy || promptText === promptSaved,
                    title: '保存后 Agent 立刻按这版提示词写作',
                    onClick: () => void saveTypePrompt(promptText),
                  },
                  promptBusy ? '保存中…' : '保存',
                ),
              ),
              h('textarea', {
                className: 'wcv-promptText',
                value: promptText,
                spellCheck: false,
                placeholder: '这个写作类型的提示词。写清约束、必确认要素、结构骨架与自检清单。',
                onChange: (event) => setPromptText(event.target.value),
              }),
              h(
                'div',
                { className: 'wcv-promptHint' },
                '这段提示词只在写作模式下注入，且优先级高于内置约束。清空并保存即恢复内置。',
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
              // 第一行：类型 / 提示词 / 格式集 + 导出动作，右端是撰写中与状态。
              // 明确分两行，是为了不让格式按钮被 chip 挤到中间断掉——
              // 之前 13 个格式按钮被拆成 5+8，换行位置看着很乱。
              h(
                'div',
                { className: 'wcv-toolRow' },
              // ---- 类型 / 格式集：做成按钮。chip 外观 + 覆盖其上的透明原生 select：
              //      看起来是按钮，行为仍是原生下拉（键盘、无障碍都不丢）。
              h(
                'label',
                {
                  className: 'wcv-meta',
                  'data-set': currentTypeId === '' ? 'false' : 'true',
                  title:
                    currentType === undefined
                      ? '选择写作类型：选定后我会先问清必确认要素再动笔'
                      : `${currentType.summary ?? ''}${
                          (currentType.mustConfirm?.length ?? 0) > 0
                            ? `\n生成前会确认：${currentType.mustConfirm.join('、')}`
                            : ''
                        }`,
                },
                h('span', { className: 'wcv-metaText' }, currentType?.label ?? '未指定类型'),
                h('span', { className: 'wcv-metaCaret' }, '▾'),
                h(
                  'select',
                  {
                    className: 'wcv-metaSelect wcv-select',
                    value: currentTypeId,
                    onChange: (event) => void chooseType(event.target.value),
                  },
                  h('option', { value: '' }, '未指定'),
                  ...types.map((type) => h('option', { key: type.id, value: type.id }, type.label)),
                ),
              ),
              currentType !== undefined && currentType.constraints?.length
                ? h(
                    'button',
                    {
                      className: 'wcv-meta',
                      'data-set': promptIsCustom ? 'true' : 'false',
                      title: '查看并编辑这个写作类型的提示词',
                      onClick: () => {
                        const next = !showConstraints;
                        setShowConstraints(next);
                        // 展开时才去拉内容：面板关闭时不浪费一次请求。
                        if (next) void loadTypePrompt(currentTypeId);
                      },
                    },
                    h('span', { className: 'wcv-metaText' }, '提示词'),
                  )
                : null,
              h(
                'label',
                {
                  className: 'wcv-meta',
                  title: currentSet === undefined ? '选择格式集' : currentSet.description,
                },
                h(
                  'span',
                  { className: 'wcv-metaText' },
                  `${currentSet?.kind === 'docx' ? 'DOCX' : 'MD'} · ${currentSet?.name ?? '默认'}`,
                ),
                h('span', { className: 'wcv-metaCaret' }, '▾'),
                h(
                  'select',
                  {
                    className: 'wcv-metaSelect wcv-select',
                    value: currentSetId,
                    onChange: (event) => void chooseSet(event.target.value),
                  },
                  ...sets.map((item) =>
                    h(
                      'option',
                      { key: item.id, value: item.id },
                      `${item.kind === 'docx' ? 'DOCX' : 'MD'} · ${item.name}${item.source === 'user' ? '（我的）' : ''}`,
                    ),
                  ),
                ),
              ),
              // 只有 DOCX 才需要一个动作按钮（导出是真动作）。
              // 原先那个对勾是「确认使用这个 set」——现在选中即生效，它没有存在理由。
              currentSet !== undefined && currentSet.kind === 'docx'
                ? iconButton({
                    icon: exporting ? IconRefresh : IconDownload,
                    title: exporting ? '正在导出…' : '导出 DOCX（会先让你选保存位置，生成后回读校验）',
                    primary: true,
                    disabled: exporting,
                    onClick: () => void applyFormatSpec(),
                  })
                : null,
              currentSet !== undefined && currentSet.source === 'user'
                ? iconButton({
                    icon: IconTrash,
                    title: '删除这个格式集',
                    onClick: async () => {
                      await apiPost('/format-sets/delete', { ...targetBody(target), id: currentSet.id });
                      setExportSpec('');
                      setSets((list) => list.filter((item) => item.id !== currentSet.id));
                    },
                  })
                : null,
              iconButton({
                icon: IconPlus,
                title: '新建格式集：在对话里告诉我你想要的格式',
                onClick: () =>
                  setMessage(
                    '想新建格式集？直接在对话里告诉我：' +
                      '「做成格式集：正文小四宋体、标题黑体、行距 1.5 倍」或「按这个模板的样式做一套」。' +
                      '我会整理成 Set 存进这个工作区，之后在这里一键选用。',
                  ),
              }),
              exportResult !== null
                ? h(
                    'span',
                    { className: 'wcv-formatTag' },
                    exportResult.ok === true
                      ? `✓ 校验 ${exportResult.verification.total}/${exportResult.verification.total}`
                      : `✗ 校验未过${exportResult.verification ? ` (${exportResult.verification.failed}/${exportResult.verification.total})` : ''}`,
                  )
                : null,
              // 第一行右端：撰写中指示 + 状态徽标（pane 没有抬头，状态落在这里）。
              h('span', { className: 'wcv-toolSpacer' }),
              writing.active
                ? h(
                    'span',
                    { className: 'wcv-writing' },
                    h('span', { className: 'wcv-writingDot' }),
                    '撰写中…',
                    // 用户往上翻过就明说「不跟了」，并给一个回到末尾的入口；
                    // 否则视图不动会让人以为写卡住了。
                    followPaused
                      ? h(
                          'button',
                          {
                            className: 'wcv-followBack',
                            title: '回到最新写出的位置，继续跟随',
                            onMouseDown: (event) => event.preventDefault(),
                            onClick: () => {
                              followPausedRef.current = false;
                              setFollowPaused(false);
                              scrollEditorToEnd();
                            },
                          },
                          '已暂停跟随 · 回到末尾',
                        )
                      : null,
                  )
                : null,
              pill,
              ),
              // 第二行：纯格式按钮。整行留给它，换行位置就稳定了。
              h(
                'div',
                { className: 'wcv-toolRow wcv-toolRow--formats' },
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
                // 所见即所得开关。默认开着；关掉就是原来的纯源码视图，
                // 想看语法标记、或者怀疑对齐有问题时可以切回来对照。
                h('span', { key: 'mdSep', className: 'wcv-toolSep' }),
                h(
                  'button',
                  {
                    key: 'mdToggle',
                    className: `wcv-tool wcv-tool--wide${richOn ? ' wcv-tool--on' : ''}`,
                    title: richOn
                      ? '当前：所见即所得（隐藏 Markdown 标记）。点一下切回源码视图'
                      : '当前：源码视图。点一下切到所见即所得',
                    onMouseDown: (event) => event.preventDefault(),
                    onClick: () => {
                      setRichText((on) => !on);
                      // 用户手动切回富文本时，给对齐体检一次重新判断的机会。
                      setRichSafe(true);
                      report('richtext:toggle', { on: !richText });
                    },
                  },
                  richOn ? 'MD' : '#',
                ),
              ),
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
                    ...renderRichText(text, annotations, suggestions),
                  ),
                ),
                // 空白文档 + 未指定类型时，先让用户选写作模式（新会话的入口体验）
                text.trim() === '' && currentTypeId === '' && !writing.active
                  ? h(
                      'div',
                      { className: 'wcv-onboard' },
                      h('div', { className: 'wcv-onboardTitle' }, '开始写作'),
                      h(
                        'div',
                        { className: 'wcv-onboardHint' },
                        '先选一个写作类型——选好后我会先问清必要信息再动笔。',
                      ),
                      h(
                        'div',
                        { className: 'wcv-chips' },
                        h(
                          'button',
                          {
                            className: 'wcv-chip',
                            title: '不限定类型，按通用要求写',
                            onClick: () => {
                              setMessage('好，这次不限定写作类型。你直接说要写什么，我会先问清必要信息。');
                              editorRef.current?.focus();
                            },
                          },
                          '暂不指定',
                        ),
                        ...types.map((type) =>
                          h(
                            'button',
                            {
                              key: type.id,
                              className: 'wcv-chip',
                              'data-custom': type.custom === true ? 'true' : 'false',
                              title: `${type.summary ?? ''}${(type.mustConfirm ?? []).length > 0 ? `\n生成前会确认：${type.mustConfirm.join('、')}` : ''}`,
                              onClick: () => void chooseType(type.id),
                            },
                            type.label,
                          ),
                        ),
                        h(
                          'button',
                          {
                            className: 'wcv-chip wcv-chip--ghost',
                            title: '想要内置类型覆盖不到的文种？告诉我，我给你建一个',
                            onClick: () =>
                              setMessage(
                                '想新建写作类型？在对话里告诉我它的用途与要求（例如「我要写产品需求文档，必须包含背景、目标、范围、验收标准」），' +
                                  '我会为它建立专属的硬约束、必确认要素与自检清单，之后就能在这里选到。',
                              ),
                          },
                          '+ 新建类型',
                        ),
                      ),
                    )
                  : null,
                h('textarea', {
                  className: `wcv-editor wcv-editor--over${writing.active ? ' wcv-editor--locked' : ''}`,
                  ref: editorRef,
                  value: text,
                  spellCheck: false,
                  // 撰写期间锁为只读：避免与 Agent 的流式写入互相覆盖。
                  readOnly: writing.active === true,
                  'aria-readonly': writing.active === true ? 'true' : 'false',
                  placeholder: writing.active
                    ? 'Agent 正在写入…'
                    : '在这里开始写，或让 Agent 把草稿写进这份文档……',
                  onChange,
                  onScroll: (event) => {
                    const layer = highlightRef.current;
                    if (layer !== null) layer.scrollTop = event.target.scrollTop;
                    // 用户自己滚的才改跟随状态；程序滚动不算，否则会自我打断。
                    if (!programmaticScrollRef.current) {
                      const el = event.target;
                      const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
                      const paused = !nearBottom;
                      if (followPausedRef.current !== paused) {
                        followPausedRef.current = paused;
                        setFollowPaused(paused);
                      }
                    }
                    // 滚动条是随内容出现的，滚动时再量一次最稳。
                    syncHighlightMetrics();
                  },
                  onSelect: syncSelection,
                  onKeyUp: syncSelection,
                  onMouseUp: syncSelection,
                  // 点回正文即取消 AI 输入态：否则输入框会一直挂在上面，
                  // 用户以为界面卡住了（这正是「点了改写之后再也没法正常选字」的观感）。
                  onFocus: () => {
                    if (aiAction !== null) {
                      setAiAction(null);
                      setAiDraft('');
                    }
                  },
                  onBlur: () => setSelection(null),
                }),
                // 选区浮动工具条：格式按钮 + AI 动作。
                floatAnchor !== null
                  ? h(
                      'div',
                      {
                        ref: floatRef,
                        className: `wcv-float${aiAction !== null ? ' wcv-float--input' : ''}`,
                        style:
                          floatPos === null
                            ? { visibility: 'hidden', top: 0, left: 0 }
                            : { top: `${floatPos.top}px`, left: `${floatPos.left}px` },
                        // 输入态**不能** preventDefault：它会阻止输入框获得焦点，
                        // 结果就是输入框摆在眼前却打不了字。
                        onMouseDown: aiAction === null ? (event) => event.preventDefault() : undefined,
                      },
                      // 输入态：AI 动作先问要求，再落成批注。
                      aiAction !== null
                        ? [
                            h(
                              'span',
                              { key: 'label', className: 'wcv-floatLabel' },
                              `${ANNOTATION_KIND_LABEL[aiAction.kind] ?? aiAction.kind}：`,
                            ),
                            h('input', {
                              key: 'input',
                              className: 'wcv-floatInput',
                              autoFocus: true,
                              value: aiDraft,
                              placeholder:
                                aiAction.kind === 'comment'
                                  ? '写下你的批注…'
                                  : '写下要求，例如「更克制，去掉形容词」…',
                              onChange: (event) => setAiDraft(event.target.value),
                              onKeyDown: (event) => {
                                if (event.key === 'Enter') {
                                  event.preventDefault();
                                  void submitAiAction();
                                } else if (event.key === 'Escape') {
                                  event.preventDefault();
                                  setAiAction(null);
                                  setAiDraft('');
                                }
                              },
                            }),
                            h(
                              'button',
                              {
                                key: 'ok',
                                className: 'wcv-floatBtn wcv-floatBtn--primary',
                                title: '确定（回车）',
                                disabled: aiDraft.trim() === '',
                                onClick: () => void submitAiAction(),
                              },
                              '确定',
                            ),
                            h(
                              'button',
                              {
                                key: 'cancel',
                                className: 'wcv-floatBtn',
                                title: '取消（Esc）',
                                onClick: () => {
                                  setAiAction(null);
                                  setAiDraft('');
                                },
                              },
                              '取消',
                            ),
                          ]
                        : [
                            ...[
                              ['bold', 'B', '加粗'],
                              ['italic', 'I', '斜体'],
                              ['strike', 'S', '删除线'],
                              ['code', '</>', '行内代码'],
                            ].map(([kind, glyph, label]) =>
                              h(
                                'button',
                                {
                                  key: kind,
                                  className: 'wcv-floatBtn',
                                  title: label,
                                  onClick: () => applyFormat(kind),
                                },
                                glyph,
                              ),
                            ),
                            h('span', { key: 'sep', className: 'wcv-toolSep' }),
                            ...['rewrite', 'expand', 'shorten', 'polish'].map((kind) =>
                              h(
                                'button',
                                {
                                  key: kind,
                                  className: 'wcv-floatBtn wcv-floatBtn--ai',
                                  title: `让 AI 对选中内容${ANNOTATION_KIND_LABEL[kind]}（会先问你要求）`,
                                  onClick: () => beginAiAction(kind),
                                },
                                ANNOTATION_KIND_LABEL[kind],
                              ),
                            ),
                            h(
                              'button',
                              {
                                key: 'comment',
                                className: 'wcv-floatBtn wcv-floatBtn--ai',
                                title: '在这段文字上留一条批注，AI 读到后会处理',
                                onClick: () => beginAiAction('comment'),
                              },
                              '批注',
                            ),
                          ],
                    )
                  : null,
              ),
            ),
          ),

          // 建议面板（整页模式放右栏最前；窄栏模式隐藏，内容改由底部抽屉呈现）
          h(
            'div',
            { className: variant === 'workbench' ? 'wcv-col' : 'wcv-col wcv-hidden' },
            h('div', { className: 'wcv-colHead' }, `修改建议（${pendingSuggestions} 待决定 / ${suggestions.length}）`),
            h('div', { className: 'wcv-colBody' }, renderSuggestionsBody()),
          ),

          // 批注面板（整页模式放右栏；窄栏模式隐藏，内容改由底部抽屉呈现）
          h(
            'div',
            { className: variant === 'workbench' ? 'wcv-col' : 'wcv-col wcv-hidden' },
            h('div', { className: 'wcv-colHead' }, `批注（${openCount} 待处理 / ${annotations.length}）`),
            h('div', { className: 'wcv-colBody' }, renderAnnotationsBody()),
          ),

          h(
            'div',
            { className: variant === 'workbench' ? 'wcv-col' : 'wcv-col wcv-hidden' },
            h('div', { className: 'wcv-colHead' }, `版本历史（${versions.length}）`),
            h('div', { className: 'wcv-colBody' }, renderVersionsBody()),
          ),
        ),

        // 窄栏模式的底部抽屉：默认收起，点标签才展开，绝不挤压正文。
        variant === 'pane'
          ? h(
              'div',
              { className: 'wcv-drawer' },
              h(
                'div',
                { className: 'wcv-drawerTabs' },
                h(
                  'button',
                  {
                    className: 'wcv-drawerTab',
                    'data-active': paneTab === 'suggestions' ? 'true' : 'false',
                    // 有待决定的新建议时高亮，否则用户根本注意不到这个标签。
                    'data-alert': pendingSuggestions > 0 ? 'true' : 'false',
                    title: pendingSuggestions > 0 ? 'AI 提交了修改建议，点开逐条决定接受或拒绝' : '修改建议',
                    onClick: () => setPaneTab((current) => (current === 'suggestions' ? 'none' : 'suggestions')),
                  },
                  `建议 ${pendingSuggestions}${suggestions.length > pendingSuggestions ? `/${suggestions.length}` : ''}`,
                ),
                h(
                  'button',
                  {
                    className: 'wcv-drawerTab',
                    'data-active': paneTab === 'annotations' ? 'true' : 'false',
                    'data-alert': openCount > 0 ? 'true' : 'false',
                    title: openCount > 0 ? '有未处理的批注' : '批注',
                    onClick: () => setPaneTab((current) => (current === 'annotations' ? 'none' : 'annotations')),
                  },
                  `批注 ${openCount}/${annotations.length}`,
                ),
                h(
                  'button',
                  {
                    className: 'wcv-drawerTab',
                    'data-active': paneTab === 'versions' ? 'true' : 'false',
                    onClick: () => setPaneTab((current) => (current === 'versions' ? 'none' : 'versions')),
                  },
                  `版本 ${versions.length}`,
                ),
                h('span', { className: 'wcv-drawerSpacer' }),
                h('span', { className: 'wcv-drawerMeta' }, `${text.length} 字`),
              ),
              paneTab === 'none'
                ? null
                : h(
                    'div',
                    { className: 'wcv-drawerBody' },
                    paneTab === 'suggestions'
                      ? renderSuggestionsBody()
                      : paneTab === 'annotations'
                        ? renderAnnotationsBody()
                        : renderVersionsBody(),
                  ),
            )
          : null,

        // 底栏：pane 下整条不渲染——右下角已经有多标签页和抽屉，再挂一行
        // 「文档 s-session-xxxx 工作区 /Users/... 最近更新 …」又长又没信息量。
        // workbench 是整页形态，留一行极简信息，长串（docId / 工作区路径）收进悬浮提示。
        variant === 'pane'
          ? null
          : h(
              'div',
              {
                className: 'wcv-foot',
                title: `${doc?.docId ?? ''}\n${doc?.workspace ?? ''}`,
              },
              doc?.meta?.updatedAt !== undefined
                ? h('span', null, `最近更新 ${formatTime(doc.meta.updatedAt)}`)
                : null,
              h('span', { style: { marginLeft: 'auto' } }, `${text.length} 字`),
            ),
      );
    }

    /**
     * 极简图标集：按钮尽量用图标，说明文字放在 title（悬浮提示）里。
     * 全部用 currentColor 描边，自动跟随主题。
     */
    function makeIcon(paths, viewBox) {
      return function Icon(props) {
        const size =
          props !== null && typeof props === 'object' && typeof props.size === 'number' && props.size > 0
            ? props.size
            : 16;
        return h(
          'svg',
          {
            width: size,
            height: size,
            viewBox: viewBox ?? '0 0 24 24',
            fill: 'none',
            stroke: 'currentColor',
            strokeWidth: 1.7,
            strokeLinecap: 'round',
            strokeLinejoin: 'round',
            'aria-hidden': 'true',
          },
          ...paths.map((d, index) => h('path', { key: index, d })),
        );
      };
    }

    const IconPlus = makeIcon(['M12 5v14', 'M5 12h14']);
    const IconChat = makeIcon(['M21 12a8 8 0 0 1-8 8H7l-4 3v-6a8 8 0 0 1 8-8h2a8 8 0 0 1 8 3Z']);
    const IconDoc = makeIcon(['M7 3h7l5 5v13H7z', 'M14 3v5h5']);
    const IconTrash = makeIcon(['M4 7h16', 'M9 7V5h6v2', 'M6 7l1 13h10l1-13']);
    const IconRefresh = makeIcon(['M20 12a8 8 0 1 1-2.3-5.6', 'M20 4v5h-5']);
    const IconDownload = makeIcon(['M12 3v12', 'M7 11l5 5 5-5', 'M4 20h16']);

    /**
     * 统一的图标按钮：title 必填（悬浮说明），图标本身不承载文字。
     * @param props - { icon, title, onClick, primary, disabled, keepFocus, size }
     */
    function iconButton(props) {
      return h(
        'button',
        {
          className: `wcv-iconBtn${props.primary === true ? ' wcv-iconBtn--primary' : ''}`,
          title: props.title,
          'aria-label': props.title,
          disabled: props.disabled === true,
          onMouseDown: props.keepFocus === true ? (event) => event.preventDefault() : undefined,
          onClick: props.onClick,
        },
        h(props.icon, { size: props.size ?? 16 }),
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
      return h(Canvas, { key: String(sessionId), target: { sessionId }, variant: 'pane', ctx: pluginCtx });
    }

    /** 工作台整页：跨会话浏览/编辑工作区内的文档。 */
    function WorkbenchPanel(props) {
      const [index, setIndex] = React.useState(null);
      const [selected, setSelected] = React.useState(null);
      const [reloadToken, setReloadToken] = React.useState(0);

      /** 顶部动作：全部用图标 + 悬浮说明，不放文字按钮。 */
      const actions = props?.actions ?? {};
      const headerExtra = () =>
        h(
          'span',
          { className: 'wcv-actionGroup', style: { marginLeft: 'auto' } },
          iconButton({
            icon: IconDoc,
            title: '新建文档（在当前工作区）',
            onClick: () => void createDocument(),
          }),
          iconButton({
            icon: IconChat,
            title: '新建会话',
            onClick: () => actions.newSession?.(),
          }),
          iconButton({
            icon: IconRefresh,
            title: '刷新文档列表',
            onClick: () => setReloadToken((n) => n + 1),
          }),
          iconButton({
            icon: IconPlus,
            title: '在对话旁打开画布',
            primary: true,
            onClick: () => actions.openBeside?.('workbench'),
          }),
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

      /** 新建文档要落在哪个工作区：优先当前选中的，其次第一个。 */
      const targetWorkspace = selected?.workspace ?? index?.workspaces?.[0]?.path ?? null;

      /** 新建文档并立刻切过去。 */
      const createDocument = async () => {
        const created = await actions.newDocument?.(targetWorkspace);
        if (created !== null && created !== undefined) {
          setSelected({ workspace: created.workspace, docId: created.docId });
          setReloadToken((n) => n + 1);
        }
      };

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
                        title: `${doc.title}\n${doc.workspace}\nv${doc.latest} · ${formatTime(doc.updatedAt)}`,
                        onClick: () => pick(doc),
                      },
                      h(IconDoc, { size: 15 }),
                      h(
                        'div',
                        { className: 'wcv-docMain' },
                        h('div', null, doc.title),
                        h('div', { className: 'wcv-docMeta' }, `v${doc.latest} · ${formatTime(doc.updatedAt)}`),
                      ),
                    ),
                  ),
            h(
              'div',
              { className: 'wcv-actions' },
              iconButton({
                icon: IconPlus,
                title: '新建文档',
                primary: true,
                onClick: () => void createDocument(),
              }),
              iconButton({ icon: IconRefresh, title: '刷新列表', onClick: () => setReloadToken((n) => n + 1) }),
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
            h('div', { className: 'wcv-sub' }, '选择一个文档，或新建一个'),
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
        ctx: pluginCtx,
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
    function makeWorkbenchPanel(actions) {
      return function WorkbenchPanelWithActions(props) {
        return h(WorkbenchPanel, { ...props, actions });
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
     * 把正文切成 普通文本 / 已标记 交替的片段，用于「批注高亮层」。
     *
     * 关于建议：高亮层必须与 textarea 的文本**严格逐字对齐**，否则整层会错位。
     * 因此这里**不把建议的 proposed 插进来**，只把原文区间标成波浪线；
     * 「改成什么」放在旁边的建议面板里对照显示。
     *
     * @param content - 正文。
     * @param annotations - 批注数组。
     * @param suggestions - 建议数组（可选）。
     * @returns [{ text, mark?, status?, kind? }]
     */
    function buildHighlightSegments(content, annotations, suggestions) {
      const ranges = [];
      for (const item of suggestions ?? []) {
        if (item.status !== 'pending' || item.anchorLost === true) continue;
        const start = Math.max(0, Math.min(item.range?.start ?? 0, content.length));
        const end = Math.max(0, Math.min(item.range?.end ?? 0, content.length));
        if (end > start) ranges.push({ start, end, mark: 'suggestion', status: 'pending', kind: 'suggestion' });
      }
      for (const item of annotations) {
        if (item.anchorLost === true) continue;
        const start = Math.max(0, Math.min(item.range?.start ?? 0, content.length));
        const end = Math.max(0, Math.min(item.range?.end ?? 0, content.length));
        if (end > start) ranges.push({ start, end, mark: 'note', status: item.status, kind: item.kind });
      }
      ranges.sort((a, b) => a.start - b.start || a.end - b.end);

      const segments = [];
      let cursor = 0;
      for (const range of ranges) {
        if (range.start < cursor) continue; // 重叠区间只画第一个，避免标记错乱
        if (range.start > cursor) segments.push({ text: content.slice(cursor, range.start), mark: false });
        segments.push({
          text: content.slice(range.start, range.end),
          mark: range.mark,
          status: range.status,
          kind: range.kind,
        });
        cursor = range.end;
      }
      if (cursor < content.length) segments.push({ text: content.slice(cursor), mark: false });
      return segments;
    }

    /**
     * 行内 Markdown 的语法标记。
     *
     * 只支持写作里真正用得到的几种。刻意**不支持** `_强调_`：中文稿件里下划线
     * 更多出现在文件名与变量名（如 my_var）里，支持它会大面积误判。
     */
    const MD_INLINE_RULES = [
      { open: '**', style: 'bold' },
      { open: '~~', style: 'strike' },
      { open: '`', style: 'code' },
      { open: '*', style: 'italic' },
    ];

    /** 在已确定样式的基础上继续扫描行内标记。 */
    function scanMarkdownInline(text, style, out, depth) {
      // 递归深度兜底：畸形输入（比如一连串星号）不能把界面拖死。
      if (depth > 6) {
        out.push({ text, style });
        return;
      }
      let i = 0;
      while (i < text.length) {
        let matched = false;
        for (const rule of MD_INLINE_RULES) {
          if (!text.startsWith(rule.open, i)) continue;
          const closeAt = text.indexOf(rule.open, i + rule.open.length);
          if (closeAt <= i + rule.open.length) continue;
          const inner = text.slice(i + rule.open.length, closeAt);
          // 跨行的标记不当强调处理（用户可能只是在换行处打了个星号）。
          if (inner.includes('\n')) continue;
          out.push({ text: rule.open, hidden: true });
          scanMarkdownInline(inner, rule.style, out, depth + 1);
          out.push({ text: rule.open, hidden: true });
          i = closeAt + rule.open.length;
          matched = true;
          break;
        }
        if (matched) continue;

        // 链接：只显示文字，方括号与地址部分占位隐藏。
        const link = /^\[([^\]\n]+)\]\(([^)\n]*)\)/.exec(text.slice(i));
        if (link !== null) {
          out.push({ text: '[', hidden: true });
          scanMarkdownInline(link[1], 'link', out, depth + 1);
          out.push({ text: `](${link[2]})`, hidden: true });
          i += link[0].length;
          continue;
        }

        out.push({ text: text[i], style });
        i += 1;
      }
    }

    /**
     * 把一段 Markdown 解析成可直接渲染的片段。
     *
     * **核心约束：一个字符都不能删。** 语法标记不是被去掉，而是标记为 hidden，
     * 交给 CSS 用 `visibility: hidden` 占位——占位会保留宽度，于是渲染层与
     * textarea 的字符宽度、换行位置、光标坐标三者完全一致，编辑才不会错位。
     * 这也是本方案不改变字号的原因：字号一变，宽度就变，对齐立刻破功。
     *
     * @param text - 片段文本。
     * @param options.atLineStart - 该片段是否从行首开始（行级标记只在行首生效）。
     * @returns [{ text, style, hidden }]，拼起来与入参逐字符相等。
     */
    function markdownInlineSegments(text, options) {
      const out = [];
      const opts = options !== null && typeof options === 'object' ? options : {};
      const fenceLines = Array.isArray(opts.fenceLines) ? opts.fenceLines : null;
      let lineNo = typeof opts.firstLine === 'number' ? opts.firstLine : 0;
      let lineStart = opts.atLineStart === true;
      let i = 0;
      while (i <= text.length) {
        const nl = text.indexOf('\n', i);
        const end = nl === -1 ? text.length : nl;
        let line = text.slice(i, end);
        let style = '';
        // 代码块内部原样保留：段内的 # 不该变成标题，** 也不该变成粗体。
        const inFence = fenceLines !== null && fenceLines[lineNo] === true;

        if (inFence) {
          out.push({ text: line });
          if (nl === -1) break;
          out.push({ text: '\n' });
          i = nl + 1;
          lineStart = true;
          lineNo += 1;
          continue;
        }

        if (lineStart) {
          const heading = /^(#{1,6}\s+)/.exec(line);
          if (heading !== null) {
            out.push({ text: heading[1], hidden: true });
            line = line.slice(heading[0].length);
            style = 'heading';
          } else {
            const quote = /^(>\s?)/.exec(line);
            if (quote !== null) {
              out.push({ text: quote[1], hidden: true });
              line = line.slice(quote[0].length);
              style = 'quote';
            }
            // 无序列表：短横/星号/加号隐藏，其后的空格保留可见，于是看起来是缩进。
            const bullet = /^([-*+]\s+)/.exec(line);
            if (bullet !== null) {
              out.push({ text: bullet[1][0], hidden: true });
              out.push({ text: bullet[1].slice(1) });
              line = line.slice(bullet[0].length);
            }
          }
        }

        scanMarkdownInline(line, style, out, 0);
        if (nl === -1) break;
        out.push({ text: '\n' });
        i = nl + 1;
        lineStart = true;
        lineNo += 1;
      }
      return coalesceMarkdownSegments(out);
    }

    /**
     * 标出哪些行位于 ``` 围栏之内。
     *
     * 需要整篇文本来判断（围栏是跨行的），所以在渲染前算一次。
     *
     * @param text - 正文。
     * @returns 与行数等长的布尔数组。
     */
    function computeFenceLines(text) {
      const lines = String(text ?? '').split('\n');
      const inside = new Array(lines.length).fill(false);
      let fence = false;
      for (let index = 0; index < lines.length; index += 1) {
        if (/^\s*```/.test(lines[index])) {
          inside[index] = true;
          fence = !fence;
          continue;
        }
        inside[index] = fence;
      }
      return inside;
    }

    /**
     * 合并相邻的同样式片段。
     *
     * 扫描器是逐字符往外吐的，这里不合并的话，一篇 800 字的稿子会生成上千个
     * span 节点——渲染开销和 diff 代价都白给。合并只重组片段、不动字符，
     * 保真契约依然成立。
     *
     * @param segments - 原始片段。
     * @returns 合并后的片段。
     */
    function coalesceMarkdownSegments(segments) {
      const merged = [];
      for (const segment of segments) {
        const last = merged[merged.length - 1];
        const sameShape =
          last !== undefined &&
          (last.hidden === true) === (segment.hidden === true) &&
          (last.style ?? '') === (segment.style ?? '');
        if (sameShape) last.text += segment.text;
        else merged.push({ text: segment.text, style: segment.style, hidden: segment.hidden });
      }
      return merged;
    }

    /** 把片段拼回纯文本——用于自检：必须与输入逐字符相同。 */
    function markdownSegmentsToText(segments) {
      return segments.map((segment) => segment.text).join('');
    }

    /**
     * 渲染正文：批注高亮 + Markdown 行内样式。
     *
     * 两层是叠加关系：先按字符区间切出批注片段（保证高亮位置精确），
     * 再在**每个片段内部**做 Markdown 解析。这样外层偏移量不受影响，
     * 批注色块仍能严丝合缝地贴住原文。
     *
     * @param text - 正文。
     * @param annotations - 批注列表。
     * @param suggestions - 待处理建议列表。
     * @returns 可渲染的子元素数组。
     */
    function renderRichText(text, annotations, suggestions) {
      const fenceLines = computeFenceLines(text);
      let cursor = 0;
      let lineNo = 0;
      return buildHighlightSegments(text, annotations, suggestions).map((segment, index) => {
        // 行级标记只在行首生效，所以要先知道这个片段是不是从行首开始的。
        const atLineStart = cursor === 0 || text[cursor - 1] === '\n';
        const firstLine = lineNo;
        cursor += segment.text.length;
        lineNo += (segment.text.match(/\n/g) ?? []).length;
        const children = markdownInlineSegments(segment.text, {
          atLineStart,
          firstLine,
          fenceLines,
        }).map((piece, pieceIndex) => {
          const className =
            piece.hidden === true ? 'wcv-mdHidden' : piece.style ? `wcv-md-${piece.style}` : undefined;
          return h(
            'span',
            className === undefined ? { key: pieceIndex } : { key: pieceIndex, className },
            piece.text,
          );
        });
        return segment.mark === false
          ? h('span', { key: index }, ...children)
          : h(
              'mark',
              {
                key: index,
                className: 'wcv-mark',
                'data-mark': segment.mark,
                'data-status': segment.status,
                'data-kind': segment.kind,
              },
              ...children,
            );
      });
    }

    /**
     * 行级差异（LCS）。用于版本对比：把「某个历史版本」与「当前版本」逐行对照。
     *
     * 文本量不大时用经典动态规划最直观；超过上限就退化为整体替换，
     * 避免在长文上卡住界面（诚实降级，而不是假装算完了）。
     *
     * @param before - 旧文本。
     * @param after - 新文本。
     * @returns [{ type: 'same'|'add'|'del', text }]
     */
    function diffLines(before, after) {
      const a = String(before ?? '').split('\n');
      const b = String(after ?? '').split('\n');
      if (a.length * b.length > 400_000) {
        return [
          ...a.map((text) => ({ type: 'del', text })),
          ...b.map((text) => ({ type: 'add', text })),
        ];
      }
      const n = a.length;
      const m = b.length;
      const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
      for (let i = n - 1; i >= 0; i -= 1) {
        for (let j = m - 1; j >= 0; j -= 1) {
          dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
        }
      }
      const out = [];
      let i = 0;
      let j = 0;
      while (i < n && j < m) {
        if (a[i] === b[j]) {
          out.push({ type: 'same', text: a[i] });
          i += 1;
          j += 1;
        } else if (dp[i + 1][j] >= dp[i][j + 1]) {
          out.push({ type: 'del', text: a[i] });
          i += 1;
        } else {
          out.push({ type: 'add', text: b[j] });
          j += 1;
        }
      }
      while (i < n) out.push({ type: 'del', text: a[i++] });
      while (j < m) out.push({ type: 'add', text: b[j++] });
      return out;
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
     * 当前会话的「输入框动作」桥。
     *
     * 画布在右栏，本身够不到对话输入框；而「让 AI 处理这条批注」必须能替用户
     * 把话发出去。做法是在 conversation.composer.dock（会话级槽位）挂一个无渲染组件，
     * 从槽位注入里取到输入框的动作（setDraft / submit）存到这里。
     *
     * 只保留**当前屏幕上那个会话**的一份：画布与输入框永远属于同一个会话，
     * 多会话同时开时以最后挂载的为准，避免把话发错会话。
     */
    let composerBridge = null;

    /** 生成「输入框桥」的无渲染组件。 */
    function makeComposerBridge() {
      return function ComposerBridge(props) {
        /** 上报去重：记住已经报过的会话，避免每次重渲染都刷一条。 */
        const reportedRef = React.useRef(null);
        const sessionId = props?.sessionId;
        // 槽位注入了 keyboard(= composer shell)，它的 actions 带 setDraft/submit。
        const inputActions = props?.inputActions ?? props?.keyboard?.actions;
        // 输入框草稿：发送前必须知道里面有没有东西，否则会把用户正写的一半覆盖掉。
        //
        // useInput 是槽位注入的 hook，这里按「存在则调用」处理。它在同一槽位上的
        // 存在性是稳定的（由组合决定，不在运行中来回变），所以不违反 hook 规则。
        const useInput = props?.useInput;
        const draft = typeof useInput === 'function'
          ? useInput((state) => (state !== null && typeof state === 'object' ? state.draft : undefined))
          : undefined;
        React.useEffect(() => {
          if (typeof sessionId !== 'string' || sessionId === '' || inputActions === undefined) return undefined;
          composerBridge = { sessionId, inputActions, draft: typeof draft === 'string' ? draft : '' };
          // 只在「换了会话」或「首次接上」时上报：草稿一变 effect 就会重跑，
          // 每次重跑都上报会在输入时刷屏（实测 3 秒刷了 14 条）。
          if (reportedRef.current !== sessionId) {
            reportedRef.current = sessionId;
            report('composer:bridge-ready', {
              sessionId,
              via: props?.inputActions !== undefined ? 'inputActions' : 'keyboard.actions',
              canSubmit: typeof inputActions.submit === 'function',
            });
          }
          return () => {
            if (composerBridge !== null && composerBridge.sessionId === sessionId) composerBridge = null;
          };
        }, [sessionId, inputActions, draft]);
        return null;
      };
    }

    /**
     * 把一段话发到这个会话的输入框并提交，替用户按下回车。
     *
     * @param sessionId - 目标会话。
     * @param text - 要发送的内容。
     * @returns true 表示确实发出去了；false 表示桥还没就绪（界面会据此提示，不假装成功）。
     */
    function sendToConversation(sessionId, text) {
      if (composerBridge === null || composerBridge.sessionId !== sessionId) return 'no-bridge';
      const { inputActions, draft } = composerBridge;
      // 输入框里有用户自己写了一半的内容：**绝不覆盖**。把决定权交回用户。
      if (typeof draft === 'string' && draft.trim() !== '') return 'draft-busy';
      try {
        if (typeof inputActions.setDraft !== 'function' || typeof inputActions.submit !== 'function') return 'no-bridge';
        inputActions.setDraft(text);
        inputActions.submit();
        return 'sent';
      } catch (error) {
        report('composer:send-failed', { reason: describe(error) });
        return 'error';
      }
    }

    /**
     * 算出浮动工具条该落在哪里。
     *
     * 抽成纯函数是为了能真正验证边界——「选中靠右的文字时工具栏压住它」这类问题
     * 只在特定坐标下出现，看代码看不出，必须拿数字算。
     *
     * @param options.anchorLeft - 选区左边缘（相对容器）。
     * @param options.anchorTop - 选区上边缘（相对容器）。
     * @param options.barWidth - 工具条实际宽度。
     * @param options.barHeight - 工具条实际高度。
     * @param options.wrapWidth - 容器宽度。
     * @param options.wrapHeight - 容器高度。
     * @returns { left, top } 均已夹进容器。
     */
    function clampFloatPosition(options) {
      const gap = 4;
      const lineHeight = 30;
      const { anchorLeft, anchorTop, barWidth, barHeight, wrapWidth, wrapHeight } = options;

      // 横向：选区靠右时不能让它越出容器，否则工具条会反过来压住刚选中的文字。
      const maxLeft = Math.max(gap, wrapWidth - barWidth - gap);
      const left = Math.max(gap, Math.min(anchorLeft, maxLeft));

      // 纵向：默认浮在选区上方；上方放不下（例如选中的是第一行）就翻到下方，
      // 否则会把正在编辑的那一行盖住。两边都放不下时贴顶。
      const above = anchorTop - barHeight - 8;
      const below = anchorTop + lineHeight;
      let top = above >= 2 ? above : below;
      if (top + barHeight > wrapHeight - 2) top = Math.max(2, above);

      return { left, top };
    }

    /**
     * 读一个会话的 agent preset id。
     *
     * 只有读到 `writing` 才允许自动调出画布，所以这个函数决定了两件事：
     * 「写作模式下画布自动出现」和「其他模式绝不自动出现」。
     * 取不到就返回 undefined——调用方据此 fail closed（不自动开）。
     *
     * 数据来源是会话投影 `projectionValues.agentPreset`（与官方
     * dsh-client-ui-agent-preset 的 AgentPresetLabel 读的是同一个字段）。
     * 取值走多条退路：不同版本里服务可能是 ctx.get('sessions')，也可能是
     * 通过槽位 hooks 注入进来的 hook 源。
     *
     * 抽成纯函数是为了能被单测直接覆盖——这段逻辑挂一次，用户看到的就是
     * 「任务又自己变成写作了」，不能只靠肉眼看代码。
     *
     * @param options.sessions - sessions 服务（可选）。
     * @param options.useSessions - 槽位注入的 hook 选择器（可选）。
     * @param options.sessionId - 目标会话 id。
     * @returns preset id，或 undefined。
     */
    function readAgentPresetId({ sessions, useSessions, sessionId }) {
      if (typeof sessionId !== 'string' || sessionId === '') return undefined;

      /** 从 state 形状里取出 preset id。 */
      const fromState = (state) => {
        const value = state?.byId?.[sessionId]?.projectionValues?.agentPreset;
        return typeof value === 'string' && value !== '' ? value : undefined;
      };

      // 退路 1：槽位注入的 hook 选择器（官方插件用的就是这个形状）。
      if (typeof useSessions === 'function') {
        try {
          const value = fromState(useSessions((state) => state));
          if (value !== undefined) return value;
        } catch {
          // hook 在渲染期之外调用可能抛错，落到下一条退路。
        }
      }

      // 退路 2：服务上的 list store。
      try {
        const value = fromState(sessions?.list?.getSnapshot?.());
        if (value !== undefined) return value;
      } catch {
        // 忽略，继续尝试下一条。
      }

      // 退路 3：服务本身可能直接是 store（带 getState）。
      try {
        const value = fromState(sessions?.getState?.());
        if (value !== undefined) return value;
      } catch {
        // 忽略。
      }

      return undefined;
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

          // 只有**写作模式**才自动调出画布。
          //
          // 历史（两次都被用户投诉，别再走回头路）：
          //   1. 最初是「只要会话在屏幕上就开」——每建一个任务都弹空画布。
          //   2. 后来改成「文档里有正文才恢复」——仍然会在普通任务的会话里弹出来，
          //      用户的原话是「我只有在特定条件下触发之后才进入写作，不要直接就进入写作了」。
          //
          // 现在的判据是**会话的 agent preset 是不是 writing**：
          //   - 写作模式 → 自动调出画布（这正是选它的意义）
          //   - 其他模式 → 一律不自动开；只有 Agent 真的开始写正文时，
          //     由宿主推来的 canvas-intent 事件调出（或用户手动打开）
          //
          // 判据取不到时**不开**（fail closed）：宁可让用户手动开一次，
          // 也不要再出现「莫名其妙自己弹出来」。
          let cancelled = false;
          let timer = null;
          let attempts = 0;

          /** 读当前会话的 agent preset id；取不到返回 undefined。 */
          const readAgentPreset = () =>
            readAgentPresetId({
              sessions: optionalService(ctx, 'sessions'),
              useSessions: props?.useSessions,
              sessionId,
            });

          const attempt = () => {
            if (cancelled) return;
            attempts += 1;

            const preset = readAgentPreset();
            if (preset === undefined) {
              // 会话投影可能还没就绪：短暂重试，仍取不到就放弃（不开）。
              if (attempts < 12) {
                timer = setTimeout(attempt, 400);
                return;
              }
              report('autoopen:skip', { sessionId, reason: 'agent-preset-unknown' });
              return;
            }
            if (preset !== WRITING_PRESET_ID) {
              report('autoopen:skip', { sessionId, reason: `not-writing-mode:${preset}` });
              return;
            }

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
              report('autoopen:ok', { sessionId, attempts, preset });
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
      // 全局错误上报：客户端出错时宿主看不见，这是唯一能把真实原因带出来的通道。
      if (window.__dshWritingCanvasErrorHook !== true) {
        window.__dshWritingCanvasErrorHook = true;
        window.addEventListener('error', (event) => {
          report('client:error', {
            message: String(event.message ?? ''),
            source: String(event.filename ?? '').split('/').pop(),
            line: event.lineno ?? null,
            column: event.colno ?? null,
          });
        });
        window.addEventListener('unhandledrejection', (event) => {
          report('client:rejection', { reason: describe(event.reason) });
        });
      }

      pluginCtx = ctx;
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
      //
      // 必须用 `inject(sessionId)`：右栏槽位的组件**拿不到任何 props**
      // （宿主是 renderSlot(seat, {}, { hookContext })），会话身份只能通过注入拿到。
      // 漏掉 inject 时 CanvasTabBody 的 props.sessionId 恒为 undefined，
      // 画布会退化成去读 `docIdOfSession(undefined)` = "default" 那份空文档——
      // 表现就是「右栏画布永远空白 / 永远显示新文档」，而同一份正文在磁盘上明明存在。
      // 这与官方 sidebar-terminal 的写法一致（inject: (sessionId) => ({...})）。
      ctx.slots.inject('sidebar.right.pane.tab', () =>
        ctx.slots.register(
          {
            name: 'sidebar.right.pane.tab',
            key: CANVAS_TAB_ID,
            inject: (sessionId) => ({ sessionId }),
          },
          CanvasTabBody,
        ),
      );

      // 形态 A 的自动开启：会话在屏幕上时把画布钉到对话旁。
      ctx.slots.inject('conversation.composer.dock', () =>
        ctx.slots.register(
          { name: 'conversation.composer.dock', id: 'writing-canvas-autoopen', order: 40 },
          CanvasAutoOpen,
        ),
      );

      // 输入框桥：只取动作，不渲染任何东西。
      ctx.slots.inject('conversation.composer.dock', () =>
        ctx.slots.register(
          { name: 'conversation.composer.dock', id: 'writing-canvas-composer-bridge', order: 41 },
          makeComposerBridge(),
        ),
      );

      // 形态 B：侧边栏入口 + 整页工作台（带「在对话旁打开」按钮）。
      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register(
          { name: 'sidebar.panellist', id: PANEL_ID, order: 30, label: '写作工作台' },
          PanelIcon,
        ),
      );
      /** 工作台需要的动作：都在这里注入 ctx，面板本身不碰服务。 */
      const workbenchActions = {
        openBeside,
        newDocument: async (workspacePath) => {
          if (typeof workspacePath !== 'string' || workspacePath === '') {
            report('doc:new-failed', { reason: 'no-workspace' });
            return null;
          }
          const { ok, data } = await apiPost('/docs/create', { workspace: workspacePath, title: '未命名文档' });
          if (!ok || data?.ok !== true) {
            report('doc:new-failed', { reason: data?.error ?? 'unknown' });
            return null;
          }
          report('doc:new', { docId: data.docId });
          return { workspace: data.workspace, docId: data.docId };
        },
        newSession: () => {
          const uiWorkspace = optionalService(ctx, 'uiWorkspace');
          if (uiWorkspace === undefined || typeof uiWorkspace.startSession !== 'function') {
            report('session:new-failed', { reason: 'uiWorkspace-unavailable' });
            return;
          }
          try {
            uiWorkspace.startSession();
            report('session:new', {});
          } catch (error) {
            report('session:new-failed', { reason: describe(error) });
          }
        },
      };

      ctx.slots.inject('main', () =>
        ctx.slots.register({ name: 'main', key: PANEL_ID }, makeWorkbenchPanel(workbenchActions)),
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
    exports.__internals = {
      transformSelection,
      buildHighlightSegments,
      diffLines,
      formatKeys,
      modifiersOf,
      readAgentPresetId,
      clampFloatPosition,
      markdownInlineSegments,
      markdownSegmentsToText,
      computeFenceLines,
    };
    return exports;
  },
});



