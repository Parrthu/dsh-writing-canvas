# dsh-writing-canvas · DeepSeek Harness 写作插件

> 目录名：`写作插件` · 包名：`dsh-writing-canvas` · 面板名：写作工作台

一个为 DeepSeek Harness（桌面版 / 内置 Web UI）提供**写作专用界面**的插件。

## 目标能力

| 能力 | 说明 |
|---|---|
| 双形态界面 | ① 对话旁常驻画布（右栏标签页，`keepMounted`）② 侧边栏入口 + 整页写作工作台 |
| 预制提示词 | 强指令约束提示段（15 条硬约束）+ 用户可选写作类型 |
| 可插拔写作类型 | 创意写作 / 公文写作 / 视频文案 / 小红书文案 / 新闻写作；每种类型是配置树里可独立启停的一行插件 |
| 格式双轨 | 默认 Markdown；指定字体/字号/行距的文种走受约束 DOCX，产物回读校验 |
| Canvas 写作框 | 随时可编辑删减，自动保存、选区批注、不可变历史版本、冲突保护 |
| GitHub 持续提交 | 每个可交付单元一次 commit + push |

## 状态

- [x] P0 插件骨架与双形态界面骨架
- [x] P1 文档核心：持久化、不可变版本、冲突保护、双形态 Canvas
- [ ] P2 提示词与写作类型插件化（含 Agent 读写工具）
- [ ] P3 批注与修订
- [ ] P4 格式引擎（Markdown / DOCX）
- [ ] P5 设置页、文档与交付验收

## 架构要点

- **目标 Release：`0.2.0-rc.2`（cordis 4.0.4）**，只对齐这一个版本。
- **零构建**：`src/` 与 `client/` 里的文件就是最终产物，没有打包步骤。
- **零 peerDependencies**：宿主半体不静态导入任何 `@deepseek-ai/*` 包，全部通过
  `ctx.inject([...])` 动态取服务，因此不会被版本兼容性网关卡住。
- **客户端 bundle** 使用 `window.__ModuleLoader__.load({ id, factory })` 协议，
  只 `require` 平台基线模块（react 等），无需声明 `dsh.client.external`。

## 数据存放

写作产物存放在**会话所属工作区**下的 `.writing-canvas/`：

```
<workspace>/.writing-canvas/docs/<docId>/meta.json     # 文档元信息与最新版本指针
<workspace>/.writing-canvas/docs/<docId>/v0001.json    # 不可变版本（只增不改）
```

- 一个会话一份文档（`docId = s-<会话 id>`），所以画布天然跟着对话流走。
- 内容没有变化时不生成新版本，自动保存不会把历史刷成噪音。
- 保存时携带 `baseVersion`；若服务端已前进（例如 Agent 期间写入过），宿主
  **拒绝写入**并返回 409，由界面询问用户，绝不静默覆盖。

## 安装（最终用户）

```bash
dsh plugin --profile <profile> add dsh-writing-canvas
# 或本地目录：dsh plugin --profile <profile> add file:/path/to/写作插件
```

**安装后需要重启一次 DeepSeek Harness**——这是 DSH 插件的标准流程：宿主只在启动时
读取 profile 的插件组合。重启后永久生效，不需要任何额外设置。

## 开发

```bash
node --test test/store.test.mjs test/routes.test.mjs   # 23 项行为测试，不依赖 DSH 运行时
node --check src/index.js && node --check client/client.js
```

### 开发期加速设置（可选，交付时不需要）

DSH 的 `hmr` 条目默认 `root: []`，即**只监听配置、不监听模块源码**，因此开发时改
`src/*.js` 需要重启 App 才能生效。可以在 profile 的 `cordis.patch.yml` 末尾加：

```yaml
- id: hmr
  config:
    root:
      - /绝对路径/写作插件
```

注意：**开启源码监听必须在启动前配置好**；加完之后要重启一次 App，

重启之后，改 `src/*.js` 或 `client/client.js` 都会即时生效，无需再重启。

这一段**只为开发方便**，与插件本体无关；删掉它不影响插件任何功能，最终用户也不需要它。

## 开发环境事实

- DSH 版本：`0.2.0-rc.2`（cordis `4.0.4`）
- GUI：DeepSeek Harness Web GUI（`desktop` profile）
- DOCX 运行时：内置 Python `python-docx 1.2.0`
- 客户端平台基线模块：`react`、`react/jsx-runtime`、`react-dom`、`react-dom/client`、
  `@deepseek-ai/cordis`、`dsh-client-store`、`dsh-client-ui-slots`、
  `dsh-client-ui-primitives`、`dsh-client-ui-dockkit`

## 许可

MIT
