# FairyGUI Maker

> 面向 AI Agent 的 FairyGUI 本地工作台：检查与编辑工程、预览未发布 UI、分析资源，并验证真实发布产物。

> [!WARNING]
> **项目处于开发初期，暂不能用于实际项目开发或生产环境。** 当前仅供实验评估、原型验证与参与项目开发。功能完整性、兼容性和工作流仍在验证中，接口及数据格式可能调整；请仅使用测试工程或已备份的副本试用。下文介绍的能力、示例和测试结果不代表项目已达到实际开发可用标准。

FairyGUI Maker 建立在 [OpenFairyGUI](https://github.com/OpenFairyGUI/OpenFairyGUI) 之上。OpenFairyGUI 提供工程读写、UAM、事务、二进制协议和 backend runtime；Maker 将这些底层能力组合为一个本地 Host、Streamable HTTP MCP、浏览器 Workbench、CLI 和可复用 Agent Skill。

FairyGUI Maker 不是另一个完整编辑器，也不是 FairyGUI 官方产品。“FairyGUI”名称、Logo 及相关品牌标识的权利归其权利人所有；官方产品与信息请访问 [FairyGUI 官网](https://fairygui.com/)。

## 它能做什么

当前主线是「Agent 修改 → 保存 → 自动发布 → Player 验收」，在这条路径成熟前，其他方向只维持现状。人和 Agent 使用同一组稳定 ID、revision 与 render session 协作：

| 目标 | 使用入口 | 持久化边界 |
|---|---|---|
| 检查、编辑或保存工程 | OpenFairyGUI backend 会话 | 保存需要显式 revision 和所有者授权 |
| 发布已保存工程并验收 | `publish_artifact` → Player | 只写 Maker 私有数据目录，不写工程 |
| 预览尚未发布的组件 | Viewer | 只修改 render session 内存，不生成 `.fui` |
| 检查资源健康度 | Asset Manager | 固定 revision 的只读分析，仅供参考 |
| 验证已有发布目录 | Player | Artifact 不可变，操作只影响 render session |

Viewer 不能作为发布结果的证明；最终 `.fui` 行为应在 Player 中验证。Agent 还能获取结构化对象树、控件状态、Controller、Transition、交互记录和 Canvas PNG，并管理自己的视觉基线。

## 快速开始

以下步骤仅供本地实验评估，请使用独立的测试目录和工程副本。npm 包名为 `@openfairygui/fairygui-maker`，CLI 命令为 `fairygui-maker`，需要 Node.js `>=22.18`。从源码启动见 [CONTRIBUTING](./CONTRIBUTING.md#本地开发)。

```powershell
$env:FAIRYGUI_MAKER_TOKEN = "replace-with-at-least-24-characters"
npx @openfairygui/fairygui-maker@0.1.2
```

服务默认监听 `127.0.0.1:3847`，终端输出 Workbench URL 和 MCP endpoint `http://127.0.0.1:3847/mcp`。令牌由 Host 自动生成时，只在交互终端输出一次带令牌的 Workbench URL；固定令牌时打开 `http://127.0.0.1:3847/?token=<令牌>` 完成一次浏览器授权，Host 写入仅限本机的 HttpOnly Cookie 并从地址栏移除令牌。

常用参数：

```powershell
npx @openfairygui/fairygui-maker@0.1.2 --port 3900
npx @openfairygui/fairygui-maker@0.1.2 --data-dir E:\FairyGUI\maker-data   # 也可用 FAIRYGUI_MAKER_DATA_DIR
npx @openfairygui/fairygui-maker@0.1.2 --headless-browser msedge         # chrome、msedge，或先 npx playwright install chromium 再用 chromium
npx @openfairygui/fairygui-maker@0.1.2 --no-headless
npx @openfairygui/fairygui-maker@0.1.2 view E:\Projects\MyFairyGUIProject  # 只读预览模式
```

- **工作目录**：完整模式下 backend 只能访问启动目录及其子目录。请先进入用户明确授权的工程父目录再启动，不要从磁盘根目录或包含无关工程的目录启动。数据目录默认是启动目录下的 `.fairygui-maker`，backend 会排除它及包含它的工程；如果工程本身就是启动目录，请用 `--data-dir` 指定工程外的目录。
- **无头渲染**：没有打开的 Workbench 页面时，Host 用本机已安装的 Chrome 或 Edge（不会下载浏览器）加载 Viewer / Player，Agent 无需有人开着浏览器就能渲染和截图。在 Dashboard 中通过浏览器授权的工程只能由该浏览器读取，仍返回 `browser_required`。
- **`view` 模式**：启动时为指定目录创建不可变的只读快照，不注册任何工程写工具；修改源文件后需要重启 Host。

## 连接 Agent

Maker 只提供一个 Streamable HTTP MCP 服务，客户端连接 `/mcp` 时发送 `Authorization: Bearer <启动令牌>`。把令牌放在私密环境变量中，不要写进仓库配置。

**Codex**：在 `~/.codex/config.toml` 或已信任项目的 `.codex/config.toml` 中加入下面的配置，启动 Maker 后用 `/mcp` 确认连接（字段以 [Codex MCP 文档](https://developers.openai.com/codex/mcp/) 为准）：

```toml
[mcp_servers.fairygui_maker]
url = "http://127.0.0.1:3847/mcp"
bearer_token_env_var = "FAIRYGUI_MAKER_TOKEN"
required = true
tool_timeout_sec = 60
```

**Claude Code**：使用本地 scope，避免把展开后的令牌写入仓库级 `.mcp.json`；令牌改变后先 `claude mcp remove fairygui-maker` 再重新添加（见 [Claude Code MCP 文档](https://docs.anthropic.com/en/docs/claude-code/mcp)）：

```powershell
claude mcp add --transport http --scope local fairygui-maker http://127.0.0.1:3847/mcp --header "Authorization: Bearer $env:FAIRYGUI_MAKER_TOKEN"
```

完整模式中，工程读写使用同一 MCP 服务内的 OpenFairyGUI backend 工具，Maker 补充以下高层工具：

| 工作流 | 工具 |
|---|---|
| Backend 未保存预览 | `open_session_preview` |
| 发布已保存会话 | `publish_artifact` |
| Viewer 发现与渲染 | `list_viewer_components`、`render_component_preview` |
| Player 发现与渲染 | `list_artifact_components`、`open_artifact_player`、`render_artifact_component` |
| Render session | `update_render_session`、`set_render_view`、`get_render_observation`、`capture_render_screenshot`、`run_ui_scenario` |
| 资源分析 | `inspect_project_assets` |
| 视觉回归 | `save_visual_baseline`、`compare_visual_baseline`、`list_visual_baselines` |

Agent 应始终使用工具返回的项目、包、组件、对象、session、revision 和版本 ID，不从显示名称猜测。MCP 会话空闲 30 分钟后回收，过期 ID 返回 `404 / mcp_session_not_found`，需要重新 initialize，不要自动重放可能已执行的写操作。工具契约、会话上限和协议细节见[架构](./docs/architecture.md)。

## 保存授权

`save_session` / `materialize_session` 必须携带 `expectedRevision`。没有权限时返回 `save_approval_required`，不写盘；所有者在 Dashboard 的 **工程保存权限** 卡片验证一次身份，再选择“批准一次保存”或“允许本次会话连续保存”，Agent 随后用原参数重试。会话授权只覆盖当前 Backend 会话向原工程的普通保存，关闭会话或重启 Host 后失效。`force: true`、显式 `targetPath`、`materializeCleanSession` 和 `materialize_session` 始终单次确认。

确认密钥只在 Host 的交互终端单独显示，它不是 `FAIRYGUI_MAKER_TOKEN`，不要交给 Agent，也不要放进 MCP 客户端环境、仓库配置或 URL。非交互启动时，所有者须另行设置 `FAIRYGUI_MAKER_APPROVAL_TOKEN`（24–256 字符，必须与 MCP token 不同），否则保存保持阻断。

无人值守时，所有者可以在启动时预授权指定工程的普通保存（可重复，只在本次进程有效，MCP 客户端无法授予）：

```powershell
npx @openfairygui/fairygui-maker@0.1.2 --allow-save E:\Projects\MyFairyGUIProject
```

完整规则见[保存授权](./docs/architecture.md#保存授权)。

## 在其他工程中使用 Skill

仓库内置的使用指南是 [`.agents/skills/use-fairygui-maker`](./.agents/skills/use-fairygui-maker/SKILL.md)；[Claude 版本](./.claude/skills/use-fairygui-maker/SKILL.md)只转到这份通用指南。制作或改版 UI 时，Skill 会按需读取 [UI 制作参考](./.agents/skills/use-fairygui-maker/references/ui-authoring.md)。

在目标工程安装已验证的 tarball 或确切 npm 版本后，复制包内的完整通用 Skill（Claude 工程把目标改为 `.claude/skills/use-fairygui-maker`，仍复制同一份通用 Skill，不要复制仓库内的 Claude wrapper）：

```powershell
$skillSource = Join-Path (npm root) "@openfairygui/fairygui-maker/.agents/skills/use-fairygui-maker"
$skillTarget = Join-Path (Get-Location) ".agents/skills/use-fairygui-maker"
if (Test-Path -LiteralPath $skillTarget) { throw "Skill already exists; review it before replacing" }
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $skillTarget) | Out-Null
Copy-Item -LiteralPath $skillSource -Destination $skillTarget -Recurse
```

源码用户可把 `$skillSource` 改为 checkout 中该目录的绝对路径。保留 `references/` 和 `agents/`。安装 Skill 不会启动 Host 或建立 MCP 连接（本地 import/reimport 不需要 MCP）；在目标工程重新开启 Agent 任务并显式调用 `$use-fairygui-maker`，先确认 Agent 发现了 Skill，再检查所需的 CLI 或 MCP。

## 设计源导入

> 设计源导入已冻结：保留现有功能和测试，只修复阻断性问题，不再增加新功能。

CLI 可以把 `.fig`、`.psd` 或 Maker Import Bundle v1 目录转换成新的 FairyGUI 工程，并在源变化后预览、批准重导入：

```powershell
fairygui-maker import E:\Design\hud.fig --out E:\Projects\hud-imported
fairygui-maker reimport E:\Projects\hud-imported --dry-run
fairygui-maker reimport E:\Projects\hud-imported --apply <上一步的planDigest>
```

Draft 流程、Bundle 与 fixture 格式、确定性规则、保真诊断和重导入的失败恢复见[设计源导入](./docs/design-import.md)。

## 当前状态与边界

- 项目整体仍处于开发初期，下列内容描述已接入的能力与限制，不构成完整性、稳定性或生产可用性承诺。
- 已接入 OpenFairyGUI `0.7.0`。事务后必须用 `query_entity` 等接口读回所改字段，不能只凭成功返回或 revision 变化证明结果；`read_session_state` 与 `read_resource_bytes` 提供绑定 revision 的模型和主资源字节。Backend 会关闭空闲 30 分钟且没有未保存修改的会话，之后需要重新打开工程。
- Host 只绑定 `127.0.0.1`，校验 Host、Origin 和访问令牌；Viewer / Player 运行在不透明源 iframe 中，拿不到 Workbench DOM、Cookie、目录句柄或 Host API。
- Viewer 和 Player 只接受白名单语义操作，不执行任意 JavaScript、表达式或业务 JSON；Player 不加载游戏项目的业务脚本、网络层或宿主逻辑。
- `publish_artifact` 只发布已保存且没有未保存修改的会话；保存之后在 Maker 之外对工程文件的改动不会被检测。
- render session、截图和保存授权只在 Host 内存，不跨重启；一个数据目录只能由一个 Host 写入。
- 没有远程部署、守护进程或 WebSocket。

## 兼容范围

| 项目 | `0.1.x` 基线 |
|---|---|
| Node.js | `>=22.18`；CI 覆盖 Node 22 与 24 |
| OpenFairyGUI | `@openfairygui/core/backend/functions/mcp` `0.7.0` |
| MCP | Streamable HTTP；Viewer protocol v7 |
| Viewer / Player runtime | 冻结的 LayaAir 3.3.10 + FairyGUI Web runtime |
| 浏览器 | 当前稳定版 Chrome 与 Edge；自动门禁使用 Chromium |

交互式工程授权依赖 File System Access API，Firefox 与 Safari 不在支持范围。Viewer 只解释 UAM 已表达的 Web UI 语义；Unity、Cocos Creator、游戏业务脚本、自定义宿主扩展和完整像素一致性不在 `0.1.x` 范围内。

## 升级与卸载

建议 Agent 和 CI 固定精确版本，并在验证后显式升级：

```powershell
npx -y @openfairygui/fairygui-maker@0.1.2 --version
npm install --global @openfairygui/fairygui-maker@0.1.2
npm uninstall --global @openfairygui/fairygui-maker
```

卸载不会删除 `--data-dir` 或 `.fairygui-maker`；确认不再需要其中的 Artifact 后再手动删除。

## 文档

- [架构](./docs/architecture.md)：Host、Viewer/Player、授权与隔离、render session 协议、Artifact、接口和限制
- [设计源导入（已冻结）](./docs/design-import.md)
- [Agent 任务评测](./docs/agent-evals.md)：`pnpm eval:agent` 的任务、隔离、判定与各版本结果
- [参与开发](./CONTRIBUTING.md)：本地开发、测试与 Golden 更新
- [发布检查清单](./docs/release-checklist.md)
- [第三方运行时与补充声明](./THIRD_PARTY_NOTICES.md)；生产构建还会生成并发行 `dist/web/THIRD_PARTY_LICENSES.md`
- [MIT License](./LICENSE)
