# FairyGUI Maker 架构

> **项目状态：开发初期，暂不能用于实际项目开发或生产环境。** 本文描述当前实现与契约，仅供实验评估和参与开发；试用范围见 [README](../README.md#当前状态与边界)。

## 定位与边界

FairyGUI Maker 是建立在 OpenFairyGUI 之上的 Agent 优先、本地优先工具层：让 Agent 检查、修改并保存 FairyGUI 工程，把已保存的工程发布成 Artifact 并在原生 Player 中验收，同时提供可复用的 Agent Skill。它不是另一个 FairyGUI 编辑器。

| 项目 | 负责 | 不负责 |
|---|---|---|
| OpenFairyGUI | 工程读写、UAM、事务、二进制协议、发布流程、Backend 会话与底层 MCP 适配 | Viewer 界面、Agent 工作流编排、Skills、预览服务生命周期 |
| FairyGUI Maker | 本地 Host、面向任务的 MCP 工具、Artifact 管理、Viewer/Player、Skills 和用户确认流程 | 重新定义 UAM、事务协议、二进制格式或发布算法 |

Maker 直接复用 `@openfairygui/core`（工程模型、UAM、二进制协议）、`@openfairygui/backend`（有状态会话、revision 检查、协调保存）、`@openfairygui/functions`（发布）和 `@openfairygui/mcp`（Backend 能力的 MCP 映射），不复制其实现。对 Agent 只暴露一个 Maker MCP 服务，内部组合 OpenFairyGUI 能力并补充发布、Artifact 和预览工具。

Maker Workbench 是 Host 提供的浏览器界面，由四个模块组成，它们不是独立的产品或服务：

| 模块 | 输入 | 职责 |
|---|---|---|
| Dashboard | 用户授权的工程、Artifact 和 Backend 会话 | 创建只读工程绑定，管理工程、revision、权限和保存授权 |
| Viewer | `projectId + sourceRevision + packageId + componentId` | 预览尚未发布的工程组件 |
| Player | `artifactId + digest + componentId` | 加载发布产物，执行回放、交互和连续 UI 验收 |
| Asset Manager | 固定 revision 的工程快照 | 查询引用、断链、无法解析 URL、不可达私有组件、未使用、重复和冲突 |

`use-fairygui-maker` Skill 只描述 Agent 怎样组合现有工具，不承载工程解析、发布或事务逻辑。`.agents` 保存唯一完整指南，`.claude` 只转向它；Skill 与 Host 同仓库、同 tarball 版本化。

## 进程与组件

### Host

CLI 启动单个只绑定 `127.0.0.1` 的 Node 进程，提供：

- `/mcp`：Streamable HTTP MCP（不实现 stdio 或 stdio-to-Host 桥接）。
- `/`：Workbench Dashboard；`/projects/:projectId/viewer`、`/artifacts/:artifactId/player`、`/projects/:projectId/assets` 为稳定深链，`/viewer`、`/player`、`/asset-manager` 为人工选择入口。
- `/api/*`：Workbench 与 Renderer 使用的 REST，见[对外接口](#对外接口)。

Host 校验 Host、Origin 和不少于 24 字符的 bearer token。完整模式下 Backend 只能访问启动目录及其子目录；`view <project-path>` 模式只保存指定目录的不可变快照，完全不注册 Backend 写工具。

持久数据默认位于启动目录的 `.fairygui-maker`，也可用 `--data-dir` 或 `FAIRYGUI_MAKER_DATA_DIR` 指定，相对路径以 Host 启动目录为基准。默认 Node Backend 在打开工程和每次写回时，以真实路径排除 data dir、其后代以及包含它的祖先工程（Node 保存会替换整个工程目录）；符号链接/Junction 别名不能绕过，相似前缀的兄弟目录不受影响。被拒绝的打开返回 `project_open_failed`，底层策略错误为 `maker_private_path_forbidden`。通过 `StartMakerHostOptions.runtime` 注入的自定义 Runtime 需自行提供等价策略。

会话上限：

- **MCP 会话**：最多 32 个，空闲 30 分钟后由每分钟清理或下一次请求回收；正在处理的调用不会被关闭，只保持 SSE GET 不算活跃。过期 ID 返回 HTTP 404 / `mcp_session_not_found`，客户端应重新 initialize，不能自动重放可能已执行的写操作；容量满返回 503 / `mcp_session_limit`。回收 MCP 连接不关闭 Backend 工程会话，也不丢弃未保存的编辑。客户端应发送 MCP `DELETE` 关闭不再使用的会话。
- **Backend 工程会话**：最多 32 个；Backend 会在内部关闭空闲 30 分钟且没有未保存修改的会话，之后调用得到 `session_not_found`，需要重新打开。Host 在会话下一次被调用时把它从 Dashboard 移除。
- `GET /api/sessions` 返回 MCP `activeRequests`、工程 `lastError` 和最近 100 次 Backend `activity`（方法、时间、session ID、稳定错误码，不含参数、异常详情或凭据）。未知异常为 `backend_unhandled_error`；不存在的 session ID 不会创建占位会话。

### 组件与数据流

```text
Viewer: Dashboard 只读绑定 → Project Source Client → UAM ViewerScene → viewer-runtime
Player: 发布目录导入或 publish_artifact → Artifact Store → 父页面校验字节 → MessageChannel → player-runtime / UIPackage

Agent → Maker MCP ─┐
Workbench → REST ──┴→ Render Session Broker → Renderer Client（页面）→ MessageChannel → 所选 runtime iframe
```

Host 是 Maker 项目记录、Import Draft、render session、Artifact 和保存授权的唯一所有者。浏览器 Project Source Client 是用户授权目录的唯一持有者：`FileSystemDirectoryHandle` 只保存在同源 IndexedDB，不进入 REST、MCP、Host 或 iframe。Agent 不直接操作 iframe 或 Canvas，只提交语义命令并读取结构化结果。

```text
src/
├─ server/            Host、REST、MCP、Artifact Store、Render Session Broker、保存授权、发布
├─ web/               Workbench、Project Source Client、Renderer Client（renderer-delivery / renderer-frame）
├─ runtime/           Viewer 与 Player 的独立 iframe runtime 和资源预算
├─ design-import/     设计源导入（已冻结）
├─ viewer-protocol.ts 共用的 render session / runtime 协议（v7）
├─ runtime-channel.ts 不透明源 iframe 的 nonce / MessageChannel 握手
└─ artifact-protocol.ts Artifact manifest 与 Player source 契约
scripts/fairygui-maker.mjs  npm CLI 入口；dist/server、dist/web 为发行构建
```

保持单 package；只有第二种 runtime profile 真正开始实现时，才把 `runtime/` 拆成 adapter package。

### Viewer 与 Player

| 维度 | Viewer | Player |
|---|---|---|
| 来源身份 | `projectId + sourceRevision` | `artifactId + digest` |
| 来源获取 | Dashboard 持久化只读目录句柄、`view` 快照或 Backend 会话预览 | 用户一次性导入发布目录，或 `publish_artifact` |
| 渲染输入 | 所选组件的 UAM `ViewerScene` 依赖闭包 | manifest、`.fui` / `_fui.bytes`、图集和发布资源 |
| runtime | `viewer-runtime.ts` 直接构造 FairyGUI 对象，不使用 `.fui` / `UIPackage` | `player-runtime.ts` 用原生 `UIPackage.addPackage/createObject` |
| 交互语义 | Maker 解释 UAM Controller/Gear/Transition 与常用控件 | 发布 runtime 的原生 Controller/Gear/Transition 与控件行为 |
| 持久化 | 不发布、不写回工程；session 只在 Host 内存 | Artifact 内容寻址且不可变；session 只在 Host 内存 |

runtime 固定为 LayaAir 3.3.10 与配套 FairyGUI Web runtime，在真实浏览器中渲染，Node 不模拟 Canvas。两条链路共用 Broker、协议 v7、父页面交付循环、白名单 operation、observation、人工交互上报和 PNG capture；Scene 编译、Artifact 校验加载和两种 iframe 实现各自独立，不互相降级。

**Viewer** 参考 FairyGUI Editor Online 主文档 Canvas 的工程态呈现（不作为代码或运行时依赖）：Maker 读取原始工程、构建 `ViewerScene`，再直接创建 runtime 对象；iframe 每次只接收所选组件的结构化 Scene、递归依赖和必要资产字节，不注册 `UIPackage`、不调用发布。“只读”只约束工程目录：Button、TextInput、List/Tree、ComboBox（由 Maker 提供通用弹层）、Slider、Scroll 和 Controller/Transition 都可修改当前 render session 的内存状态，人类输入与 Agent 操作进入同一个交互适配层。UAM 未表达的业务脚本、网络请求和宿主逻辑不推断也不执行；遇到不支持的语义返回结构化 diagnostic。发布后的行为以 Player 为准。

**Player** 只运行固定发布产物。导入时浏览器只在本次读取用户选择的发布目录并上传，目录句柄不持久化；Host 校验安全相对路径、文件数和容量、`.fui` / `_fui.bytes` magic、包 ID、依赖与组件目录，为每个文件计算 SHA-256 并按整体 digest 固化。渲染时父页面按 `artifactId + digest` 读取 manifest，在原有通道内先 `prepare-artifact` 校验并转移所选包及其依赖包的 FUI，iframe 用原生解析器注册包并返回需要的资源文件名，父页面再校验大小与 SHA-256 并转移这些资源，最后 `render-artifact` 创建组件；`unload-artifact` 统一处理失败回收。未选包不下载、不解码。压缩 `.fui` 用浏览器 `DecompressionStream('deflate-raw')` 解压。

实现边界：`src/web/lib/viewer.ts` 与 `src/runtime/viewer-runtime.ts` 负责工程态；`src/web/lib/player.ts`、`src/runtime/player-runtime.ts` 与 `src/server/artifacts.ts` 负责发布态；`src/server/viewer.ts` 负责共用的 Broker 和渲染类 MCP 工具。

## 领域契约

接口使用稳定 ID，不使用显示名称、任意文件路径或屏幕坐标作为主键。

```ts
type RegisteredProject = {
  projectId: string
  fairyguiProjectId: string
  bindingId: string
  name: string
  fairyPath: string
  revision: number
  sourceRevision: string
  sourceOwner: 'browser' | 'host'
  access: 'read-only'
  status: 'ready' | 'permission-required' | 'stale' | 'failed'
  viewerUrl: string
}

type ArtifactRef = { artifactId: string; digest: string; runtimeProfile: string }

type RenderSession = {
  renderSessionId: string
  mode: 'viewer' | 'player'
  projectId?: string
  artifactId?: string
  sourceRevision: string // Viewer 为工程版本；Player 为 artifact digest
  status: 'ready' | 'running' | 'failed' | 'closed'
  stateVersion: number // semanticStateVersion 的兼容别名
  semanticStateVersion: number
  viewStateVersion: number
  commandSeq: number
  interactionSeq: number
  lastAcceptedRuntimeEventSeq: number
}

type RenderOperation =
  | { op: 'set-property'; targetId: string; property: 'text' | 'visible' | 'enabled' | 'selected' | 'value' | 'selectedIndex' | 'icon'; value: string | number | boolean | null }
  | { op: 'set-controller-page'; targetId: string; controllerName: string; pageId: string }
  | { op: 'play-transition'; targetId: string; transitionName: string; times?: number }
  | { op: 'dispatch-event'; targetId: string; event: 'click' | 'input' | 'scroll'; data?: { text?: string; value?: number; selectedIndex?: number; deltaX?: number; deltaY?: number } }
```

- 工程态读取固定 `revision`，工程写入使用 `expectedRevision`；`sourceRevision` 标识实际用于当前投影的源版本，与 Host revision 分别记录。
- 发布态预览和测试固定 `artifactId + digest + runtimeProfile`。
- 显示对象优先使用 UAM 或发布包对象 ID；名称路径只是降级选择器，重名时报歧义。坐标操作只用于无法语义化时的诊断。
- `RenderOperation` 只修改当前 render session 的临时运行态。修改工程必须走 OpenFairyGUI 事务，Player 不改写 Artifact。
- `access: 'read-only'` 的浏览器目录绑定禁止事务、保存和物化。
- Agent 不能提交任意 JavaScript、表达式或未经白名单声明的属性。

## 工程来源与授权

### Dashboard 目录绑定

目录授权只发生在 Dashboard 的“创建/打开 FairyGUI 工程”动作中：

1. 用户点击按钮，Dashboard 调用 `showDirectoryPicker({ mode: 'read' })`。
2. Project Source Client 验证目录中的 `.fairy` 工程；没有工程或有歧义时不创建绑定。
3. 浏览器把句柄以随机 `bindingId` 存入同源 IndexedDB，读取工程生成 UAM 快照与资产索引。
4. Dashboard 向 Host 注册项目，Host 返回 `projectId` 和 Viewer URL。
5. Viewer 只按 `projectId` 消费既有绑定。read permission 为 `prompt` 或 `denied` 时返回 `project_permission_required` 并引导回 Dashboard 重新授权，不在 Viewer 或 iframe 内打开目录选择器；授权不能由 Agent 代替用户完成。

句柄不能转换成 Node 可用的绝对路径，因此 Host 只接收绑定元数据和 `sourceRevision`，UAM 快照与资产字节留在浏览器，只把选中组件的依赖闭包传给 iframe。Project Source Client 是 Workbench Shell 的同源服务，切换路由后仍复用已授权句柄；浏览器重启后从 IndexedDB 恢复句柄并先查询 read permission。

`DELETE /api/projects/:id?bindingId=...&expectedRevision=...` 移除注册、内存快照、分析与 Renderer（冲突返回 `409`），Dashboard 随后清理本浏览器同一 bindingId 的句柄；重复删除 `404` 可继续本地清理。源工程、Draft 和 Artifact 文件都不删除。Host 项目注册不跨重启持久化。“清理失效授权”只删除当前 Host 未注册、保存超过 24 小时的本浏览器记录；移除句柄不等于撤销浏览器的系统权限。网络结果不确定的注册保留本地句柄，待确认或显式清理。

### 快照与 sourceRevision

浏览器和 CLI 共用 `src/project-snapshot.ts`。Core ProjectReader 从唯一 `.fairy` 读取五种标准 settings JSON、`assets`/`assets_*` 的 package/component XML 和已声明资源字节，另收集文本/XML/BMF v3 位图字体 page、Spine `.atlas` page、DragonBones `_tex.json` 的 `imagePath` 及显式 `atlasNames` 依赖。这是整个工程资源目录（Asset Manager 需要），不是整个磁盘目录。

默认忽略任意点开头路径（含 `.env*`、`.git`、`.svn`、`.openfairygui`、`.fairygui-maker`），以及 `node_modules/dist/build/out/coverage/library/temp/obj/bin` 和 `.pem/.key/.p12/.pfx`；未声明的源码、部署 JSON 等不会读取或出现在 Source API。拒绝根目录越界、符号链接/特殊文件和不安全路径，没有绕过隐藏文件策略的开关。

| 扫描边界 | 上限 |
|---|---|
| 每轮枚举条目 / 可见文件 / 目录（含根） / 深度 | 10,000 / 5,000 / 1,000 / 32 |
| 单个文件 / `.fairy/.xml/.json/.atlas/.fnt` | 128 MiB / 8 MiB |
| 一次依赖快照字节 | 512 MiB |
| 时间与取消 | 60 秒协作式 deadline；Dashboard、Viewer、Asset Manager 显示进度并可取消 |

读取前检查大小，读入后逐文件重读比对并复核目录索引，有变化则失败、不发布新 revision。`sourceRevision = SHA256(JSON.stringify(sorted([relativePath, SHA256(bytes)])))`（按路径 code-unit 排序），UAM 从同一冻结依赖集合构建。同大小、同 mtime 的内容修改也会改变摘要，无关文件不影响摘要。它不是操作系统原子快照或文件锁，也不是解析器 CPU/RSS 的硬沙箱。

浏览器 Viewer 与 Asset Manager 先读 Host 当前记录，再读取并复核目录，最后调用 `POST /api/projects/:projectId/refresh { bindingId, fairyguiProjectId, expectedSourceRevision, nextSourceRevision }`。冲突返回 `409` 且不自动重放；相同内容不增版本；内容变化时更新 sourceRevision、revision + 1、清空 AssetAnalysis，并立即关闭旧 Renderer、拒绝 pending 命令。注册接口只允许完全相同输入的幂等重试；不可变的 Host 快照拒绝浏览器 refresh。Source API 支持 `sourceRevision` 查询守卫。Host 无法重算浏览器未上传的字节，浏览器摘要是已认证客户端的声明，不是签名证明。

`view` 模式由 Host 在启动时读取唯一显式目录并保存只读内存快照，Agent 只能按相对路径读取。

### Backend 会话预览

Backend 会话可通过 Dashboard 活跃会话行的“预览会话”或 `open_session_preview({sessionId, expectedRevision})` 进入 Viewer：

1. 通过 Backend 打开授权工程，用 outline 找到 ID，再用 `query_entity` 读取当前属性和 revision。
2. 打开返回的 `project.viewerUrl`；renderer 注册后复用 Viewer 的组件列表、渲染、observation、capture 和 `run_ui_scenario`。
3. Backend 修改、保存或关闭会话会让旧 renderer 失效；页面显示真实 Backend revision 和 dirty 状态，“刷新工程”读取新版本。
4. 保存走[保存授权](#保存授权)；需要验收持久化时关闭并重开同一工程，读回保存的字段和 revision。重开不继承旧会话的保存权限。

预览不保存、不请求保存授权，也不把临时 Viewer 操作写回 Backend。Host 只保留会话 ID、revision、dirty/save 元数据和 Viewer 绑定，不缓存另一份权威 UAM。`GET /api/projects/:id/session-state?sourceRevision=...` 使用公开 `readSessionState`；资源端点使用 `readResourceBytes({sessionId, expectedRevision, selector:{packageId,resourceId}})`，只读内存中的主文件字节。浏览器从完整模型构建依赖闭包，按需读取跨包图片、字体和字体声明的 glyph；所有请求固定在同一预览版本，中途版本变化立即失败。模型遵守上游 4 MiB JSON、深度 64、500,000 节点的限额，单个资源最多 1 MiB；Maker 另限 5,000 个组件/依赖资源、256 MiB scene 和 15 秒读取。缺字节、模型不完整或保真不支持时显式失败。

此处的 `sourceRevision` 是绑定 ID、预览代次和 Backend 元数据的身份摘要，**不是文件内容 hash**：保存可能不增加 Backend edit revision，但仍会递增预览代次并使旧 renderer 失效。Asset Manager 需要完整资源扫描，不接受会话预览。

### 保存授权

完整模式通过上游公开的 `toolPolicies` 为 `save_session` 与 `materialize_session`（含 `force: true` 和 `mode: "materializeCleanSession"`）声明 Host 策略：`beforeCall` 检查会话权限或消费单次授权，返回 `undefined` 后由 MCP 调用 Backend 一次。`applyTransaction` 只修改 Backend 内存。没有权限的保存产生 Approval Request，并通过声明的 `failureSchema` 返回 MCP `isError: true` / `backendResult.ok: false` / `error.code: "save_approval_required"`，不调用任何 Backend 写方法；会话不可用时返回 `save_session_unavailable`。Host 指引通过公开 `instructions` 传入初始化握手。

1. Agent 提交明确的 `sessionId + expectedRevision` 和保存选项；普通保存和 force-save 都必须带 revision。
2. 所有者在 `/#save-approvals` 的“工程保存权限”中输入独立确认密钥验证一次，浏览器获得独立会话 Cookie；随后核对工程、目标和操作，选择单次批准、会话普通保存授权或拒绝。
3. 授权本身不保存。Agent 用相同参数重试：单次授权先消耗再执行；会话授权允许原工程后续的普通保存，revision 改变无需重新授权。force、任何显式 targetPath、`materializeCleanSession` 和 `materialize_session` 始终单次确认。
4. Backend 的 revision 队列、目标路径限制、保真校验和事务写盘错误照常执行，不因批准而放宽。

```text
GET /api/save-approvals
  -> { enabled, ownerVerified, preauthorizedProjects, approvals: [{ approvalRequestId, approvalGrantId?, sessionId,
       revision, operation, canonicalProjectPath, targetPath, force, mode, reason,
       operationDigest, scope: "once" | "session", sessionEligible,
       status, createdAt, expiresAt, decidedAt?, consumedAt? }] }

POST /api/save-approvals/owner-session
X-Maker-Approval-Token: <owner-only credential>
  -> { ownerVerified: true } + independent HttpOnly session Cookie

DELETE /api/save-approvals/owner-session
Origin: <Host origin>
  -> revoke this browser's owner Cookie; project permissions are unchanged

POST /api/save-approvals/:approvalRequestId/decision
Origin: <Host origin>
Cookie: <normal Host Cookie and independent owner Cookie>
{ "decision": "approve" | "approve-session" | "reject" | "revoke" }
```

所有接口仍经过 Host/Origin 与 bearer/HttpOnly Cookie 认证。首次验证以恒定时间比较独立密钥，生成随机的 `fairygui_maker_owner` Cookie（HttpOnly、SameSite=Strict、路径 `/api/save-approvals`，不含原密钥）；Cookie 授权决定还必须带精确的 Host Origin。只持有 MCP token、普通 Cookie、伪造请求头或已知 grant ID 不能创建权限。决定接口也接受独立的 `X-Maker-Approval-Token`。决定对象不存在返回 `404`，终态/过期/旧 revision 或为特殊操作申请会话权限返回 `409`，凭证缺失或错误返回 `403`。没有 MCP 所有者验证或批准工具。

`FAIRYGUI_MAKER_APPROVAL_TOKEN` 可由所有者配置（24–256 字符，不得与访问 token 相同）；未配置时每次启动随机生成，只在完整模式的交互 stdout 显示。非交互启动不输出随机密钥，没有预设凭证就无法批准。可信嵌入调用者可用 `startMakerHost({ approvalToken })`，返回值也包含随机密钥；HTTP/MCP/status 不返回它。Workbench 用 password 输入，请求发出前清空输入，不把密钥放进 URL、Cookie、Storage 或查询缓存。Host 最多保留 32 个所有者浏览器会话；锁定撤销当前浏览器凭证，Host 重启使全部失效。锁定授权管理不撤销工程权限。

| 边界 | 行为 |
|---|---|
| 绑定 | 单次：session ID、revision、完整操作与目标；会话：session ID 和规范工程路径，只允许不带 targetPath/mode 且 force 非 true 的 saveSession |
| 有效期 | 待确认请求和单次授权从创建起 5 分钟；会话授权持续到会话结束或撤销 |
| 次数 | 单次先 consumed 再执行，并发最多一次，失败不退回；会话授权可重复普通保存，每次仍校验当前 revision |
| 失效 | 会话关闭、同 ID 重开、目标变化、撤销或 Host 重启使会话权限失效；单次还受 revision 变化和超时约束；撤销不中断已授权的在途保存 |
| 容量 | 最多 128 条记录；相同活跃请求去重，满额先淘汰最早的终态记录，全部活跃时返回 `save_approval_limit` |
| 输入 | session ID 128 字符、目标路径 4,096 字符、reason 1,000 字符；未知保存选项拒绝 |

状态为 `pending / approved / consumed / rejected / revoked / expired / stale`。单次授权的“已消耗”只表示尝试执行过，成功与否以 Backend 结果和磁盘验证为准；网络结果不确定时先查询状态，不自动再次批准或重试。记录只在内存，不是持久审计账本。

**按工程预授权**：所有者可在启动时用 `--allow-save <工程>`（API 为 `allowSave`）预授权指定工程的普通保存。路径启动时解析为真实目录（`.fairy` 文件取其目录），必须存在；只与 Backend 会话报告的工程目录精确匹配（Windows 不区分大小写），不覆盖子目录或其他工程，只在本次进程有效，MCP 与 REST 都无法授予或修改。命中时跳过所有者确认，revision、输入与磁盘检查不变；特殊操作仍走单次确认。Workbench 卡片和 CLI 启动输出都会列出这些工程。

`view` 模式不注册 Backend 写工具，不能批准保存，也不接受 `--allow-save`。CLI/Import Draft 向尚不存在的新目录物化不属于已有工程的保存授权。MCP 没有 `restore` 或独立的落盘 delete/move 工具；内存中的资源删除/移动会在下次授权保存时落盘，界面会提示覆盖和删除风险。这一边界约束的是只持有 Maker API 凭证的客户端，不是针对能读取 Host 环境或直接写工程的本机进程的操作系统沙箱。

### 自动发布

`publish_artifact` 只在完整模式注册：Host 用 `@openfairygui/functions` 的 `publishNode` 发布一个已保存、没有未保存修改的 Backend 会话，固定 LayaAir profile，跳过工程插件与代码生成，输出到 Maker 私有数据目录的临时目录，再经 Artifact Store 的同一校验与提交流程固化为 `verification.source: host-published`。同一时间只运行一次发布；会话有未保存修改、revision 不符或发布期间发生变化时拒绝，不导入任何内容。发布前后都核对会话仍是同一个已保存 revision，但保存之后在 Maker 之外对工程文件的改动不会被检测。REST 导入只能声明 `published-folder` / `browser-publish` 来源，`host-publish` 只由 Host 写入。

## 隔离与预算

### Iframe 隔离

Viewer 与 Player 都使用 `sandbox="allow-scripts"`（不授予 `allow-same-origin`）并启用 `credentialless`，iframe 导航与子资源请求不携带 Host Cookie。Host 对两个 runtime HTML 另外返回 CSP `sandbox allow-scripts`，直接打开 runtime URL 或移除 iframe 属性也不能恢复同源权限。runtime 无法访问父页面 DOM、Cookie、Storage 或目录句柄，也不能打开弹窗或导航顶层页面。浏览器不支持 `credentialless` 时明确停止连接，不退回带凭证的 iframe（[Chromium 说明](https://developer.chrome.com/blog/iframe-credentialless)）。Host 保留单个端口，依靠不透明源隔离；只换端口并不够，因为 Cookie 不按端口隔离（[HTTP Cookie 规范](https://httpwg.org/http-extensions/draft-ietf-httpbis-rfc6265bis.html#section-8.5)）。这不是浏览器进程或操作系统沙箱。

- **握手**：每次连接导航到新 Document，URL fragment 带随机 nonce。父页面只接受该 Window 的 `origin: "null"` 与匹配 nonce 的 pong；runtime 只接受 `event.source === parent`、固定父来源、协议 v7、匹配 nonce 和唯一 MessagePort。首次连接同步锁定，错误 nonce、兄弟窗口、旧文档 nonce 和重放不能替换端口。向不透明源发送时必须用 `targetOrigin: "*"`，因此上述身份校验不能省略。nonce 不是 Host 凭证。
- **资源**：Viewer 转移选中组件闭包的 ArrayBuffer；Player 父页面先检查文件数、单文件 128 MiB、总编码 256 MiB，再逐文件有界读取、校验大小和 SHA-256、禁止重定向并支持取消，同一 Artifact 首次成功后不重复转移。runtime 只使用虚拟缓存键和自身创建的 Blob URL，原生包音频也映射到 Blob。
- **图片 Worker**：父页面读取安装包内的受信任 Worker 代码（最多 256 KiB）随连接传入；runtime 用 Blob Worker 验证图片，结束时终止 Worker、由创建方撤销 URL。
- **网络与主动内容**：runtime CSP 只允许安装包脚本、Blob/data 图片和字体、Blob 音频/Worker/连接，禁止访问 Host/API、表单和外部 frame/object。只有启动时枚举的构建文件和三个固定供应商脚本可匿名 CORS 读取。受保护路由拒绝 `Origin: null` 和 cross-site/same-site Fetch Metadata 请求，CLI 无该请求头时仍需 Bearer。Source 与 Artifact 文件统一返回 octet-stream、attachment、nosniff、`default-src 'none'; sandbox`，HTML/SVG/JS 只能下载。
- **兼容**：通过 Laya PAL 禁用 runtime 持久存储。跨源 iframe 不可见时 Chromium 暂停 rAF，命令采用 50ms 定时回退，离屏 render/update/capture 不阻塞；截图仍调用实际 `drawToCanvas`，不保证隐藏动画已 settle。

安全验收针对 `pnpm build` 后由 Host 提供的页面；Vite `dev:web` 只用于可信源码的 UI 调试，不要为调试放宽 Host 的 Origin、CORS 或 sandbox 策略。

### 有界上传

认证后的 POST/PUT/PATCH 先按实际字节计数，再交给 JSON/MCP/multipart 解析器或 Store；`Content-Length` 只用于提前拒绝，缺失或伪报长度不能绕过流内限制。被拒绝的请求关闭连接。

| 边界 | 上限 |
|---|---|
| REST/MCP JSON（含截图 Base64 envelope） | 16 MiB；截图另有 14,000,000 字符校验 |
| Artifact 单文件 / 单次导入 | 128 MiB / 512 MiB，最多 5,000 文件 |
| Import Draft 上传源 | 总计 530 MiB，最多 5,000 文件 |
| Visual Evidence multipart | 48 MiB + 64 KiB；恰好一个 report 和 reference/capture/diff 各一张 PNG，每张最多 16 MiB |
| 活跃二进制与视觉上传 | Host 合计 4 个；每个 Import/Draft 同时只写一个源文件 |
| 待完成上传 | Artifact 与 Draft 各最多 16 个；声明容量分别累计最多 512 MiB、530 MiB |
| 请求体接收时限 / 待完成空闲有效期 | 5 分钟 / 30 分钟，成功写入文件后续期 |

二进制直接流入 `.uploads/<uuid>.part`，边写边计数和计算 SHA-256，flush、实际大小与摘要校验通过后才原子改名。超限返回 `413`，短传 `400`，同路径不同内容重试 `409`，相同内容重试成功且不覆盖。Artifact manifest 的每项必须提供 `{ path, size, sha256 }`（64 位小写十六进制）；Draft 使用 `{ path, size }`，重试时比较实际内容摘要。

取消 Artifact 用 `DELETE /api/artifact-imports/:importId`，取消 Draft 用 `DELETE /api/import-drafts/:draftId?expectedRevision=...`；取消、断流或超时会关闭流并清理临时文件，超时返回 `408`，容量或并发已满返回 `503`。Host 同时只 finalize 一个 Artifact，忙碌返回 `409`。Host 每分钟及创建新上传前清理过期上传，重启时清理未完成目录和孤立 `.part`。multipart 使用原生 `formData()`，解析前有固定总量限制，但不是全流式解析器；容量配额只针对待完成的源文件声明。

### 运行时资源预算

Viewer 与 Player 共用 `src/runtime/resource-budget.ts`；上传成功不代表资源一定能在浏览器播放。超限返回 `resource_budget_exceeded: <资源名>`，失败的 render 回收当前场景、未挂接对象、纹理缓存与 Blob URL，同一 iframe 可继续合法渲染。

| 运行时边界 | 上限 |
|---|---|
| 单个编码文件 / 一次场景或 Artifact 的编码资源 | 128 MiB / 256 MiB |
| FUI 解压 | 包头与全部包解压结果累计 256 MiB；每包最多膨胀 100 倍 |
| 单次 fetch + 解压或图片加载 | 15 秒；流最多 16,384 块，逐块检查；重连或离开页面中止 |
| 单张图片 / 截图 | 宽高各最多 8,192，面积最多 8,388,608 像素 |
| 已解码图片 RGBA 估算 / 纹理句柄 | 累计 128 MiB / 1,024 个（含 atlas 子纹理、MovieClip 帧、位图字体字形） |
| Player 音频 | 单文件 8 MiB、累计 32 MiB、32 个；单段最多 30 秒、最多 8 个同时播放，同一段只一个 voice |
| 场景 | 最多 5,000 个实际创建对象，组件/显示树深度最多 64；重复引用按展开后的实例计数 |
| Observation | 一次最多 5,000 个对象节点、10,000 个条目（含 Controller/Page/Transition）、64 层；单字符串 16,384 个 UTF-16 code unit，累计 1,048,576 个 |
| 源元数据 | 同样限制字符串、数组和总条目，结构深度 128；Player 在原生解析前检查字符串表，所有包累计最多 10,000 个条目、5,000 个资源 |

PNG 在任何解码器运行前检查 IHDR，PNG/JPEG 的完整校验复用 Core 并放入可终止 Worker。静态 SVG 复用 Core 安全校验，再固定经过预算检查的栅格尺寸；静态 WebP 检查 RIFF canvas 与实际位流尺寸（[格式规范](https://developers.google.com/speed/webp/docs/riff_container)）。APNG、动态 WebP 和无法安全预检的图片拒绝播放。图片只从已校验字节生成 Blob 后顺序解码；外部 Loader/3D URL 被拒绝，底层加载器只接受当前场景登记的 URL。Player 在工厂、组件构造与纹理创建边界计数，不另写 FUI 解析器，也不改动冻结的 vendor 文件；Observation 超限明确失败，不截断。音频使用原生 HTML 流式媒体，先检查 metadata 时长，切换、失败或卸载时暂停、清空 src、撤销 Blob。

这些是输入与资源句柄预算，不是浏览器进程的硬内存沙箱：纹理估算不含驱动/mipmap/排版开销，实际 GPU/VRAM 内存未验证。

### 内存压力门禁

`pnpm test:memory`（Node）和 `pnpm test:browser` 中的预算烟测执行以下门禁，JSON 证据写入 `test-results/memory/` 和浏览器报告：

| 用例 | 输入与断言 |
|---|---|
| Bundle | 16 × 8 MiB 合成资源完成序列化/摘要/解析；513 MiB 声明在摘要前拒绝，随后合法 Bundle 可解析 |
| Base64 | 64 MiB Uint8Array 经 CLI/Host 共用编码器往返字节相同 |
| 大量图片 | 5,000 × 32 KiB 做 Asset 分析；5,001 个资源拒绝；在途哈希最多 1 |
| 引用 | 50,000 条成功，50,001 条拒绝，随后小输入恢复 |
| Override | 1 MiB 文本的 33 个克隆触发 32 MiB 预算，随后 16 个克隆成功 |
| 实际解码 | Viewer 加载 4 张 4096 × 2048 PNG（RGBA 估算 128 MiB），第 5 张在解码前拒绝；失败/替换后的原生纹理全部 destroyed |
| 实例展开 | 100 × 100 叶对象请求在 5,000 场景节点边界终止，正常场景恢复 |
| Player A/B | 同一 iframe 中 100 次两阶段加载，每次 256 个 atlas 子纹理；每 10 次卸载并 GC，检查包、Blob、缓存、原生资源和 JS 堆回落 |
| Player 闭包 | 跨包组件可创建，未选包未注册；切换根包移除旧闭包；父页面不读取未请求的 500 MiB 文件声明 |
| 音频 | WAV 以流式媒体播放、不走 PCM loader；31 秒 WAV 拒绝；卸载后媒体暂停、src 清空、Blob 撤销 |

Node 每例在独立子进程执行：峰值 RSS < 1 GiB，三次 GC 后 heapUsed 增量 < 32 MiB、ArrayBuffer 增量 < 4 MiB；采样峰值不覆盖每个瞬时分配，RSS 不作回落断言。Player 通过 CDP 每 10 次强制 GC：第 100 次相对第 10 次堆增量 < 4 MiB、backing storage 增量 < 1 MiB，最后 50 次堆增量 < 1 MiB；卸载后包与 Blob 为零，缓存与原生资源数回到热身基线。有限次采样不等于无泄漏证明。

## Render Session 协议

### 生命周期

1. Viewer 已有工程来源，Player 已有不可变 Artifact。
2. Agent 或用户打开稳定的 Viewer / Player URL，页面读取工程或 manifest。
3. 页面与 iframe 完成 MessageChannel 握手，开始缓冲 interaction。
4. 页面通过 `/api/renderers` 注册 `mode + sourceRevision + protocolVersion`，Host 创建 `ready` 会话（同一来源的新 renderer 替换旧会话），页面按 `commandSeq` 长轮询。
5. Host 下发语义命令；iframe 执行后返回结果、observation 或 PNG，页面提交结果，Host 返回幂等 ACK。
6. 人工交互按 `runtimeEventSeq` 回传并推进语义版本；超时、版本冲突或 runtime 错误得到明确失败。

协议 v7 分两层：页面与 Host 通过 `/api/renderers`、命令长轮询、结果 ACK 和 interaction 上报通信；页面与 iframe 通过 MessageChannel 通信。Host 命令统一为 `render / update / view / observe / capture`，Renderer 再转换为 Viewer 的 `render` 或 Player 的 `prepare-artifact / render-artifact / unload-artifact`。Workbench 的组件选择、Controller、Transition、缩放、背景、视口和截图都通过 `POST /api/render-sessions/:id/commands`，与 MCP 共用同一队列、幂等缓存与版本校验；界面状态来自 Host ACK。使用 HTTP 长轮询而非 WebSocket；TanStack Query 不承载命令队列。

**无头渲染**：页面尚未注册 renderer 时，开启无头渲染的 Host（CLI 默认开启，`startMakerHost` 需显式传入 `headless`）用自己的无头浏览器加载对应页面并等待注册，最长 30 秒；该浏览器以 HttpOnly Cookie 认证，令牌不进入 URL。浏览器授权的工程、关闭无头渲染或找不到浏览器时，工具返回 `browser_required` 和稳定 URL（附 `headlessError`），不伪造渲染完成。按 render session 操作时也返回会话原本的深链，页面重连后 Agent 重新获取新会话。

### 命令与观察

语义命令：创建或切换组件、设置 Controller page、播放 Transition、按对象 ID click/输入/滚动、读取对象树与控件状态、截图。观察结果包含对象 ID、名称、类型、bounds、visible、text，Controller/page/Transition 状态，缺失资源、加载超时和 runtime error，以及最近的交互事件。文本节点可带字体证据，规则见[设计源导入](./design-import.md#诊断与保真边界)。

v7 不暴露 `settle`：命令结果只确认 runtime 已执行本次操作，不声称 `idle` 或动画已完成。条件等待由 `run_ui_scenario` 编排。

### 版本、顺序与幂等

| 版本 | 推进条件 | 前置条件 |
|---|---|---|
| `semanticStateVersion` | render/update、每条已接受的 runtime interaction | `expectedStateVersion` |
| `viewStateVersion` | zoom/background/width/height 的 view 命令 | `expectedViewStateVersion` |
| `stateVersion` | 兼容别名，始终等于 semanticStateVersion | 旧调用继续有效 |

- Host 为命令分配严格递增的 `commandSeq`，renderer 按序执行并回传 ACK。两个 CAS 都在入队和队头首次下发前校验，同版本并发请求不会全部执行；runtime 在语义命令前校验 `expectedRuntimeEventSeq`，防止旧命令覆盖尚在上报的人工事件。冲突返回 `409`，Workbench 刷新状态并提示，不自动重放。
- 同一 `operations` 批次在一次提交中应用，失败也会使旧语义版本失效，不承诺回滚；observe/capture 不推进版本，用 `afterStateVersion` / `afterViewStateVersion` 拒绝读取尚未到达的版本。不确定的 view 失败或 iframe 请求超时关闭会话。`stateSeq` 只用于过滤乱序的状态响应，不是第三种业务版本。
- `requestId` 用于安全重试：同一 ID 同一 payload 返回原结果，换 payload 报冲突。每个会话保留最近 256 个 request ID，未完成的请求不淘汰。
- `set_render_view`：zoom 0.1–4、六位十六进制背景色、正整数 width/height（受图像预算限制）；面板 resize 合并为最多一个在途 view 请求，runtime 使用固定设计视口。
- Host 缓存最新 observation 和最近交互摘要；render session 与截图都不跨 Host 重启持久化。

### 可靠交付

页面与 Host 的通信统一在 `src/web/lib/renderer-delivery.ts`，与 iframe 的通信在 `renderer-frame.ts`，握手在 `runtime-channel.ts`。每次只执行一条 Broker 命令，并保留该次成功或失败结果的原始 JSON，直到收到匹配 `commandSeq + requestId` 的 ACK；网络故障只重新 POST 同一结果，不重新操作 iframe。Host 为结果保留规范化 JSON 的 SHA-256 receipt（对象字段顺序无关，数组顺序有关）：相同结果重复提交返回 `200 { accepted: true, commandSeq, requestId }`，不同结果、错误身份、乱序或过期 receipt 返回 `409 result_conflict`。

Interaction 在注册前就接入 outbox，严格按序发送，队头收到 `200 { accepted: true, runtimeEventSeq, session }` 才移除。相同序号相同 payload 幂等接受，不同 payload 返回 `409 interaction_conflict`，缺失前序返回 `409 interaction_sequence_gap`；`session.lastAcceptedRuntimeEventSeq` 可查询当前位置，不跳号或伪造事件修复 gap。

| 交付边界 | 行为 / 上限 |
|---|---|
| 客户端结果缓存 | 同时 1 个已执行结果（含失败），ACK 后释放 |
| Interaction outbox | 页面内存最多 256 个事件、合计 1 MiB；单事件最多 64 KiB |
| Host interaction 校验 | target ID 128 字符；data 最多 32 字段、key 128 字符、单字符串 16,384 code unit |
| Host receipt | 每会话结果、interaction 各最近 256 个摘要；淘汰项的重放明确冲突 |
| 重试 | 网络中断、408、429、5xx 按 250 ms→2 s 退避；连续失败 60 s 后停止 |
| HTTP 时限 | 长轮询 35 s（Host 等待最多 25 s），POST/注册 10 s；其他 4xx、错误 ACK、gap/超限立即停止 |
| 命令超时 | 入队起 30 s；未收到结果时执行状态未知，关闭整个会话并拒绝剩余 pending |
| iframe 时限 | 启动 20 s；Viewer/Player 命令分别 20/30 s。握手失败、发送异常、fatal、取消或重复 destroy 都回收等待项，迟到响应不串入新请求 |
| 关闭 / TTL | 页面卸载、切换或 stop 时以 keepalive DELETE 关闭 Host 会话；失败时由 5 分钟不活跃 TTL 兜底 |

严重断线、Host 重启、会话替换、gap 或超限都会移除 AGENT READY 并显示原因与“重新连接”；重新连接会重载页面、重置 iframe 并注册新会话，bfcache 恢复的已关闭页面也会重载。第二个页面接管时第一个显示 `renderer_replaced`；Broker 保留最多 256 条、最长 5 分钟的关闭原因（不保存截图、observation 或命令），会话 HTTP 入口在 404 中返回该原因，旧页面的关闭请求不能关闭新会话。Agent 必须重新获取 session ID，不自动重放旧操作。短暂断网可以在同一页面恢复，但不承诺跨刷新、浏览器崩溃或 Host 重启的 exactly-once。

### 截图

```ts
type CaptureRenderScreenshotInput = {
  renderSessionId: string
  requestId: string
  afterStateVersion: number
  afterViewStateVersion?: number // MCP 默认 0；Workbench REST 必须显式传入
}
```

未到达 `afterStateVersion` 时返回 `state_version_not_reached`，不返回旧图。两种 runtime 都只截取实际 Laya 舞台（`Laya.stage.drawToCanvas()`）；Viewer 的资产以本地 Blob URL 解码，外部 URL 不纳入依赖，避免污染 Canvas（非 origin-clean Canvas 会拒绝读取像素，参见 [toBlob](https://developer.mozilla.org/en-US/docs/Web/API/HTMLCanvasElement/toBlob)）。runtime 在 `drawToCanvas` 时固定 interaction watermark，Renderer 先交付相关事件再提交结果，Host 按下发基线和捕获序号计算截图版本；编码或 ACK 重试期间的新交互不会污染旧图版本。结果包含 `renderSessionId + sourceRevision + semanticStateVersion + viewStateVersion`、组件身份和视图参数。

页面把 PNG 以 `screenshotBase64` 随 ACK 返回；Host 立即作为 MCP `image/png` content 返回，文本中标记 `screenshot: { attached: true, mimeType: "image/png" }`。普通截图不创建持久 `ScreenshotRef` 或 resource URI。组件证据应使用 Canvas 截图，浏览器整页截图只用于审查 Workbench 自身。

### 连续 UI 场景

`run_ui_scenario` 复用同一通道串联 update、assert、wait-for 和 capture。输入绑定 renderSessionId、sourceRevision 和起始双版本，最多 20 步、100 个操作、一次 PNG，输入不超过 256 KiB，总期限不超过 30 秒。断言读取真实 observation，交互条件只接受场景开始后已确认的事件。失败即停止，保留已执行步骤和从零开始的 failedStep，不回滚。源变化或 renderer 关闭终止场景；命令在途超时则关闭旧会话。每个 renderer 保留最近 8 份幂等场景回执，同一 requestId 不接受不同输入。它只编排临时运行态，不写工程。完整的[输入、示例与恢复规则](../.agents/skills/use-fairygui-maker/references/ui-scenarios.md)随 Skill 分发。

## Artifact 存储

`ArtifactBlob` 只描述内容：`artifactId + digest + runtimeProfile + files + packages`。`ArtifactImportRecord` 独立描述每次导入的 `importId + sequence + name + source + createdAt`，并绑定完整 `artifactId + digest`。同内容只存一份字节，每次导入产生新记录，不覆盖旧名称、项目或 revision。短 ID 为 SHA-256 前 24 位十六进制，复用前比较完整摘要，不同摘要返回 `409 artifact_id_digest_collision`。

REST 与 MCP 的 Artifact 查询返回 `verification.content: host-validated`（Host 已检查文件字节、摘要和包元数据）以及 `verification.source`：客户端导入为 `client-declared`，`source.kind/projectId/sourceRevision` 都是客户端声明，`browser-publish` 或相同 revision 都不是发布证明；`publish_artifact` 产生的为 `host-published`。客户端不能提交 verification 字段提升可信度。

```text
artifacts/<artifactId>/manifest.json     v2: { schemaVersion: 2, blob, initialImport }
artifacts/<artifactId>/<published-file>  原始内容字节，再次导入不改写
artifact-import-records/<importId>.json  同内容后续导入的独立记录
```

首次完成先在私有 Import 目录校验文件、写入并 flush manifest，再通过目录 rename 一起提交内容与首条记录；重复导入先重新验证已有内容，再以 `.part → flush → rename` 写入新记录，最后更新内存索引。相同 `importId` 的完成重试返回原记录，跨重启幂等。损坏或未索引的目标目录返回 `artifact_storage_conflict`，不自动删除或覆盖。旧 v1 manifest 以只读方式恢复为 Blob 和 `legacy_<artifactId>` 首条记录；启动时逐项校验记录，忽略损坏、重复或孤立的记录。Host 重启时重新校验 manifest、文件大小、SHA-256、整体 digest 和包目录，不一致的 Artifact 不载入，也不自动删除。旧版本不能读取 v2 格式，降级前应恢复兼容备份。

文件 API 每次都读取并校验实际字节：沿路径拒绝 symlink/junction、硬链接和非普通文件，平台支持时使用 `O_NOFOLLOW`（Windows 不可用，所以路径与句柄复核不能省略，参见 [Node fs](https://nodejs.org/api/fs.html)），比较打开前后的文件身份、大小与时间戳，最多分配声明的单文件大小（上限 128 MiB），然后对即将返回的同一份 Buffer 重算 SHA-256。FUI 元数据从已验证字节解析，不重新打开路径。运行期篡改、截断、增长、丢失或替换为链接返回 `409 artifact_file_integrity_mismatch`；成功响应的 ETag 对应实际字节，并使用 `Cache-Control: no-store`。

API manifest 是 Blob 与某次记录的投影（默认最近一次，`?importId=` 指定历史记录）：

```json
{
  "schemaVersion": 1,
  "importId": "import_<uuid>",
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

- `GET /api/artifacts?limit=50`：最多 100 条轻量摘要（`fileCount/packageCount/componentCount/totalBytes/importCount`）。
- `GET /api/artifacts/:id/import-records?limit=50&cursor=...`：按递增序号倒序分页，最多 100 条，新导入不移动已读取记录。
- `GET /api/artifacts/:id/components?limit=100&cursor=0`：不可变组件目录按偏移分页，最多 500 条，返回 `packageId/packageName/componentId/componentName`、`total` 和 `nextCursor`。

Player 连接只绑定 `artifactId + digest`，来源名称或记录变化不会重建 iframe；页面重载或内容身份改变才建立新连接。一个 data dir 只能由一个 Host 写入；保证应用提交点与进程重启恢复，不保证跨平台断电事务，也不把同一 OS 用户可写的数据目录当作防篡改存储。备份应包含整个 data dir。

## 对外接口

### REST

REST 供 Workbench 和 Renderer Client 使用，与 MCP 工具调用同一组应用函数：

- 状态与授权：`GET /api/status`、`GET /api/sessions`、`GET /api/save-approvals`、`POST|DELETE /api/save-approvals/owner-session`、`POST /api/save-approvals/:approvalRequestId/decision`
- 工程：`POST|GET /api/projects`、`GET /api/projects/:projectId`、`POST /api/projects/:projectId/refresh`、`DELETE /api/projects/:projectId?bindingId=&expectedRevision=`、`GET /api/projects/:projectId/source-index?sourceRevision=`、`GET /api/projects/:projectId/source-file?path=&sourceRevision=`、`GET|PUT /api/projects/:projectId/asset-analysis`
- 会话预览：`POST /api/session-previews`、`GET /api/projects/:projectId/session-state?sourceRevision=`、`GET /api/projects/:projectId/resource-bytes`
- Render session：`POST /api/renderers`、`GET|DELETE /api/render-sessions/:id`、`GET /api/render-sessions/:id/commands?after=`、`POST /api/render-sessions/:id/commands|results|interactions`
- Import Draft：`POST|GET /api/import-drafts`、`GET /api/import-drafts/:draftId`、`DELETE /api/import-drafts/:draftId?expectedRevision=`、`PUT /api/import-drafts/:draftId/source?path=`、`POST /api/import-drafts/:draftId/source/complete`、`POST /api/import-drafts/:draftId/parse|plan|compile|materialize`、`PATCH /api/import-drafts/:draftId/semantic-overlay`、`POST /api/import-drafts/:draftId/visual-evidence`、`GET /api/import-drafts/:draftId/visual-evidence/:image`
- Artifact：`POST /api/artifact-imports`、`PUT /api/artifact-imports/:importId/files?path=`、`POST /api/artifact-imports/:importId/complete`、`DELETE /api/artifact-imports/:importId`、`GET /api/artifacts`、`GET /api/artifacts/:artifactId`、`GET /api/artifacts/:artifactId/import-records|components`、`GET /api/artifacts/:artifactId/files/*`

### MCP 工具

OpenFairyGUI Backend 工具负责打开/关闭会话、读取工程与 capability、用 `sessionId + expectedRevision` 执行事务、保存或物化，并继续使用其 revision 与错误 envelope。Maker 只增加高层任务工具：

| 工具 | 结果 |
|---|---|
| `open_session_preview` | 为 Backend 会话的指定 revision 创建 Viewer 预览，返回 Viewer URL |
| `publish_artifact` | 发布已保存的 Backend 会话并导入为 Artifact，返回 artifactId、playerUrl 和 `browserRequired`（仅完整模式） |
| `list_viewer_components` | 列出 Viewer 工程、稳定入口和 package/component ID |
| `render_component_preview` | 在 Viewer 渲染工程组件，可同时返回 PNG |
| `inspect_project_assets` | 返回固定 revision 的资源健康摘要，或指定资源的 incoming/outgoing 引用和问题 |
| `list_artifact_components` | 分页列出 Artifact 摘要；指定 artifactId 后分页读取 package/component |
| `open_artifact_player` | 返回 Player URL 和当前 render session（若页面已打开） |
| `render_artifact_component` | 在 Player 通过原生 `UIPackage` 渲染组件，可同时返回 PNG |
| `update_render_session` | 应用白名单 operation，返回新版本或版本冲突 |
| `set_render_view` | 按 expectedViewStateVersion 修改 zoom/background/width/height |
| `get_render_observation` | 返回对象树、控件状态和 Controller page |
| `capture_render_screenshot` | 返回实际捕获时的双版本、元数据和 MCP `image/png` |
| `run_ui_scenario` | 串联白名单操作、断言、条件等待和一次 PNG，返回逐步结果与失败定位 |
| `save_visual_baseline` / `compare_visual_baseline` / `list_visual_baselines` | 管理视觉基线，见[视觉基线](#视觉基线) |

工程态工具返回 `projectId`、稳定 package/component ID 和 Viewer URL；发布态工具返回 `artifactId` 和 Player URL；都不把整个工程或全部发布资源编码进单次响应。`inspect_project_assets` 和 `list_artifact_components` 接受 `limit: 1–500`（默认 100）与 `cursor`，带上一页 `nextCursor` 继续直到 `null`；快照或查询条件变化返回 `cursor_invalid_or_stale`。Artifact 游标也绑定来源声明和完整目录；同一包可出现在多页，按 packageId 合并，catalog total 按组件计数，空包占一项。

没有自定义 MCP resource：Artifact manifest 和文件由鉴权 REST 提供，observation 随工具结果返回，截图直接作为 image content 返回。

## Asset Manager

`/asset-manager` 和 `/projects/:projectId/assets` 不使用图数据库：浏览器 Project Source Client 对固定 project revision 读取 UAM 和资源字节，计算引用与 SHA-256；Host 只接收经过 Zod 校验、不含句柄和字节的紧凑分析快照，revision 变化时旧快照立即失效。分析复用 Viewer 的依赖收集器，提供 incoming/outgoing 引用、删除前的影响信息、未使用资源、SHA-256 完全重复、同包路径和名称冲突。目前不开放删除、重命名、合并或引用重写。

- **可信度**：快照、REST 和 MCP 结果统一声明 `analysisOwner: "browser"`、`trust: "advisory"`；Host 校验结构、预算、稳定 ID、引用计数与 revision，但不重算哈希或担保结论，伪称 `host` / `verified` 会被拒绝。
- **`invalid-url`**：无法解析的 `ui://` 值保留来源路径和关联资源，不混入 missing 计数。目前只解析 8 位包 ID 加资源 ID 的形式；名称路径式 URL 属于尚未解析，不代表在原生 runtime 中非法。
- **`unreachable`**：从所有导出资源与项目 settings 出发，遍历跨包引用、Controller/Transition URL 和 branchItemIds，标记未到达的私有组件；私有循环不会漏报。不可达只针对已识别的静态引用，动态加载、外部引用和无法解析的 URL 不在证明范围内，不能据此判断安全删除。
- **限制**：ID 只接受 1–128 位 `[A-Za-z0-9_-]`，`packageId/resourceId` 恰有一个分隔符；最多 5,000 资源、50,000 引用，问题条数同上限。单资源查询对 issues、incoming、outgoing 同步翻页并返回 `issuesTotal` / `issuesTruncated`。问题摘要最多展示 20 个 resourceKeys，用 `{projectId, issueId, limit, cursor?}` 可完整分页读取；重新扫描后旧 issueId 返回 `issue_invalid_or_stale`。

Feature Route 使用 TanStack Router 的错误边界，单页渲染异常不影响其他功能和侧栏；设计导入页面按需加载。

## 视觉证据与基线

### 浏览器测试证据

`pnpm test:browser` 在真实 Chromium 中执行 Import → Viewer、Artifact → 原生 Player、Broker、交付重试、资源预算、Revision、保存授权和 iframe 隔离回归。比较复用 `src/visual-diff.ts` 的 `comparePixelData()`，PNG 编解码使用浏览器 Canvas。每次运行在独立的 `test-results/browser/run-*/` 保存证据，不进入 Git 或 npm 包：

```text
report.json              环境、分场景结果、失败原因、分类后的浏览器诊断
viewer/{reference,actual,diff}.png、viewer/{threshold,report}.json
player/{reference,actual,diff}.png、player/{threshold,report}.json
failure-page-*.png        失败时仍可读取的页面截图
```

视觉报告绑定模式、来源 ID/revision（Player 为完整 digest）、package/component ID、renderSessionId、双版本、实际 view 和两张 PNG 的 SHA-256；任何像素超限或尺寸变化都失败。浏览器上下文固定 1280×720、DPR=1、en-US、UTC，Golden 视图为 482×446；合成图形使用固定 SwiftShader。Viewer 图形基线来自真实 `basic-shapes.fig`；Player 图形基线来自本地构造并由 Core 发布的 `Smoke.fui`（`SMOKE001/OTHER001` 的原生矩形与圆形）。设计源导入另有[语义 Golden](./design-import.md#测试与基线)。跨操作系统或浏览器升级需审查实际差异，不能靠扩大阈值消除失败。

所有页面和 iframe 采集 `pageerror`、`console.error/warning`、`requestfailed`、HTTP 4xx/5xx 和 `securitypolicyviolation`；未预期的诊断或诊断数量溢出阻断测试，预期的故障探针按场景归类并在报告中留存原因。报告不收集请求体、Cookie、Authorization、存储或 DOM，文本脱敏 token 和临时路径，失败截图遮盖 password 输入，不启用原始 Playwright trace/HAR。烟测先自检证据门禁：故意改变一个像素并触发六类诊断，确认门禁拒绝；该目录标记 `purpose: intentional gate self-test`、`expectedFailure: true`。

Draft 的 Visual Evidence 保存 `renderState` 双版本，旧 v1 报告可读但标注没有状态版本；它不是签名证据，版本描述语义操作，不代表动画或 hover 的每一帧。更新 Golden 的规则见 [CONTRIBUTING](../CONTRIBUTING.md)。

### 视觉基线

视觉基线由 Agent 管理：Host 经 Broker 截图，在服务端用 `sharp` 解码 PNG，沿用 `comparePixelData` 和同一组指标，不设全局通过线。结果包含差异指标、`identical`、`withinTolerance`、环境差异字段和差异 PNG。`withinTolerance` 默认要求像素完全一致，单次调用可放宽 `maxDifferentPixels` / `maxMeanAbsoluteError`，尺寸不同始终不通过。每个基线记录渲染环境（runtime profile、Viewer/Player、渲染页的 User-Agent、zoom/background/视口和图片尺寸），比对时列出与基线不同的字段，供 Agent 区分环境变化和界面回归。

数据存于 `<data-dir>/visual-baselines/<suite>/<key>`：图片先于 `baseline.json` 原子写入；已有基线只能以 `replace: true` 加原因替换，保留最近 5 个旧版本；最近一次比对报告与差异图一并保存。`suite`/`key` 只接受字母数字及 `._-`，key 最多 4 段。基线不写工程，完整模式和 `view` 模式都可用；不同机器、浏览器或字体会造成像素差异，应在同一环境建立和比对。

## 技术栈

| 层 | 选择 |
|---|---|
| 运行环境 | Node.js `>=22.18`、pnpm；前后端 TypeScript strict |
| 服务端 | Vite 输出 `dist/server/index.js`（`tsx` 只用于开发和测试）；Hono + `@hono/node-server`；Pino 日志；Zod + `@hono/zod-validator` |
| MCP | `@modelcontextprotocol/sdk` + `@openfairygui/mcp`，Web Standard Streamable HTTP transport |
| WebUI | React 19、Vite 8、TanStack Router/Query/Table/Virtual、shadcn/ui（Radix）、`react-resizable-panels`、Tailwind CSS 4 |
| 渲染 runtime | 隔离 iframe + 冻结的 LayaAir 3.3.10/FairyGUI Web |
| 通信 | REST + HTTP 长轮询；iframe 内 MessageChannel |
| 持久化 | Host 内存会话 + 浏览器 IndexedDB 目录句柄 + data dir 中的 Artifact、Draft 与视觉基线文件 |
| 测试 | `node:test`；Playwright Chromium 浏览器烟测与像素 Golden |

Hono 的 Node adapter 直接承载 Web Standard `Request/Response`，MCP SDK 的 transport 无需再包一层（[Hono Node.js](https://hono.dev/docs/getting-started/nodejs)）。Node 原生类型擦除会忽略 `tsconfig.json` 且不支持需要转换的语法，因此使用 `tsx`（[Node.js TypeScript](https://nodejs.org/api/typescript.html)）。Playwright 截图受操作系统、浏览器、字体和硬件影响，视觉回归必须固定运行环境（[Playwright visual comparisons](https://playwright.dev/docs/test-snapshots)）。

暂不引入：SSR 框架、Redux/Zustand、MUI/Ant Design、GraphQL、WebSocket、数据库和图可视化库。分别在出现服务端渲染需求、复杂客户端写状态、大量企业组件、组合查询膨胀、实测轮询不足、跨重启任务历史或多用户并发、以及用户明确需要大型交互图时再考虑。

## 测试入口

`pnpm test` 运行全部单元测试，`pnpm test:browser` 运行浏览器烟测，`pnpm test:memory` 运行 Node 内存门禁；如何运行与更新 Golden 见 [CONTRIBUTING](../CONTRIBUTING.md)。

| 范围 | 单元测试（`test/`） | 浏览器烟测（`scripts/`） |
|---|---|---|
| Host、MCP、REST | `server`、`host-lifecycle`、`mcp-request-id` | `workbench-routes-smoke`、`headless-smoke` |
| 上传与 Artifact | `uploads`、`artifacts` | `browser-smoke`；安装包烟测 `release-smoke.mjs` |
| 运行时预算与内存 | `runtime-budget`、`memory-boundaries` | `runtime-budget-smoke`；`memory-stress` |
| 交付与 renderer 生命周期 | `renderer-delivery`、`renderer-frame` | `renderer-delivery-smoke` |
| Broker 版本 | `broker-state` | `broker-state-smoke` |
| 快照、revision 与 Asset Manager | `project-snapshot`、`project-revision`、`viewer-scene`、`viewer-pagination` | `project-revision-smoke`、`gear-default-smoke` |
| 会话预览与发布 | `session-preview`、`backend-files`、`publish` | `session-preview-smoke`、`publish-smoke` |
| 保存授权 | `save-grants` | `save-grant-smoke` |
| iframe 隔离 | `runtime-isolation` | `runtime-isolation-smoke` |
| UI 场景 | `ui-scenario` | `ui-scenario-smoke` |
| 视觉证据与基线 | `browser-evidence`、`visual-baselines`、`web/visual-evidence` | `browser-evidence-smoke` |

## 限制与非目标

- 不复制或分叉 OpenFairyGUI 的 UAM、事务和发布实现；不把受限 restore 当作常规编辑流程；不建立第二套插件系统。
- 只支持一种 runtime profile；Unity、LayaBox、Cocos Creator、游戏业务脚本、自定义宿主扩展和完整像素一致性不在 `0.1.x` 范围内。
- 浏览器基线为当前稳定版 Chrome 和 Edge，自动门禁使用 Chromium；交互式目录授权依赖 File System Access API，Firefox 与 Safari 不在支持范围。
- 没有远程部署、stdio、守护进程、WebSocket 或数据库；增加远程模式前必须另行设计身份认证、授权、限流和租户隔离。
- render session、截图和保存授权都只在 Host 内存，不跨重启；没有持久 `ScreenshotRef`。
- 一个 data dir 只能由一个 Host 写入；文件提交不保证跨平台断电原子性。
- iframe 隔离和保存授权不是操作系统沙箱；Workbench 自身的 XSS 不因此获得隔离。

## 参考资料

- [Model Context Protocol：Transports](https://modelcontextprotocol.io/specification/draft/basic/transports)
- [Model Context Protocol：Tools](https://modelcontextprotocol.io/specification/draft/server/tools)
- [MCP TypeScript SDK：Server Guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/server.md)
- [OpenFairyGUI](https://github.com/OpenFairyGUI/OpenFairyGUI)
