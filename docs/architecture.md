# FairyGUI Maker 产品定位与技术架构

## 1. 项目定位

FairyGUI Maker 不是另一个 FairyGUI 编辑器，而是建立在 OpenFairyGUI 之上的 Agent 优先、本地优先产品与工具层，面向以下工作流：

- 让 Agent 打开、检查、修改并保存 FairyGUI 工程。
- 导入并管理 FairyGUI 工程的真实发布产物。
- 由 Player 检查和回放 `.fui`、`_fui.bytes`、图集及相关发布资源。
- 提供可复用的 Agent Skills，固化工程编辑、发布预览和问题诊断流程。

OpenFairyGUI 继续作为无界面的工程 SDK 和自动化内核；FairyGUI Maker 负责用户界面、Agent 工作流和产物生命周期。两者保持独立项目和独立发布节奏。

Maker Workbench 只是 FairyGUI Maker 的浏览器交付界面；Maker Host、MCP、CLI 和 Skills 同样属于产品本体，Agent 不应被限定为只能通过 Workbench 使用 Maker。

Maker Workbench 及其 Dashboard、Viewer、Player、Asset Manager 模块边界、浏览器渲染会话和已确认的前后端技术栈，单独记录在 [FairyGUI Maker Workbench 架构与技术栈基线](./workbench.md)。

## 2. 与 OpenFairyGUI 的边界

| 项目 | 负责内容 | 不负责内容 |
|---|---|---|
| OpenFairyGUI | 工程读写、UAM、事务、二进制协议、发布流程、后端会话与底层 MCP 适配 | Viewer 产品界面、Agent 工作流编排、Skills、预览服务生命周期 |
| FairyGUI Maker | 本地工作区、面向任务的 MCP 工具、发布产物管理、Viewer、Skills 和用户确认流程 | 重新定义 UAM、事务协议、二进制格式或发布算法 |

FairyGUI Maker 应直接复用以下公开能力，不复制其实现：

- `@openfairygui/core`：工程模型、UAM 和二进制协议。
- `@openfairygui/backend`：有状态工程会话、revision 检查和协调保存。
- `@openfairygui/mcp`：backend 能力的基础 MCP 映射。

最终对 Agent 只暴露一个 FairyGUI Maker MCP 服务。Maker 在内部组合 OpenFairyGUI 的能力，并补充发布、产物和预览工具，避免出现两套重叠的事务或工程 API。

## 3. MCP 传输决策

`0.1.x` 只实现 Streamable HTTP。Viewer/Player 需要浏览器与 Agent 连接同一 Host、共享 renderer 和 render session，因此 CLI 启动单个 localhost Host 进程并提供：

- `/mcp`：Streamable HTTP MCP。
- `/`：React Maker Workbench Dashboard。
- `/api/status`、`/api/sessions`、`/api/projects`、`/api/import-drafts`、`/api/artifacts`：状态、项目与持久导入草稿接口。
- `/projects/:projectId/viewer`：工程态 Viewer 入口。
- `/artifacts/:artifactId/player`：发布态 Player 入口。

本地服务只绑定 `127.0.0.1`，校验 Host、Origin 和不少于 24 字符的 bearer token。完整模式把 backend 文件访问限制在启动命令的当前目录；`view <project-path>` 模式只保存指定目录的不可变快照，并完全不注册 backend 工程写工具。Host 最多保留 32 个 MCP session，每个 render session 最多缓存 256 个 request ID。远程部署、stdio 与 stdio-to-Host 桥接均未实现；若未来增加远程模式，还必须另行设计身份认证、授权、限流和租户隔离。

持久数据默认位于启动目录的 `.fairygui-maker`，也可以用 `--data-dir` 或 `FAIRYGUI_MAKER_DATA_DIR` 指向明确的私有目录。相对路径始终以 Host 启动目录为基准，不跟随浏览器工程目录变化。

## 4. 当前架构

第一版保持单项目、两个运行入口，不提前拆分多个 npm 包：

```text
FairyGUI-Maker/
├─ src/server/                Node Host、MCP、Artifact Store、Render Broker
├─ src/web/                   React Maker Workbench、Project Source Client、Renderer Client
├─ src/runtime/               Viewer 与 Player 的独立 iframe runtime
├─ src/viewer-protocol.ts     共用的 render session/runtime 协议（v5）
├─ src/artifact-protocol.ts   Artifact manifest 与 Player source 契约
├─ .agents/skills/            通用/Codex Agent Skill
├─ .claude/skills/            Claude Skill 兼容入口
├─ scripts/fairygui-maker.mjs npm CLI 入口
├─ dist/server/               Node Host 发行构建
├─ dist/web/                  Workbench 发行构建
└─ docs/                      产品与协议文档
```

运行关系如下：

```text
Viewer: Dashboard read-only binding -> Project Source Client -> UAM ViewerScene -> viewer-runtime
Player: published folder import -> Artifact Store -> manifest + files -> player-runtime / UIPackage

Agent -> Maker MCP -> Render Session Broker -> Renderer Client -> MessageChannel -> selected runtime
Workbench controls -> REST -> same Render Session Broker
```

Node Host 是项目记录、import draft、render session 和发布产物的所有者。设计源先复制进 data dir；Parse、Plan 和 Compile 只更新带 revision 的 Draft，Materialize 才通过临时目录写入用户指定的新目录。Draft 的 Visual Evidence 复用同页 Viewer Capture，由浏览器原生 Canvas 生成 Pixel Diff，Host 只持久化经过 PNG 尺寸与 revision 校验的 Reference、Capture、Diff 和原始指标；是否接受差异由 fixture 或人工审查决定，不存在全局相似度阈值。Draft 可在 Host 重启后恢复，过期或损坏的 Draft 会在启动时清理。交互式工程绑定仍由浏览器 Project Source Client 按需读取；用户授权的 `FileSystemDirectoryHandle` 只保存在同源浏览器，不发送给 Host、Agent 或 runtime iframe。自动化 `view` 则由 Host 在启动时读取唯一显式目录并保存只读内存快照，Agent 只能按相对路径读取该快照。两种来源都用 `sourceRevision` 绑定 renderer；源 revision 改变后旧 renderer 和 render session 立即失效。Host 重启时重新校验 Artifact manifest、文件大小、SHA-256、整体 digest 和包目录，并清理不能恢复的中断导入目录；不一致的 Artifact 不载入但也不会被自动删除。

Viewer 工程绑定固定为只读。浏览器按需读取当前工程，用 OpenFairyGUI UAM 构建所选组件的 `ViewerScene` 依赖闭包，再传给隔离 iframe 直接构造 FairyGUI 对象；这个过程不调用发布流程、不生成 `.fui`、不写回项目目录，也不生成持久 artifact。完整模式下单独存在的 OpenFairyGUI backend session 才能在 revision 检查和明确 save 后写工程。Agent 对 Viewer 的数据驱动只修改 render session 临时状态。

批次 14 将浏览器和 CLI 的快照规则收敛到 `src/project-snapshot.ts`：复用 Core ProjectReader 确定依赖，默认排除隐藏/敏感/构建路径，读取前限制容量，读取后复核字节和目录索引，以内容摘要固定 UAM 与源文件集合。浏览器使用 `POST /api/projects/:id/refresh` 做身份与旧 sourceRevision CAS，再注册新 Renderer；项目移除清理 Host 记录、快照、分析及旧会话，Workbench 清理对应 IndexedDB handle，不触碰源文件。详细限制和非目标见 [Workbench 批次 14](./workbench.md#29-revision-与快照隐私批次-14)。

## 5. MCP 能力设计

现有 OpenFairyGUI backend 工具继续负责底层会话能力：

- 打开和关闭工程会话。
- 读取工程与 capability 快照。
- 使用 `sessionId + expectedRevision` 执行 UAM 事务。
- 保存或物化工程。

Maker 只补充面向用户任务的高层工具。Viewer 与 Artifact-first Player 第一版已经落地；自动发布仍属于后续阶段：

| 工具 | 用途 |
|---|---|
| `publish_artifact` | 后续：调用 OpenFairyGUI 发布指定工程或会话 |
| Artifact REST import | 当前：导入用户选择的真实发布目录，验证二进制包、依赖和必要文件并固化快照 |
| `list_viewer_components` | 列出 Viewer 工程、稳定入口和 package/component ID |
| `inspect_project_assets` | 查询固定工程 revision 的资源健康摘要，或指定资源的 incoming/outgoing 引用 |
| `open_artifact_player` | 创建发布态回放上下文，返回 Player URL 和资源链接 |
| `list_artifact_components` | 列出发布包中的包、组件和可预览入口 |
| `render_artifact_component` | 在已打开的 Player 中通过原生 `UIPackage` 创建指定组件，可同时截图 |
| `render_component_preview` | 渲染指定组件并返回截图或预览资源链接 |
| `update_render_session` | 以稳定对象 ID 更新白名单临时属性，或驱动 Controller、Transition 与控件语义事件 |
| `set_render_view` | 使用独立 viewStateVersion 修改缩放、背景和视口 |
| `capture_render_screenshot` | 获取实际捕获时 semanticStateVersion/viewStateVersion 对应的 Canvas PNG |

工程态工具应返回 `projectId`、稳定 package/component ID 和 Viewer URL；发布态工具返回 `artifactId`、manifest URI 或 Player URL。两类工具都不应把整个工程或全部发布资源编码进单次 MCP 响应。

所有有副作用的 backend 工具必须：

- 对输入路径和工作区边界进行验证。
- 返回明确的变更摘要和诊断。
- 在覆盖文件、保存工程或删除产物前允许宿主请求用户确认。
- 继续使用 OpenFairyGUI 的 revision 和错误 envelope，不在 Maker 中重写语义。

## 6. Viewer、Player 与发布产物

一次发布目录导入生成一个内容寻址、不可变的 `artifactId`，并记录 manifest。导入完成和后续每次 Host 启动都会从实际文件重算校验信息，磁盘上的 manifest 不是信任源：

```json
{
  "schemaVersion": 1,
  "artifactId": "artifact_<digest-prefix>",
  "name": "发布目录名称",
  "digest": "sha256...",
  "createdAt": "2026-08-01T00:00:00.000Z",
  "runtimeProfile": "layaair-3.3.10/fairygui",
  "source": { "kind": "published-folder" },
  "files": [],
  "packages": [],
  "playerUrl": "http://127.0.0.1:3847/artifacts/artifact_xxx/player"
}
```

Viewer 与 Player 是两条独立渲染链路：

| 维度 | Viewer | Player |
|---|---|---|
| 稳定来源 | `projectId + sourceRevision` | `artifactId + digest` |
| 渲染输入 | 当前工程所选组件的 UAM `ViewerScene` 依赖闭包 | manifest、`.fui` / `_fui.bytes`、图集和发布资源 |
| runtime | `viewer-runtime.ts` 直接构造 FairyGUI 对象 | `player-runtime.ts` 通过原生 `UIPackage` 注册包并创建组件 |
| 行为语义 | Maker 的 UAM 交互适配层；不推断工程中未表达的业务脚本 | 发布 runtime 的原生 Controller、Gear、Transition 和控件行为 |
| 持久化边界 | 不发布、不生成 artifact、不写回工程 | Artifact 内容寻址且不可变；运行态更新不改写 Artifact |

两者只共用 Host Render Session Broker、协议 v5、白名单 operation、observation、人工交互上报和 PNG capture，不共用 renderer 实现，也不互相降级。Workbench 控件与 Agent 经过同一个 Broker；MessageChannel 仅供 Renderer 内部使用，语义版本与视图版本独立校验。

第一种视觉 runtime 固定为 LayaAir 3.3.10 与配套 FairyGUI Web runtime，并运行在隔离 iframe。Viewer iframe 只接收 Project Source Client 编译的结构化 `ViewerScene` 及所选组件依赖资产，不获得目录句柄或整个工程。Maker 自己维护 Viewer 的 UAM Scene compiler 和直接对象构造；FairyGUI Editor Online 只作为工程态 Canvas 行为与视觉效果的参考。Player 使用独立 runtime，按 manifest 加载 Artifact 文件并调用原生 `fgui.UIPackage.addPackage/createObject`，因此发布包中的原生 Controller、Gear、Transition 和控件行为由 FairyGUI runtime 执行。压缩 `.fui` 在浏览器中用标准 `DecompressionStream('deflate-raw')` 解压后加载，不恢复旧 `RawInflate` 生成物。

Viewer 的“只读”只约束工程目录：Button、TextInput、List/Tree、ComboBox、Slider、Scroll 和 Controller/Transition 都可修改当前 render session 的内存状态。人类输入与 Agent 的 `dispatch-event`、`set-controller-page`、`play-transition` 进入同一个 UAM 交互适配层，并由 `observe` 返回对象树、控件值和 Controller page；任何变化都不写回 `.fairy`。未被 UAM 表达的业务脚本、网络请求和宿主逻辑不在 Viewer 中推断或执行，发布后行为仍以 Player 为准。

首个 RC 的浏览器基线为当前稳定版 Chrome 和 Edge，自动发布门禁使用 Chromium。交互式目录授权依赖 File System Access API，Firefox 与 Safari 尚未进入支持范围。第一版不同时适配 Unity、LayaBox 和 Cocos Creator 的运行环境，也不承诺像素级还原所有自定义扩展；后续只根据真实产物扩展兼容范围。

## 7. Skills 边界

`use-fairygui-maker` Skill 只描述 Agent 应怎样组合现有工具，不承载工程解析、发布或事务逻辑。`.agents` 保存唯一完整指南；`.claude` 只转向这份通用指南，避免两套契约漂移。Skill 与 Maker MCP 同仓库、同 npm tarball 版本化，确保工具名称、只读边界、revision 和截图协议一致。

## 8. 实施顺序

### 阶段 1：localhost Host 与入口（已完成）

- 单进程 localhost Host。
- Streamable HTTP MCP 与共享 BackendRuntime。
- Host、MCP 连接和工程会话状态 API。
- Maker Workbench Dashboard 和 Viewer Web 入口。
- Host、Origin 和访问令牌校验。

### 阶段 2：工程态 Viewer 闭环（第一版已完成）

- Dashboard 只读目录授权与工程绑定。
- 原始工程读取、UAM `ViewerScene` 依赖闭包和隔离 Canvas runtime。
- 图片、位图字体、MovieClip、Controller/Gear、Transition 的工程态呈现。
- Viewer 结构树、Button/Controller/Gear/Transition 与常用控件交互、Agent 语义更新和 PNG 截图。

### 阶段 3：发布态 Player（Artifact-first 第一版已完成）

- Dashboard / Player 手动授权并导入真实发布目录。
- 持久 artifact 目录、文件 digest、manifest、包依赖与组件目录。
- 原生 `.fui` / `_fui.bytes` 回放、Agent 语义操作、观察、人工交互上报与截图。
- 后续再接入 OpenFairyGUI 自动发布、持久 ScreenshotRef、`run_ui_scenario` 和 `fairygui-publish-preview` Skill。

### 阶段 4：远程或云端

只有出现明确需求时再增加远程身份认证、持久任务、对象存储和多租户隔离。

## 9. 第一版非目标

- 不复制或分叉 OpenFairyGUI 的 UAM、事务和发布实现。
- 不把受限 restore 当作常规编辑流程。
- 不建立第二套通用插件系统。
- 不同时支持多种 Viewer runtime。
- 不在没有多客户端需求时引入数据库、队列或常驻守护进程。

## 10. 参考资料

- [Model Context Protocol：Transports](https://modelcontextprotocol.io/specification/draft/basic/transports)
- [Model Context Protocol：Tools](https://modelcontextprotocol.io/specification/draft/server/tools)
- [Model Context Protocol：Resources](https://modelcontextprotocol.io/specification/draft/server/resources)
- [MCP TypeScript SDK：Server Guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/server.md)
- [OpenFairyGUI](https://github.com/OpenFairyGUI/OpenFairyGUI)
