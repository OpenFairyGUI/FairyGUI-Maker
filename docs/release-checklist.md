# 发布检查清单

> **当前发布定位：早期实验版本。** 项目处于开发初期，暂不能用于实际项目开发或生产环境。以下门禁用于检查特定版本的构建、测试与分发，不代表项目已达到实际开发可用标准。

发布对象是一个固定提交，不是几个不同提交的测试结果集合。以下检查不自动授权创建 GitHub Release、修改 npm/GitHub 凭据或执行 `npm publish`。

## 固定输入

- README、包简介与 GitHub Release 说明须保持一致，明确开发初期状态、仅供实验评估及暂不能用于实际项目开发；不得将测试通过或成功发布表述为生产可用。
- `package.json` 中包名为 `@openfairygui/fairygui-maker`、许可证为 MIT，repository/homepage/issues 指向 `OpenFairyGUI/FairyGUI-Maker`；发布 tag 必须为 `v<package-version>`。CLI 名称仍为 `fairygui-maker`。
- `vendor-runtime.lock.json` 是三个浏览器 runtime 文件来源、完整 commit、源路径、字节数和 SHA-256 的单一清单。第三方声明与 tarball 内 `dist/web/viewer-runtime/` 必须与它一致。
- runtime 直接复制自清单指定的 `FairyGUI-Editor-Online` 预编译资产，不做构建或改写。按 `source.repository`、`source.commit` 和每个 `sourcePath` 获取原始文件，保持字节原样；不要用文本写入命令或换行转换重存。`.gitattributes` 禁止这些文件的 Git 文本转换。
- 该来源链只能复现分发的预编译字节，不证明 LayaAir/FairyGUI 原始源码构建可复现。若以后需要重建引擎，必须另行固定引擎源码 commit、工具链与构建命令，不能从版本标签推断。

```powershell
pnpm install --frozen-lockfile
pnpm verify:runtime --upstream
pnpm exec playwright install --no-shell chromium
pnpm verify:release
```

`--upstream` 联网逐字节校验三个固定来源；默认校验完全本地执行。`npm pack` 的 `prepack` 在构建前也执行本地校验。发行 smoke 安装实际 tarball 到全新消费目录；由 `verify:release` 调用时先对安装结果执行 `npm audit --omit=dev`，再检查 runtime 清单及字节、CLI、Workbench/MCP、导入确定性、保存授权、iframe 隔离和 Artifact 完整性，不等同于真实 npm 发布。`pnpm audit --prod` 只看本仓库 lockfile（含 pnpm overrides），用户安装得到的是 npm 按已发布版本范围解析的依赖树，两者都要通过：任一审计发现已知漏洞即失败，发布工作流随之拒绝发布。`package.json` 的 `pnpm.overrides` 暂把 `@openfairygui/functions` 依赖的 sharp 固定为 0.35.5，只作用于本仓库开发与 CI；OpenFairyGUI 0.7.0 把 sharp 限定在 `<0.35.0`，npm 用户仍会装到有漏洞的版本（[OpenFairyGUI#170](https://github.com/OpenFairyGUI/OpenFairyGUI/issues/170)）。上游放宽范围后移除该 override。

## 同一提交的退出条件

1. 干净 checkout 的完整 SHA 已记录；依赖采用 frozen lockfile。
2. 本地 `pnpm verify:release` 全程退出 0，包括本仓库生产依赖审计、安装后依赖审计和全新 tarball 消费测试。
3. 同一 SHA 的 CI 四个单元测试组合（Windows/Linux × Node 22.18/24）与 Linux `release-smoke` 全部通过。超时、进行中、旧 SHA 和部分绿灯均不能算通过。CI 不运行依赖审计，审计以第 2 条和发布工作流为准。
4. 浏览器证据保留 reference/actual/diff、运行环境与诊断报告。合成图形使用固定 SwiftShader；含文字的语义截图分别使用 Windows/Linux 基线，Viewer/Player 的像素阈值仍为 0。更新 Golden 必须人工检查图片，并在关闭更新开关后重跑完整门禁。
5. 所有变更审查完成；实际发布前再核对 npm 包状态与发布权限。任意文件改变都需要以新 SHA 重新验收。

CI 单元测试 job 限时 20 分钟，完整发布门禁限时 30 分钟；时间限制只用于暴露挂起，不代表挂起原因已经解决。GitHub 浏览器证据默认保留 14 天，需要长期归档时由发布者另行保留。

## npm 首发与后续发布

版本通过 GitHub Release 触发 `release.yml` 发布，发布者需要在 npm `openfairygui` 组织中有发布权限。`0.1.1` 与 `0.1.2` 已由 `release.yml` 用 bootstrap `NPM_TOKEN` 发布；该 secret 仍在，Trusted Publisher 尚未完成下面第 3–4 步的闭环验证。`v0.1.0` 标签与同名 Release 草稿指向旧提交 `48435c4573ed4d47e061a2cb41362118e8c0d37e`，不要发布该草稿或覆盖该标签。

首次发布和后续 Trusted Publisher 认证必须分别验收。步骤为：

1. 发布者确认包名可用、账号有发布权，并明确批准首发。
2. 临时配置仅用于首发、可发布该 scope 并启用 Bypass 2FA 的 granular `NPM_TOKEN` repository secret；从已验收提交创建版本 tag/GitHub Release，由 `release.yml` 执行门禁和带 provenance 的发布。
3. 首发成功后，在 npm package settings 配置 GitHub Trusted Publisher：organization/user 为 `OpenFairyGUI`，repository 为 `FairyGUI-Maker`，workflow filename 为 `release.yml`，允许直接 `npm publish`。当前工作流未配置 GitHub Environment，不应填写不匹配的 environment。
4. 删除 GitHub 的 bootstrap secret 并撤销 npm token。下一次经授权的版本发布必须在没有该 token 的情况下成功，才能证明 OIDC 路径闭环；仅存在 `id-token: write` 不算验证成功。
5. 实际发布后，核对 `npm view @openfairygui/fairygui-maker@<version> version dist.integrity`、registry tarball 和 provenance；包名、版本、tag、Release、CI 和产物必须一致。

现有 `release.yml` 使用 GitHub-hosted Ubuntu、Node 24 和 npm 11.18.0；npm 优先尝试 OIDC，并支持 token fallback。认证与配置要求以 [npm Trusted Publishing 官方文档](https://docs.npmjs.com/trusted-publishers/)为准。不要为验证流程直接发布一个无人批准的版本。
