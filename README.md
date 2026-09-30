# dsh-writing-canvas · DeepSeek Harness 写作插件

> 目录名：`写作插件` · 包名：`dsh-writing-canvas` · 面板名：写作工作台

一个为 DeepSeek Harness（桌面版 / 内置 Web UI）提供**全新写作界面**的插件。

## 目标能力

| 能力 | 说明 |
|---|---|
| 全新 UI | 注册 `main` 中央面板 + 侧边栏入口，而不是浮动小抽屉 |
| 预制提示词 | 强指令约束提示段 + 用户可选写作类型 |
| 可插拔写作类型 | 创意写作 / 公文写作 / 视频文案 / 小红书文案 / 新闻写作；每种类型是配置树里可独立启停的一行插件 |
| 格式双轨 | 默认 Markdown；指定字体/字号/行距的文种走受约束 DOCX，产物回读校验 |
| Canvas 写作框 | 随时可编辑删减，选区批注、修改、草稿保存、不可变历史版本 |
| GitHub 实时提交 | 变更即时 commit 并推送 |

## 状态

- [x] P0-a 建立公开仓库并连通本地目录
- [x] P0-b 最小可加载插件（宿主半体 + 客户端半体）
- [ ] P1 文档核心（草稿 / 版本 / Canvas 编辑器）
- [ ] P2 提示词与写作类型插件化
- [ ] P3 批注与修订
- [ ] P4 格式引擎（Markdown / DOCX）
- [ ] P5 设置页、文档与验收

## 开发环境事实

- DSH 版本：`0.2.0-rc.2`
- GUI：DeepSeek Harness Web GUI（`desktop` profile）
- DOCX 运行时：内置 Python `python-docx 1.2.0`

## 许可

MIT
