# FairyGUI Maker

> 面向 AI Agent 的 FairyGUI 本地工作台：检查与编辑工程、预览未发布 UI、分析资源，并验证真实发布产物。

FairyGUI Maker 建立在 [OpenFairyGUI](https://github.com/OpenFairyGUI/OpenFairyGUI) 之上。OpenFairyGUI 提供工程读写、UAM、事务、二进制协议和 backend runtime；Maker 将这些底层能力组合为一个本地 Host、Streamable HTTP MCP、浏览器 Workbench、CLI 和可复用 Agent Skill。

FairyGUI Maker 不是另一个完整编辑器，也不是 FairyGUI 官方产品。“FairyGUI”名称、Logo 及相关品牌标识的权利归其权利人所有；官方产品与信息请访问 [FairyGUI 官网](https://fairygui.com/)。

## FairyGUI Maker 是什么

Maker 让人和 Agent 使用同一组稳定 ID、revision 与 render session 协作，适合：

- 让 Agent 检查、修改并按明确授权保存 `.fairy` 工程。
- 在发布前通过 Viewer 预览当前工程组件，而不生成 `.fui`。
- 查询工程资源引用、断链、未使用、完全重复与名称冲突。
- 通过 Player 加载真实 `.fui` / `_fui.bytes` 发布目录，验证原生运行时表现。
- 获取结构化对象树、控件状态、Controller、Transition、交互记录和 Canvas PNG 证据。

## 选择正确的工作流

| 目标 | 使用入口 | 持久化边界 |
|---|---|---|
| 检查、编辑或保存工程 | OpenFairyGUI backend session | save 需要显式 revision 与一次性 Host Save Grant |
| 预览尚未发布的组件 | Viewer | 只修改 render session 内存，不写工程 |
| 检查资源健康度 | Asset Manager | 固定 source revision 的只读分析 |
| 验证发布目录 | Player | Artifact 不可变，操作只影响 render session |

Viewer 不能作为发布结果的证明；最终 `.fui` 行为应在 Player 中验证。

## 主要能力

| 能力 | 说明 |
|---|---|
| Maker Host | 单个 Node.js 进程提供 Workbench、REST API 和 Streamable HTTP MCP |
| 工程会话 | 复用 OpenFairyGUI capability、revision、UAM transaction 与 save 契约 |
| Viewer | 从原始工程构建最小 `ViewerScene` 依赖闭包并在隔离 iframe 中预览 |
| Asset Manager | 按固定 revision 查询引用关系、断链、未使用、重复和名称冲突 |
| Artifact Store | 校验并按 digest 固化真实发布目录，不引入数据库 |
| Player | 使用 LayaAir 3.3.10/FairyGUI 原生 `UIPackage` 加载 `.fui` / `_fui.bytes` |
| Agent 数据通道 | 语义操作、结构化 observation、人工交互上报和 MCP `image/png` 截图 |
| Agent Skills | 同仓库维护通用 Skill，并通过轻量包装兼容 Claude |

## 快速开始

使用 npm 包只需要 Node.js `>=22.18`：

```powershell
$env:FAIRYGUI_MAKER_TOKEN = "replace-with-at-least-24-characters"
npx fairygui-maker@0.1.0
```

服务默认监听 `127.0.0.1:3847`。终端会输出：

- Maker Workbench URL。
- MCP endpoint：`http://127.0.0.1:3847/mcp`。

令牌由 Host 自动生成时，仅在交互终端中输出一次带令牌的 Workbench URL。通过环境变量固定令牌时，打开 `http://127.0.0.1:3847/?token=<令牌>` 完成一次浏览器授权；Host 会写入仅限本机的 HttpOnly Cookie，并从地址栏移除令牌参数。

修改端口：

```powershell
npx fairygui-maker@0.1.0 --port 3900
```

把 Artifact 与运行状态放到明确的私有目录：

```powershell
npx fairygui-maker@0.1.0 --data-dir E:\FairyGUI\maker-data
```

相对 `--data-dir` 以启动命令的当前目录为基准；未传入时默认使用当前目录下的 `.fairygui-maker`。环境变量 `FAIRYGUI_MAKER_DATA_DIR` 提供相同能力，CLI 参数优先。

在完整模式下，OpenFairyGUI backend 只能访问启动命令当前目录及其子目录。请先进入用户明确授权的工程父目录再启动 Host；不要从磁盘根目录或包含无关工程的宽泛目录启动。

### 保存确认（Host Save Grant）

Agent 的 `save_session` / `materialize_session` 必须携带 `expectedRevision`。首次调用返回 `save_approval_required`，不写盘；所有者在 Dashboard 的 **Host Save Grant** 卡片核对会话、revision、目标和选项，输入独立的确认密钥并批准后，Agent 才能用相同参数重试一次。

完整 Host 在本地交互终端单独显示随机确认密钥；它不是 `FAIRYGUI_MAKER_TOKEN`，不要交给 Agent。非交互启动时，所有者须另行设置 `FAIRYGUI_MAKER_APPROVAL_TOKEN`（24–256 字符，必须与 MCP token 不同），该值不会输出到日志；没有配置则保存保持阻断。不要把确认密钥放入 MCP 客户端环境、仓库配置或启动 URL。

每个请求从创建起 5 分钟内有效，批准后最多尝试执行一次，失败或响应丢失也会消耗授权。修改 revision/选项、关闭会话、撤销或重启 Host 后需重新确认。普通保存、force-save 和完整物化均受此约束；Viewer/Player 的只读绑定不会因此获得写权限。完整规则见 [Host Save Grant](./docs/workbench.md#210-host-save-grant批次-15)。

## Agent 与 MCP

Viewer/Player 使用不透明源 iframe：不能访问 Workbench DOM、Cookie、目录句柄或 Host API；资源由父页面校验后通过一次性 nonce 绑定的 MessageChannel 传入。主动上传的 HTML/SVG/JS 只作为文件下载。完整边界与限制见 [Iframe 隔离](./docs/workbench.md#211-iframe-隔离批次-16)。

MCP 客户端连接 `/mcp` 时需要发送：

```text
Authorization: Bearer <启动令牌>
```

Maker 对外只提供一个 Streamable HTTP MCP 服务。客户端应将令牌放在私密环境变量中，不要把令牌写进仓库配置。常用高层工具为：

| 工作流 | 工具 |
|---|---|
| Viewer 发现与渲染 | `list_viewer_components`、`render_component_preview` |
| Player 发现与渲染 | `list_artifact_components`、`open_artifact_player`、`render_artifact_component` |
| Render session | `update_render_session`、`set_render_view`、`get_render_observation`、`capture_render_screenshot` |
| 资源分析 | `inspect_project_assets` |

完整模式中的工程读写继续使用同一 MCP 服务内的 OpenFairyGUI backend tools。`view <project-path>` 模式只注册 Maker 的 Viewer、Player、资源分析与 render-session 工具，不提供任何 backend 工程写工具。Agent 应始终使用工具返回的项目、包、组件、对象、session、revision 和 state-version ID，不应从显示名称猜测。

### Codex

在用户级 `~/.codex/config.toml`，或已信任项目的 `.codex/config.toml` 中加入：

```toml
[mcp_servers.fairygui_maker]
url = "http://127.0.0.1:3847/mcp"
bearer_token_env_var = "FAIRYGUI_MAKER_TOKEN"
required = true
tool_timeout_sec = 60
```

Codex Desktop、CLI 与 IDE 扩展共享这份配置；启动 Maker 后用 `/mcp` 确认连接。配置字段以 [Codex MCP 官方文档](https://developers.openai.com/codex/mcp/) 为准。

### Claude Code

使用本地 scope，避免把展开后的令牌写入仓库级 `.mcp.json`：

```powershell
claude mcp add --transport http --scope local fairygui-maker http://127.0.0.1:3847/mcp --header "Authorization: Bearer $env:FAIRYGUI_MAKER_TOKEN"
claude mcp get fairygui-maker
```

令牌改变后先执行 `claude mcp remove fairygui-maker`，再重新添加。HTTP transport、header 和 scope 语义见 [Claude Code MCP 官方文档](https://docs.anthropic.com/en/docs/claude-code/mcp)。

仓库内置使用指南：

- 通用/Codex：[`.agents/skills/use-fairygui-maker/SKILL.md`](./.agents/skills/use-fairygui-maker/SKILL.md)
- Claude：[`.claude/skills/use-fairygui-maker/SKILL.md`](./.claude/skills/use-fairygui-maker/SKILL.md)

Claude 文件只负责转到同一份通用 Skill，避免两套指南漂移。

## 设计源导入

CLI 可以把 `.fig`、`.psd` 或 [Maker Import Bundle v1](./docs/maker-import-bundle-v1.md) 目录转换成新的 FairyGUI 工程目录：

```powershell
fairygui-maker import E:\Design\hud.fig --out E:\Projects\hud-imported
fairygui-maker import inspect E:\Design\hud.fig
fairygui-maker import plan E:\Design\hud.fig --out E:\Design\hud-plan.json
fairygui-maker import E:\Design\hud.fig --dry-run
fairygui-maker reimport E:\Projects\hud-imported --dry-run
fairygui-maker view E:\Projects\hud-imported
```

所有导入都会先把源复制到 `--data-dir/import-drafts/<draftId>`，再依次保存 Source IR、BuildPlan、UAM 和 Draft 工程。`inspect` 不编译，`plan` 只额外写入指定的计划 JSON，`import --dry-run` 只编译 Draft；只有普通 `import --out` 会在校验完成后物化目标目录。`--out` 目录必须尚不存在，Maker 通过同盘临时目录和原子改名避免覆盖或留下半成品，并在工程目录写入 State v2 与不可变生成快照。Draft 带 revision，可在 Host 重启后恢复；七天未更新的 Draft 会在下次启动时清理。

BuildPlan v2 绑定源结构、图片和 Binding 摘要及 Planner/Compiler 版本；首次导入 ID 确定性生成，重导入优先保留旧 ID，Plan 无法删除源诊断。同一输入和固定版本可复现生成文件；旧 Plan 需在 Workbench 点击“重新生成 Build Plan”。身份范围与兼容边界见 [批次 18](docs/workbench.md#213-确定性-plannercompiler批次-18)。

`reimport <project> --dry-run` 会重新读取本地源文件并执行三方比较，只输出 `added`、`changed`、`removed`、`preserved`、`conflict`，不会修改 FairyGUI 工程。上传型 Workbench 导入没有稳定的本地源路径，因此当前批次不提供 CLI 重导入；`--apply` 会在 Backend Transaction 版本中另行实现。

Host 同时提供带 bearer token 保护的 `/api/import-drafts` 创建、列表、详情、删除、`parse`、`plan`、`compile` 和 `materialize` 接口。所有变更请求都必须提交当前 `expectedRevision`；`view <project-path>` 只读模式禁用这些接口。编译后的 Draft 还可上传一张 PNG Reference Image，从同页 Viewer 捕获结果，并持久化 Reference、Capture、Pixel Diff 与原始像素指标；Workbench 提供透明度叠加、并排和热图视图，不设置跨字体、平台或 rasterizer 的全局相似度通过线。

浏览器上传尚未完成的 Draft 和 Artifact Import 单独采用 30 分钟空闲有效期；每次成功上传文件续期。Host 按实际流量限制请求体，二进制先写 `.part`、校验后原子改名；Artifact manifest 必须为每个文件声明 SHA-256，同尺寸不同内容重试返回 `409`。JSON、视觉证据、并发、容量与取消接口见 [有界上传管线](./docs/workbench.md#25-有界上传管线批次-10)。

Artifact 同内容只存一份字节，每次导入独立保留名称、来源和时间；完成请求跨重启幂等，列表显示最近一次来源和导入次数。文件读取时重新校验实际字节，篡改或链接替换返回 `409`。旧 manifest 只读兼容；备份应包含整个 data dir，且一个 data dir 只能由一个 Host 写入。格式与历史/分页 API 见 [Artifact 持久化语义](./docs/workbench.md#212-artifact-持久化语义批次-17)。

## CLI 只读预览

Agent、批处理和视觉回归可以显式授权一个工程根目录：

```powershell
npx fairygui-maker@0.1.0 view E:\Projects\MyFairyGUIProject

# 全局安装后也可以使用：
fairygui-maker view E:\Projects\MyFairyGUIProject
```

`view` 只扫描指定目录，在 Host 启动时创建不可变的只读内存快照。它不会寻找其他工程、跟随符号链接、打开写接口或自动读取浏览器目录授权。修改源文件后需要重启 Host 才能生成新快照。

交互模式则由用户在 Dashboard 中通过系统目录选择器授权只读访问；目录句柄保存在同源浏览器的 IndexedDB 中，不传给 Agent 或 runtime iframe。

浏览器与 CLI 统一按实际工程依赖读取快照，不读取目录中的无关文件；隐藏路径（含 `.env`、`.git`、Maker state）、私钥与常见构建目录默认排除。`sourceRevision` 使用排序后的文件内容 SHA-256，而非大小/修改时间。浏览器 Viewer 刷新与 Asset Manager 重扫先校验 Host 旧 revision，成功后失效旧 Renderer 与分析；CLI 快照仍需重启 Host 更新。Dashboard 可移除项目和清理过期未注册授权，均不删除源文件。扫描预算与完整接口见 [Revision 与快照隐私](./docs/workbench.md#29-revision-与快照隐私批次-14)。

## Workbench 入口

| 路径 | 用途 |
|---|---|
| `/` | Dashboard 与项目/Artifact 入口 |
| `/viewer` | Viewer 项目选择 |
| `/projects/:projectId/viewer` | 指定工程的 Viewer |
| `/asset-manager` | Asset Manager 项目选择 |
| `/projects/:projectId/assets` | 指定工程的资源分析 |
| `/player` | Player 与发布目录导入 |
| `/artifacts/:artifactId/player` | 指定 Artifact 的 Player |
| `/mcp` | Streamable HTTP MCP |

## 当前状态与边界

- Host 只绑定 `127.0.0.1`，并校验 Host、Origin 和访问令牌。
- 同一 Host 最多保留 32 个 MCP session；客户端应正常发送 MCP `DELETE` 关闭不再使用的 session。
- Host 强制执行一次性保存授权；仅持有 MCP token 或普通 Workbench Cookie 不能批准保存。授权状态仅存内存，最多保留 128 条记录。
- Viewer 使用原始工程 UAM；Player 只消费固定 Artifact，两条渲染链路不会互相降级。
- Viewer 和 Player 都只接受白名单语义操作，不执行任意 JavaScript、表达式或业务 JSON。
- Workbench 与 Agent 共用 Broker；语义状态和 zoom/background/viewport 分别计版本，截图记录实际捕获的双版本。`stateVersion` 保留为语义版本别名，详见[统一 Broker 状态](./docs/workbench.md#28-统一-broker-状态批次-13)。
- 每个 render session 最多保留最近 256 个 request ID 用于安全重试；更早的已完成请求可能被淘汰。
- 普通 Viewer/Player 截图直接作为 MCP `image/png` 返回，不持久化 ScreenshotRef；Import Draft 的 Visual Evidence 是独立、带 revision 的审查记录。
- 当前不包含远程部署、守护进程、WebSocket、自动 `publishBrowser` 或 `run_ui_scenario`。
- Player 验证发布包内的原生 FairyGUI 行为，不加载游戏项目的业务脚本、网络层或宿主逻辑。

## 兼容范围

| 项目 | `0.1.x` 基线 |
|---|---|
| Node.js | `>=22.18`；CI 覆盖 Node 22 与 24 |
| OpenFairyGUI | `@openfairygui/core/backend/mcp` `0.3.1` |
| MCP | Streamable HTTP；Viewer protocol v6 |
| Viewer / Player runtime | 冻结的 LayaAir 3.3.10 + FairyGUI Web runtime |
| 浏览器 | 当前稳定版 Chrome 与 Edge；自动门禁使用 Chromium |

交互式工程授权依赖 File System Access API，Firefox 与 Safari 未列入首个 RC 支持范围。Viewer 只解释 UAM 已表达的 Web UI 语义；Unity、Cocos Creator、游戏业务脚本、自定义宿主扩展和完整像素一致性不在 `0.1.x` 承诺内。

## 本地开发

从源码开发需要 pnpm `10.14.0`：

```powershell
pnpm install --frozen-lockfile
pnpm build
pnpm test
```

`pnpm build` 执行 TypeScript 检查，并分别构建 React Workbench 与可直接由 Node.js 运行的 Host。完整导入、runtime 隔离与预览使用构建后的 Host 页面（默认端口 3847）；修改构建后重启 Host，以更新静态文件白名单：

```powershell
pnpm dev:host
```

`pnpm dev:web` 仅用于可信源码的前端 UI 调试，不代替 Host 的安全响应头和隔离预览验收。

完整发布门禁还会安装真实 npm tarball 并启动其中的 CLI，以及在 Chromium 中验证 Viewer/Player 像素 Golden、Import Draft Visual Evidence 与交付/隔离故障回归：

```powershell
pnpm exec playwright install --no-shell chromium
pnpm verify:release
```

每次浏览器测试在 `test-results/browser/run-*/` 留存 reference/actual/diff、阈值、来源/组件/Broker 版本和诊断报告；CI 成败均上传并保留 14 天。未预期 Console/CSP/网络错误阻断测试。Viewer 的真实 FIG 与 Player 的原生图形分别使用固定尺寸、独立零差异阈值，不覆盖系统字体保真。详见[批次 19：证据闭环](./docs/workbench.md#214-视觉与故障证据闭环批次-19)。

仅当渲染变化符合预期时显式生成新基线；CI 禁止该开关，功能或诊断检查失败不会写回 Golden。更新后审查图片并关闭开关重跑：

```powershell
$env:UPDATE_VISUAL_GOLDENS = "1"
pnpm test:browser
Remove-Item Env:UPDATE_VISUAL_GOLDENS
pnpm test:browser
```

Artifact Store 启动时会重新校验 manifest、文件大小、SHA-256、整体 digest 和包目录；不一致的 Artifact 保留在磁盘但不会载入。中断遗留的 `imports/import_<uuid>` 临时目录会在下次启动时清理。

## 升级与卸载

建议 Agent 和 CI 固定精确版本，并在验证后显式升级：

```powershell
npx -y fairygui-maker@0.1.0 --version
npm install --global fairygui-maker@0.1.0
npm uninstall --global fairygui-maker
```

`npx` 使用者没有全局包需要卸载。卸载不会删除 `--data-dir` 或 `.fairygui-maker`；确认不再需要其中的 Artifact 后再由用户手动删除该目录。

## 发布 npm 包

FairyGUI Maker 自身采用 [MIT License](./LICENSE)，公开仓库为 [OpenFairyGUI/FairyGUI-Maker](https://github.com/OpenFairyGUI/FairyGUI-Maker)。npm 包名为无 scope 的 `fairygui-maker`，发布者登录有权发布该包的 npm 账号后执行：

```powershell
pnpm install --frozen-lockfile
pnpm verify:release
npm publish --access public
```

GitHub CI 会在 Windows/Linux 与 Node.js 22/24 上执行构建和单元测试，并在 Linux Chromium 中运行同一套发布门禁。发布工作流只响应人工发布的 `v<package-version>` GitHub Release，并使用 npm Trusted Publishing；npm 会自动生成 provenance。

首次发布前需确认 `fairygui-maker` 名称仍然可用。首次 GitHub Release 需要发布者临时配置可发布该包的 granular `NPM_TOKEN` repository secret。首次发布成功后，在 npm package settings 中把 `OpenFairyGUI/FairyGUI-Maker` 和 `release.yml` 配置为允许 `npm publish` 的 trusted publisher，并删除该 secret；后续发布由 OIDC 认证，不再保存长期 npm token。

## 文档

- [产品定位与技术架构](./docs/architecture.md)
- [Maker Workbench、Viewer、Player 与 render session 协议](./docs/workbench.md)
- [第三方运行时与补充声明](./THIRD_PARTY_NOTICES.md)；生产构建还会生成并发行 `dist/web/THIRD_PARTY_LICENSES.md`
- [MIT License](./LICENSE)
- [OpenFairyGUI](https://github.com/OpenFairyGUI/OpenFairyGUI)
