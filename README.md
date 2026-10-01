# dsh-writing-canvas · DeepSeek Harness 写作插件

> 目录名：`写作插件` · 包名：`dsh-writing-canvas` · 目标 Release：**0.2.0-rc.2**（cordis 4.0.4）

给 DeepSeek Harness 提供一套**写作专用界面**：对话照常流动，写作画布常驻旁边。

---

## 一、它能做什么

| 能力 | 说明 |
|---|---|
| **双形态界面** | ① 对话右侧常驻画布（右栏标签页，`keepMounted`）② 侧边栏入口 + 整页写作工作台 |
| **强指令约束** | 15 条跨类型硬约束 + 每个写作类型的专属硬约束，**全部直接写进系统提示**，无法靠"不查工具"绕过 |
| **可插拔写作类型** | 创意写作 / 公文写作 / 视频文案 / 小红书文案 / 新闻写作。每种是**独立的插件行**，可单独启停 |
| **画布只管内容** | 正文是 Markdown 纯文本；格式工具栏支持标题/加粗/斜体/删除线/代码/引用/列表/链接/分隔线 |
| **实时流式呈现** | AI 分段写入时画布逐字长出来，工具栏显示「撰写中…」；你正在打字时**不覆盖**你的内容 |
| **批注** | 选中文字即可改写/扩写/缩写/润色/提问，落成批注；AI 读到批注后与你确认再动手 |
| **修改建议（重要）** | AI 想改你已有的文字时只能**提议**：正文一字不动，由你逐条接受或拒绝 |
| **不可变版本** | 每次写入都生成新版本；可查看任意版本、与该版本逐行对比、还原（还原也是新版本） |
| **DOCX 格式引擎** | 预设字体/字号/行距规格，一键套用，**生成后回读校验 13 项**并如实报告结果 |
| **GitHub 持续提交** | 每个可交付单元一次 commit + push |

---

## 二、安装（最终用户）

本插件目前以 **GitHub Release 的包体**分发，尚未发布到 npm registry，
所以下面第一条命令暂时走不通——用后两条之一。

```bash
# ① 从 Release 下载 tgz 后安装（推荐）
gh release download v0.1.0 --repo Parrthu/dsh-writing-canvas --pattern '*.tgz'
dsh plugin --profile <profile> add file:./dsh-writing-canvas-0.1.0.tgz

# ② 直接用源码目录（开发者常用，改源码立即生效）
dsh plugin --profile <profile> add file:/path/to/写作插件

# ③ registry（等发布到 npm 之后可用，当前不可用）
# dsh plugin --profile <profile> add dsh-writing-canvas
```

**安装后需要重启一次 DeepSeek Harness**——这是 DSH 插件的标准流程：宿主只在启动时读取
profile 的插件组合。重启后永久生效，**不需要任何额外设置**。

DOCX 导出需要 `python-docx`，随 DSH 内置的 Python 一起提供，无需自行安装。

### 卸载

```bash
dsh plugin --profile <profile> remove dsh-writing-canvas
```

---

## 三、架构

```
写作插件/
├─ package.json          # dsh.bundle.patch + dsh.client，锁 0.2.0-rc.2
├─ cordis.patch.yml      # 核心行 + 5 个写作类型行（各自可停用）
├─ src/                  # 宿主半体（纯 ESM，就是最终产物）
│  ├─ index.js  prompt.js  routes.js  workspace.js
│  ├─ store.js  annotations.js  suggestions.js  events.js  stores.js
│  ├─ tools.js                    # 8 个 Agent 工具
│  ├─ format/specs.js  format/docx.js
│  └─ types/registry.js + 5 个类型包
├─ client/client.js      # 浏览器半体（就是最终产物）
├─ scripts/docx_tool.py  # python-docx 生成 + 回读校验
├─ test/                 # 67 项行为测试
└─ docs/                 # 开发环境能力等
```

两条刻意的设计约束：

1. **不静态导入任何 `@deepseek-ai/*` 包**。所有服务通过 `ctx.inject([...])` 动态获取，
   因此**不需要声明 peerDependencies**，也就不会被 0.2.0-rc.2 的版本兼容性网关拦下。
2. **无构建步骤**。`src/` 与 `client/` 里的文件就是最终产物；客户端 bundle 直接手写
   `window.__ModuleLoader__.load({ id, factory })` 协议，只 `require` 平台基线模块。

### 数据放在哪

```
<工作区>/.writing-canvas/
├─ docs/<docId>/meta.json         # 元信息（标题、写作类型、格式规格、最新版本指针）
├─ docs/<docId>/v0001.json …      # 不可变版本（只增不改）
├─ docs/<docId>/annotations.json  # 批注
├─ docs/<docId>/suggestions.json  # 修改建议
└─ exports/*.docx                 # 套用格式导出的成品
```

一个会话一份文档（`docId = s-<会话 id>`），所以画布天然跟着对话走，也天然跟着工作区走。

---

## 四、几条不肯让步的规则

这些不是"建议"，是代码里真的拦得住的行为：

| 规则 | 拦截点 |
|---|---|
| **空白内容不能覆盖非空文档** | `store.js` 直接拒绝，需显式 `allowEmpty: true` |
| **基于过期版本的写入被拒绝** | 带 `baseVersion`，服务端已前进时返回 409 且**不写入** |
| **AI 改用户的字只能提议** | `writing_canvas_suggest` 只写 `suggestions.json`；只有用户接受才动正文 |
| **未处理的批注不改变正文** | 批注与正文分区存放，AI 读到后必须先与用户确认 |
| **格式必须真实落地** | 生成 DOCX 后重新打开逐项核对 13 项，不过就报失败 |
| **版本不可原地覆盖** | 还原是把历史内容写成**新版本**，历史永远完整 |

---

## 五、Agent 工具

| 工具 | 作用 |
|---|---|
| `writing_canvas_read` | 读正文 + 元信息 + 版本列表 + 未处理批注 + 待决定建议 |
| `writing_canvas_write` | 写正文（`mode=append/replace`；`final=false` 时界面显示撰写中） |
| `writing_canvas_versions` | 列版本 / 读某一版 |
| `writing_canvas_restore` | 还原到某版本（生成新版本） |
| `writing_canvas_suggest` | **提议**改写（不动正文） |
| `writing_canvas_annotate` | 读写批注（list/create/reply/resolve/dismiss） |
| `writing_canvas_export` | 一键套用格式生成 DOCX 并回读校验 |
| `writing_type_list` / `writing_type_set` | 读写作类型约束 / 选定类型 |

---

## 六、开发

```bash
npm test          # 67 项行为测试，不依赖 DSH 运行时
npm run check     # 语法检查
```

### 开发期加速（可选，交付时不需要）

`hmr` 条目默认只监听配置、不监听模块源码。要改代码即时生效，在 profile 的
`cordis.patch.yml` 末尾加：

```yaml
- id: hmr
  config:
    root:
      - /绝对路径/写作插件
```

**必须在启动前配好**，加完要重启一次 App，之后改 `src/*.js` 与 `client/client.js`
都会即时生效。这一段与插件本体无关，删掉不影响任何功能。

### 自我验证（不依赖人盯）

见 [docs/开发环境能力.md](docs/开发环境能力.md)，摘要：

1. **截图**：`screencapture -x /tmp/s.png`，再用 Pillow 裁剪放大看细节。
   Retina 屏上**截图像素是逻辑坐标的 2 倍**。
2. **界面自检**：`curl .../writing-canvas/api/client-report` 读结构自检与交互自检
   （浮动工具条、版本差异视图都能程序化验证，不需要辅助功能权限）。
3. **宿主诊断**：界面把关键步骤上报到 `/client-report`，客户端问题不再靠猜。

---

## 七、已知限制（诚实声明）

- **画布是 Markdown 纯文本，不是富文本所见即所得**。这是刻意选择：内容与版式分离，
  版式交给 DOCX 格式引擎。
- **DOCX 校验核对的是写入文件里的字体名称与字号/行距**；实际渲染效果取决于查看文档的
  机器是否安装了这些字体（`仿宋_GB2312`、`方正小标宋简体` 等）。缺失时 Word/WPS 会自行替换。
- **Markdown 子集**：支持标题、引用、有序/无序列表、分隔线、行内加粗/斜体/代码。
  表格、脚注、图片不参与 DOCX 转换。
- **画布按会话隔离**：一个会话一份文档；暂未提供"把稿子复制到另一个会话"的一键操作。
- **批注与建议靠「区间 + 原文」双重锚定**：正文被大幅改动后可能锚点丢失，
  此时界面显示「需重新标注」或禁止应用，而不会指到错误位置。
- **实时连接依赖宿主进程存活**；宿主重启后客户端会自动退避重连（已实现）。

---

## 八、许可

MIT
