# 参与开发

FairyGUI Maker 处于开发初期，暂不能用于实际项目开发或生产环境。欢迎使用测试工程参与功能验证、问题反馈和项目开发；现有功能及测试通过不代表完整工作流已成熟可用。试验导入、编辑或保存时请使用测试数据或已备份的工程副本。

当前架构与功能边界见 [docs/architecture.md](docs/architecture.md)，冻结的设计源导入见 [docs/design-import.md](docs/design-import.md)。

## 本地开发

使用 Node.js >=22.18、pnpm 10.14.0：

```powershell
pnpm install --frozen-lockfile
pnpm build
pnpm dev:host
```

`pnpm build` 执行 TypeScript 检查，并分别构建 React Workbench 与可直接由 Node.js 运行的 Host。完整导入、runtime 隔离与预览使用构建后的 Host 页面（默认端口 3847）；修改构建后重启 Host，以更新静态文件白名单。`pnpm dev:web` 只用于可信源码的前端 UI 调试，不代替 Host 的安全响应头和隔离验收；不要为调试放宽 Host 的 Origin、CORS 或 sandbox 策略。

沿用所修改文件的格式；按责任边界提交，不顺带全仓格式化、升级依赖或改写用户已有工作。

## 提交前验证

- `pnpm test`：类型检查、生产构建与 Node 测试。
- 浏览器、协议或导入行为变化：安装 Chromium（`pnpm exec playwright install --no-shell chromium`），再执行 `pnpm test:browser`。
- 文件、资源或引用预算变化：`pnpm test:memory`。
- 准备发布：同一提交执行 `pnpm verify:release`，按[发布检查清单](docs/release-checklist.md)处理；本地通过不等于远端 CI 或 npm 发布成功。

各范围对应的测试文件见[测试入口](docs/architecture.md#测试入口)。浏览器烟测读取当前 `dist/web`，不要与 `pnpm build`、`pnpm test` 或 `npm pack`/tarball 烟测并行运行；`pretest` 和 `prepack` 都会重新构建并替换这些文件。

CI 在推送 `main` 和 PR 时运行：Windows/Linux × Node 22.18/24 执行 runtime 校验、构建、单元测试和内存门禁；Linux 再运行浏览器烟测、安装包烟测和 Agent 评测自检（`pnpm eval:agent --runner reference`），无论成败都上传证据并保留 14 天。依赖审计只在 `pnpm verify:release` 和发布工作流中执行。

## 浏览器证据与 Golden

每次浏览器测试在 `test-results/browser/run-*/` 留存 reference/actual/diff、阈值、来源/组件/Broker 版本和诊断报告，规则见[浏览器测试证据](docs/architecture.md#浏览器测试证据)。测试固定使用 ANGLE/SwiftShader，不改变正常 Workbench 浏览器的 GPU 配置；含文字的语义截图使用 Windows/Linux 独立基线，以容纳系统字体栅格化差异。Viewer/Player 的像素阈值为 0，不要为了通过而放宽阈值。

只有确认渲染变化符合预期时才在本地更新 Golden。工具先保存原 reference/actual/diff，功能和诊断检查全部通过后才写入新 Golden；CI 禁止更新。更新后审查图片，再关闭开关重跑：

```powershell
$env:UPDATE_VISUAL_GOLDENS = "1"
pnpm test:browser
Remove-Item Env:UPDATE_VISUAL_GOLDENS
pnpm test:browser
```

诊断豁免必须限于明确注入的故障、消息、阶段和来源，不屏蔽整页错误。证据写入已忽略的 `test-results/`，不要提交 token、授权句柄、私有设计源或本机路径。

## 内置 runtime

三个浏览器 runtime 文件逐字节复制自上游预编译资产，来源、commit、字节数和 SHA-256 记录在 `vendor-runtime.lock.json`。`pnpm verify:runtime` 在本地校验清单、实际字节和第三方声明是否一致（`npm pack` 的 `prepack` 也会执行）；`pnpm verify:runtime --upstream` 联网复核固定的上游快照。复制来源和复现边界见[第三方声明](THIRD_PARTY_NOTICES.md)与[发布检查清单](docs/release-checklist.md)。

## 契约与范围

稳定 ID、revision/CAS、权限与文件边界是接口契约。改动应同时覆盖输入校验、共享类型、调用者与可见结果；保留旧版本的已支持入口，破坏性变更需明确迁移方案。浏览器分析和客户端声明不能冒充 Host 验证；引用建议不授权删除或重写工程。

`src/design-import/index.ts` 是源码消费者的集中入口，保留现有 `MemoryFileSystem` 兼容导出；新生产代码使用所属模块的直接导入。npm 包提供 CLI 与构建后的 Host/Workbench，目前不是另一个 TypeScript SDK，不新增多包或通用服务层。
