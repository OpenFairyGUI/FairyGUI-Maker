# Backend 会话预览与 0.5.0-alpha.1 接入验收

2026-09-07：Maker 已固定安装公开发布的 `@openfairygui/core/backend/mcp@0.5.0-alpha.1`。字段读回和未保存会话预览已接入；完整 MCP/保存流程仍受 [OpenFairyGUI #138](https://github.com/OpenFairyGUI/OpenFairyGUI/issues/138) 阻断。

## 使用

1. 通过 Backend 打开授权工程，使用 outline 找到 ID，再用 `query_entity` 读当前属性及 revision。
2. Dashboard 活跃工程会话行点击“预览会话”；MCP 等价入口是 `open_session_preview({sessionId, expectedRevision})`。
3. 打开返回的 `project.viewerUrl`。浏览器注册 renderer 后，复用 `list_viewer_components`、`render_component_preview`、observation、capture 和 `run_ui_scenario`。
4. Backend 修改或保存使旧 renderer 失效；点击“刷新工程”读取新版本。页面显示真实 Backend revision 和 dirty 状态。关闭会话会删除对应预览。

`open_session_preview` 不保存、不请求 Save Grant，不把临时 Viewer 操作写回 Backend。文件目录绑定与 CLI 快照仍有自己的刷新规则。Asset Manager 需要完整资源扫描，因此不接受按组件加载字节的会话预览。

## 数据与失效边界

Host 只保留会话 ID、revision、dirty/save 元数据及 Viewer 绑定，不缓存另一份权威 UAM，不镜像事务。`GET /api/projects/:id/session-state?sourceRevision=...` 使用公开 `readSessionState`；资源端点使用 `readResourceBytes({sessionId, expectedRevision, selector:{packageId,resourceId}})`，只读内存中的主文件字节。

浏览器从完整模型构建所选组件依赖闭包，按需读取跨包图片、字体及字体内声明的 glyph。所有资源请求固定于同一预览版本；中途版本变化立即失败，不能混用旧模型和新字节。错误保留 Backend code/reason；不会通过磁盘回退、自动水合或保存修复。

模型遵守上游 4 MiB JSON、深度 64、500000 nodes 限额，单个资源字节上限 1 MiB。Maker 还保留 5000 个组件/依赖资源、256 MiB scene 和 15 秒读取预算。缺少字节、模型不完整或 fidelity 不支持时显式失败，不截断后声称完成。权限仍使用现有 Host token/Origin/iframe 隔离边界。

Host 的 `sourceRevision` 是绑定 ID、预览代次和 Backend 元数据的身份摘要，**不是文件内容 hash**。保存可能不增加 Backend edit revision，仍会递增预览代次并使旧 renderer 失效。旧版本模型和资源不保留；会话恢复或关闭后不能复活旧预览。

## 可复现验收

```powershell
pnpm build
node --import tsx --test test/session-preview.test.ts test/viewer-scene.test.ts
node --import tsx scripts/session-preview-smoke.ts
```

真实浏览器使用临时合成工程：读回 `Before` → 预览红色跨包图片 → Backend 事务改为 `Unsaved after` 和蓝色图片 → query 读回 revision 1 → 旧 renderer 失效 → 刷新并捕获新画面 → 浏览器 reload → 关闭会话。两个 PNG 各检测到 1024 个目标色像素；未使用资源不下载，磁盘 XML/PNG 保持原样。证据输出至 `test-results/session-preview/`，也纳入常规 `test:browser`。

本轮完整执行结果：

| 检查 | 结果 |
|---|---|
| TypeScript、生产 Web/Host 构建 | 通过；保留现有主包体积告警，新版 Backend 常量导入另有动态/静态导入提示 |
| Node 全量 | 147/149 通过；`save-grants.test.ts`、`backend-files.test.ts` 的真实 Host 保存响应断言失败 |
| 专项接口、依赖闭包及浏览器诊断门禁 | 10/10 通过 |
| 浏览器完整序列 | 24/25 通过；最终 `save-grants` 阶段复现上游响应错误；报告中无非预期浏览器诊断 |
| 内存门禁 | 5/5 通过；Player 100 次组件切换后的 JS heap 约 11.5 MiB |

浏览器报告为 `test-results/browser/run-rT4qpl/report.json`，内存报告为 `test-results/memory/node-1788775092022.json`。过程中修正了既有烟测的网络事件等待：Player 已停止却可能收不到 Playwright 的 404 response 事件；现按真实停止界面及重连后新旧 session 身份验证，未放宽运行时错误或保存授权断言。

必须保留的失败门禁：上游工厂 `tools/list` 只返回自身 20 个 Backend 工具，Maker 后注册工具按名称可调用但无法发现；严格 output schema 把 `save_approval_required` 等 Host 结果改成 `backend_unhandled_error`。已有真实 Host 保存测试会失败，不能跳过、伪造成功或通过私有注册表补丁解决。等待上游公开 Host 组合接口发布后，再验收完整工具发现、一次授权保存及保存后重开读回；当前结果不代表整个升级可发布。
