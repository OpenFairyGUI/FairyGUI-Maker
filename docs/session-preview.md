# Backend 会话预览与接入验收

Maker 固定安装公开发布的 `@openfairygui/core/backend/functions/mcp@0.7.0`。字段读回、未保存会话预览、Host 授权保存及重开读回使用同一 Backend 会话链路。[OpenFairyGUI #138](https://github.com/OpenFairyGUI/OpenFairyGUI/issues/138) 所需的工具发现、Host 失败分支及公共指引参数已接入。

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
