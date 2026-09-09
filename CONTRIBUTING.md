# 参与开发

FairyGUI Maker 处于开发初期，暂不能用于实际项目开发或生产环境。欢迎使用测试工程参与功能验证、问题反馈和项目开发；现有功能及测试通过不代表完整工作流已成熟可用。试验导入、编辑或保存时请使用测试数据或已备份的工程副本。

当前架构与功能边界见 [docs/architecture.md](docs/architecture.md) 和 [docs/workbench.md](docs/workbench.md)。历史提案位于 [docs/archive](docs/archive/design-to-fairygui-proposal.md)，不作为实现契约。

使用 Node.js >=22.18、pnpm 10.14.0，先执行 `pnpm install --frozen-lockfile`。沿用所修改文件的格式；按责任边界提交，不顺带全仓格式化、升级依赖或改写用户已有工作。

## 提交前验证

- `pnpm test`：类型检查、生产构建与 Node 测试。
- 浏览器、协议或导入行为变化：安装 Chromium（`pnpm exec playwright install --no-shell chromium`），再执行 `pnpm test:browser`。使用生产 Host；Vite dev server 不替代隔离与安全响应头验收。
- 文件、资源或引用预算变化：`pnpm test:memory`。
- 准备发布：同一提交执行 `pnpm verify:release`，按 [发布检查清单](docs/release-checklist.md) 处理；本地通过不等于远端 CI 或 npm 发布成功。

浏览器烟测读取当前 `dist/web`，不要与 `pnpm build`、`pnpm test` 或 `npm pack`/tarball 烟测并行运行；`pretest` 和 `prepack` 都会重新构建并替换这些文件。

浏览器验收必须关闭 `UPDATE_VISUAL_GOLDENS`。只有确认渲染变化符合预期时才在本地更新 Golden，审查图片后关闭开关重跑；CI 禁止更新。诊断豁免必须限于明确注入的故障、消息、阶段和来源，不屏蔽整页错误。证据写入已忽略的 `test-results/`，不要提交 token、授权句柄、私有设计源或本机路径。

## 契约与范围

稳定 ID、revision/CAS、权限与文件边界是接口契约。改动应同时覆盖输入校验、共享类型、调用者与可见结果；保留旧版本的已支持入口，破坏性变更需明确迁移方案。浏览器分析和客户端声明不能冒充 Host 验证；引用建议不授权删除或重写工程。

`src/design-import/index.ts` 是源码消费者的集中入口，保留现有 `MemoryFileSystem` 兼容导出；新生产代码使用所属模块的直接导入。npm 包提供 CLI 与构建后的 Host/Workbench，目前不是另一个 TypeScript SDK，不新增多包或通用服务层。
