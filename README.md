# dsh-writing-canvas

DeepSeek Harness 的写作插件，包名 `dsh-writing-canvas`。
它让你和 AI 一起写东西，边聊边改。
装好之后，界面上会多出三处：
1. 模式选择里多一个「写作模式」。
2. 右侧边栏多一块**写作画布**。
3. 顶栏多一个写作工作台。

## 安装

本插件通过 GitHub Release 的包体分发，还没上 npm。

```bash
# 从 Release 下载安装（推荐）
gh release download v0.1.0 --repo Parrthu/dsh-writing-canvas --pattern '*.tgz'
dsh plugin --profile <profile> add file:./dsh-writing-canvas-0.1.0.tgz

# 或者直接用源码目录
dsh plugin --profile <profile> add file:/path/to/写作插件
```

装完要**重启一次** DeepSeek Harness。
DOCX 导出靠 `python-docx`，DSH 已经内置了。

卸载：

```bash
dsh plugin --profile <profile> remove dsh-writing-canvas
```

---

## 用法

| | |
|---|---|
| 两种打开方式 | 对话右边常驻一块（右栏标签页），或者从侧边栏开整页工作台 |
| 写作模式 | 第 5 个模式。选中它，画布才会自动弹出来；其他模式下，只有你明确说要写东西时才出现 |
| 逐字长出来 | AI 分段写的时候，画布跟着一段段显示。你正在打字时它不会覆盖你 |
| 选定文字改 | 选中一段 → 改写／扩写／缩写／润色／批注 → 写下要求，自动发给 AI |
| 格式工具栏 | 标题／加粗／斜体／删除线／行内代码／代码块／引用／列表／链接／分隔线。Markdown 标记默认隐藏，直接显示格式效果 |
| AI 只能提议 | 它想改你写过的句子，只能提交建议。正文一字不动，你在画布上逐条接受或拒绝 |
| 版本历史 | 每次写入生成新版本。可看任意版本、跟当前版本逐行对比、还原（还原也是新版本，历史不会丢） |
| 导出 DOCX | 内置党政机关公文、通用中文文档、工作报告三套版式。导出时选保存位置，生成后逐项回读校验 |
| 写作类型 | 创意写作／公文写作／视频文案／小红书文案／新闻写作。每种带自己的硬约束和必问要素，另有 17 条跨类型硬约束，全部直接写进系统提示 |
| 提示词可改 | 每个写作类型的提示词能在画布上直接编辑，改完立刻生效 |

---

## 安全边界约束（AI自己写的）

这些不是文档里的约定，是代码里拦得住的行为：

| 规则 | 在哪拦的 |
|---|---|
| 空白内容不能覆盖非空文档 | `store.js` 直接拒绝，除非显式传 `allowEmpty: true` |
| 基于过期版本的写入会被拒绝 | 带了 `baseVersion` 而服务端已经前进时返回 409，不写入 |
| AI 改你写过的字只能提议 | `writing_canvas_suggest` 只写 `suggestions.json`，你接受才动正文 |
| 未处理的批注不改变正文 | 批注和正文分开存，AI 读到后要先向用户确认 |
| 格式必须真的落地 | 生成 DOCX 后重新打开逐项核对 13 项，没过就报失败 |
| 版本不能原地覆盖 | 还原是把历史内容写成新版本，旧版本一直留着 |

---

## Agent 工具

12 个，装在 DSH 里之后由 AI 调用：

| 工具 | 作用 |
|---|---|
| `writing_canvas_read` | 读正文、元信息、版本列表、未处理批注、待决定建议 |
| `writing_canvas_write` | 写正文（`mode=append/replace`；`final=false` 时界面显示「撰写中」）|
| `writing_canvas_versions` | 列版本，或读某一版 |
| `writing_canvas_restore` | 还原到某个版本（生成新版本）|
| `writing_canvas_suggest` | 提议改写，不动正文 |
| `writing_canvas_annotate` | 读写批注（list / create / reply / resolve / dismiss）|
| `writing_canvas_export` | 套用版式生成 DOCX，回读校验 |
| `writing_format_set_list` / `writing_format_set_create` | 列格式集／新建格式集 |
| `writing_type_list` / `writing_type_set` / `writing_type_create` | 读写作类型约束／选定类型／新建类型 |

---

## 开发

```bash
npm test          # 194 项行为测试，不依赖 DSH 运行时
npm run check     # 语法检查
```

### 代码结构

```
写作插件/
├─ package.json                 dsh.bundle.patch + dsh.client
├─ cordis.patch.yml             核心行 + 5 个写作类型行（各自可停用）
├─ presets/writing.patch.yml    写作模式（第 5 个 preset）
├─ src/                         宿主半体（纯 ESM，就是最终产物）
│  ├─ index.js  prompt.js  routes.js  workspace.js
│  ├─ store.js  annotations.js  suggestions.js  events.js  stores.js
│  ├─ tools.js                  12 个 Agent 工具
│  ├─ format/specs.js  format/docx.js
│  ├─ mode/writing.js           只在写作模式注入那两段提示
│  └─ types/registry.js + 5 个类型包
├─ client/client.js             浏览器半体（就是最终产物）
├─ scripts/docx_tool.py         python-docx 生成 + 回读校验
├─ test/                        194 项测试
└─ docs/
```

### 数据存储

```
<工作区>/.writing-canvas/
├─ docs/<docId>/meta.json          元信息（标题、写作类型、格式规格、最新版本指针）
├─ docs/<docId>/v0001.json …       不可变版本，只增不改
├─ docs/<docId>/annotations.json   批注
├─ docs/<docId>/suggestions.json   修改建议
└─ exports/*.docx                  导出的成品
```

一个会话一份文档（`docId = s-<会话 id>`），所以画布跟着对话走，也跟着工作区走。

---

## 许可

MIT
