# 发布检查清单

发布对象是一个固定提交，不是几个不同提交的测试结果集合。以下检查不自动授权创建 GitHub Release、修改 npm/GitHub 凭据或执行 `npm publish`。

## 固定输入

- `package.json` 中包名为 `fairygui-maker`、许可证为 MIT，repository/homepage/issues 指向 `OpenFairyGUI/FairyGUI-Maker`；发布 tag 必须为 `v<package-version>`。
- `vendor-runtime.lock.json` 是三个浏览器 runtime 文件来源、完整 commit、源路径、字节数和 SHA-256 的单一清单。第三方声明与 tarball 内 `dist/web/viewer-runtime/` 必须与它一致。
- runtime 直接复制自清单指定的 `FairyGUI-Editor-Online` 预编译资产，不做构建或改写。按 `source.repository`、`source.commit` 和每个 `sourcePath` 获取原始文件，保持字节原样；不要用文本写入命令或换行转换重存。`.gitattributes` 禁止这些文件的 Git 文本转换。
- 该来源链只能复现分发的预编译字节，不证明 LayaAir/FairyGUI 原始源码构建可复现。若以后需要重建引擎，必须另行固定引擎源码 commit、工具链与构建命令，不能从版本标签推断。

```powershell
pnpm install --frozen-lockfile
pnpm verify:runtime --upstream
pnpm exec playwright install --no-shell chromium
pnpm verify:release
```

`--upstream` 联网逐字节校验三个固定来源；默认校验完全本地执行。`npm pack` 的 `prepack` 在构建前也执行本地校验。发行 smoke 安装实际 tarball 到全新消费目录，检查 runtime 清单及字节、CLI、Workbench/MCP、导入确定性、保存授权、iframe 隔离和 Artifact 完整性，不等同于真实 npm 发布。

## 同一提交的退出条件

1. 干净 checkout 的完整 SHA 已记录；依赖采用 frozen lockfile。
2. 本地 `pnpm verify:release` 全程退出 0，包括生产依赖审计和全新 tarball 消费测试。
3. 同一 SHA 的 CI 四个单元测试组合（Windows/Linux × Node 22.18/24）与 Linux `release-smoke` 全部通过。超时、进行中、旧 SHA 和部分绿灯均不能算通过。
4. 浏览器证据保留 reference/actual/diff、运行环境与诊断报告。合成图形使用固定 SwiftShader，Viewer/Player 的像素阈值仍为 0；更新 Golden 必须人工检查图片，并在关闭更新开关后重跑完整门禁。
5. 所有变更审查完成；实际发布前再核对 npm 包状态与发布权限。任意文件改变都需要以新 SHA 重新验收。

CI 单元测试 job 限时 20 分钟，完整发布门禁限时 30 分钟；时间限制只用于暴露挂起，不代表挂起原因已经解决。GitHub 浏览器证据默认保留 14 天，需要长期归档时由发布者另行保留。

## npm 首发与后续发布

2026-09-04 只读核查：npm registry 的 `fairygui-maker` 返回 404，GitHub Release 列表为空，repository secrets 列表为空。404 不代表包名已预留或当前账号有权发布；repository secrets 列表也不能证明没有组织级凭据。

首次发布尚未执行，Trusted Publisher 的真实认证链尚未验收。步骤为：

1. 发布者确认包名可用、账号有发布权，并明确批准首发。
2. 临时配置仅用于首发的 granular `NPM_TOKEN` repository secret；从已验收提交创建版本 tag/GitHub Release，由 `release.yml` 执行门禁和带 provenance 的发布。
3. 首发成功后，在 npm package settings 配置 GitHub Trusted Publisher：organization/user 为 `OpenFairyGUI`，repository 为 `FairyGUI-Maker`，workflow filename 为 `release.yml`。当前工作流未配置 GitHub Environment，不应填写不匹配的 environment。
4. 删除 GitHub 的 bootstrap secret 并撤销 npm token。下一次经授权的版本发布必须在没有该 token 的情况下成功，才能证明 OIDC 路径闭环；仅存在 `id-token: write` 不算验证成功。
5. 实际发布后，核对 npm 版本、tarball 和 provenance，再更新 README 中的“未发布”状态。

现有 `release.yml` 使用 GitHub-hosted Ubuntu、Node 24 和 npm 11.18.0；npm 优先尝试 OIDC，并支持 token fallback。认证与配置要求以 [npm Trusted Publishing 官方文档](https://docs.npmjs.com/trusted-publishers/)为准。不要为验证流程直接发布一个无人批准的版本。
