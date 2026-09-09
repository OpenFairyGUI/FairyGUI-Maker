# Backend 会话预览与 0.5.0-alpha.2 接入验收

Maker 固定安装公开发布的 `@openfairygui/core/backend/mcp@0.5.0-alpha.2`。字段读回、未保存会话预览、Host 授权保存及重开读回使用同一 Backend 会话链路。[OpenFairyGUI #138](https://github.com/OpenFairyGUI/OpenFairyGUI/issues/138) 所需的工具发现、Host 失败分支及公共指引参数已接入。

## 使用

1. 通过 Backend 打开授权工程，使用 outline 找到 ID，再用 `query_entity` 读当前属性及 revision。
2. Dashboard 活跃工程会话行点击“预览会话”；MCP 等价入口是 `open_session_preview({sessionId, expectedRevision})`。
3. 打开返回的 `project.viewerUrl`。浏览器注册 renderer 后，复用 `list_viewer_components`、`render_component_preview`、observation、capture 和 `run_ui_scenario`。
4. Backend 修改或保存使旧 renderer 失效；点击“刷新工程”读取新版本。页面显示真实 Backend revision 和 dirty 状态。关闭会话会删除对应预览。
5. 用户请求保存时，以明确的 `expectedRevision` 调用 save/materialize。没有权限时，由所有者在 Workbench 验证一次身份并选择会话普通保存授权或单次确认，再重试原参数；已有会话权限时，后续普通保存不重复确认。保存成功后检查结果及 dirty/save 状态。需要持久化验收时，关闭、重开同一授权工程，读回保存字段并核对重开 revision；重开不会继承旧会话保存权限。

`open_session_preview` 不保存、不请求 Save Grant，不把临时 Viewer 操作写回 Backend。文件目录绑定与 CLI 快照仍有自己的刷新规则。Asset Manager 需要完整资源扫描，因此不接受按组件加载字节的会话预览。

## 数据与失效边界

Host 只保留会话 ID、revision、dirty/save 元数据及 Viewer 绑定，不缓存另一份权威 UAM，不镜像事务。`GET /api/projects/:id/session-state?sourceRevision=...` 使用公开 `readSessionState`；资源端点使用 `readResourceBytes({sessionId, expectedRevision, selector:{packageId,resourceId}})`，只读内存中的主文件字节。

浏览器从完整模型构建所选组件依赖闭包，按需读取跨包图片、字体及字体内声明的 glyph。所有资源请求固定于同一预览版本；中途版本变化立即失败，不能混用旧模型和新字节。错误保留 Backend code/reason；不会通过磁盘回退、自动水合或保存修复。

模型遵守上游 4 MiB JSON、深度 64、500000 nodes 限额，单个资源字节上限 1 MiB。Maker 还保留 5000 个组件/依赖资源、256 MiB scene 和 15 秒读取预算。缺少字节、模型不完整或 fidelity 不支持时显式失败，不截断后声称完成。权限仍使用现有 Host token/Origin/iframe 隔离边界。

Host 的 `sourceRevision` 是绑定 ID、预览代次和 Backend 元数据的身份摘要，**不是文件内容 hash**。保存可能不增加 Backend edit revision，仍会递增预览代次并使旧 renderer 失效。旧版本模型和资源不保留；会话恢复或关闭后不能复活旧预览。

## MCP 与授权边界

Host 通过公共 `instructions` 提供 Agent 指引，通过 `toolPolicies` 为 save/materialize 分别声明 Host 失败 schema。`beforeCall` 检查当前 revision，允许已授权会话向原工程普通保存，或同步消费完整操作、revision 和选项绑定的单次授权；返回 `undefined` 后由 MCP 调用 Backend 一次。force、显式 targetPath 和完整物化不借用会话权限。会话不可用时返回 `save_session_unavailable`，不放行写入。

原运行时结果跟踪仍负责 dirty/save 元数据、关闭保护及预览失效。Host 失败在进入 Backend 前停止；授权后的 Backend 结果继续通过上游权威 schema，保留 revision 队列、路径、磁盘与事务边界。读取及预览不需要 Save Grant。

## 可复现验收

```powershell
pnpm build
node --import tsx --test test/session-preview.test.ts test/viewer-scene.test.ts test/save-grants.test.ts test/backend-files.test.ts
node --import tsx scripts/session-preview-smoke.ts
pnpm test
pnpm test:browser
```

真实浏览器使用临时合成工程：读回 `Before` → 预览红色跨包图片 → Backend 事务改为 `Unsaved after` 和蓝色图片 → query 读回 revision 1 → 旧 renderer 失效 → 刷新并捕获新画面 → 浏览器 reload → 关闭会话。两个 PNG 各检测到 1024 个目标色像素；未使用资源不下载，磁盘 XML/PNG 保持原样。证据输出至 `test-results/session-preview/`，也纳入常规 `test:browser`。

完整浏览器序列还会预览未保存文本 → 所有者确认 → MCP 保存一次 → 旧 renderer 失效 → 刷新后读取相同 Backend edit revision 的已保存状态 → 捕获文本 PNG → 关闭并重开磁盘工程 → query 读回保存字段。证据位于本次 `test-results/browser/run-*/` 的 `report.json`、`save-preview-dirty.png` 与 `save-preview-clean.png`。

| 验收项 | 覆盖 |
|---|---|
| 公开 MCP 组合 | 初始化指引、连接后新增工具及注册句柄生命周期、安装包文档资源与 prompts |
| 完整 Host 发现 | Backend 入口与全部 12 个 Maker 工具 |
| 保存授权 | 独立所有者验证及 Cookie 锁定、跨 revision 连续普通保存、特殊操作单次确认、单次并发仅一次/失败消耗、撤销/拒绝/过期、同 ID 重开失效 |
| Backend 写入边界 | revision 队列、目标路径、磁盘及 Host 私有目录隔离 |
| 会话预览 | 模型与资源 revision 一致、跨包资源、字体依赖、编辑/保存/关闭失效、PNG 及保存后重开读回 |

浏览器诊断仍拒绝服务端错误和非预期异常。保存引起的旧 renderer commands 404，以及授权决定触发 React Query 替换后台列表查询的 `GET /api/save-approvals` / `net::ERR_ABORTED`，只在对应阶段和端点识别为预期结果；连接失败或其他端点错误不豁免。

2026-09-07 当前工作区验收：类型检查与生产构建通过，Node 151/151、内存 5/5、完整 Chromium 25/25 通过。浏览器报告为 `test-results/browser/run-PzzptY/report.json`，无非预期诊断；内存报告为 `test-results/memory/node-1788793377866.json`。Player 100 次切换后 JS heap 约 11.33 MiB；该数值不代表物理 GPU 内存。构建保留现有主包体积及动态/静态导入提示。
