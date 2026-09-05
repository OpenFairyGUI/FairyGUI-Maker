# T4：安全重导入

先预览，再明确批准当前计划。不要在 Host 或其他编辑器仍打开工程时运行写回：

```powershell
fairygui-maker reimport E:\Projects\hud-imported --dry-run
# 检查 added / changed / removed / preserved，确认 conflict 和 blockers 均为空。
fairygui-maker reimport E:\Projects\hud-imported --apply <预览返回的64位planDigest>
```

两步都支持 `--data-dir`，并继续排除 Maker 私有目录、其子目录及会被整目录替换的祖先目录。`--apply` 不能省略摘要、不能和 `--dry-run` 混用，也不是其他命令的选项。成功返回 `applied: true`；失败为非零退出码，不自动重试或强制覆盖。

## 计划绑定与授权

- `projectRevision` 是整个工程目录的内容 SHA-256，包括 State、生成快照和 UAM 未建模的文件；不是 mtime，也不是跨进程失效的 Backend 数字 revision。
- `sourceDigest` 绑定实际 `.fig`/`.psd` 字节或 Bundle 的完整文件树，不能由 Bundle 声明的 `source.sha256` 替代。目录和文件名也进入摘要；哈希逐文件流式执行。
- `planDigest` 绑定上述两个摘要、规范工程路径、变更列表及阻塞项。应用时重新生成计划，比较摘要；规划期间和暂存写入前后再次检查源与工程，变化后必须重新预览、重新批准。
- 本地 CLI 的 `--apply <planDigest>` 是调用者对这一份计划的明确写入授权；摘要不是秘密凭据或远程鉴权 token。未增加 REST/MCP 写回入口，Host 原有独立 owner token / 单次 Save Grant 不变。
- 全程持有 Backend 原生工程锁，不能覆盖另一个 Backend 会话的未保存修改；每次内存事务和最终保存都传递当前 `expectedRevision`。

## 三方合并边界

比较「上次源生成快照」「当前磁盘工程」「本次源生成结果」，使用已保存的转换 ID。两侧生成结果都经过 Core Writer/Reader 往返，避免默认字段和图片路径产生伪变化；Binding-only 变化也进入计划。

- 按字段保留不重叠的编辑。固定用户字段包括资源 `favorite`、组件 `customData`，以及节点 `locked`、`touchable`、`tooltips`、`customData`。用户工程设置、分支、自建资源和无关文件保留。
- display list、controller pages 等有语义顺序的集合按稳定 ID/name 匹配；双方同时改变顺序或成员时停止，不猜插入位置。资源、包和文件夹的排列不是渲染顺序，保留用户顺序并追加新身份。
- 源删除已修改目标、同字段双边修改、身份碰撞、失效的手工语义映射或最终悬空引用都会阻塞。重导入不提供自动冲突合并或 merge editor。
- PSD 新 State v2 额外记录 `source.psdIdentityUncertain`。缺失图层 ID 使用的位置身份不能安全匹配变化后的源；重复图层 ID 直接拒绝。未记录身份信息的旧 PSD State 在源变化时也停止，不升级猜测；可另建新导入工程。稳定 ID 的 PSD 支持增改删。
- 保存仍受已安装 Backend 的事务能力和 UAM 保真检查限制，例如其不支持的跨包图片引用会出现在 `blockers`。保留字段的保证限于 Core/UAM 支持的工程语义，不声称无损保留 Core Reader 已丢弃的任意私有 XML 扩展。读取不完整或出现 error 诊断时停止。
- 本地路径的 CLI/Draft 导入可重导入；仅浏览器上传的 Draft 没有源定位，不支持。Maker、Planner、Compiler 版本检查不放宽。

## 提交与失败恢复

使用现有 Backend `removePackage` / `addPackage` 快照事务，不维护另一套属性写入协议。Backend 0.3.1 不允许同批删除并重建仍被引用的包，因此在 CLI 私有会话内分两次 revision 完成移除、重建；中间状态只在内存，不保存、不暴露给 Host。最终完整引用校验通过后，只调用一次 `saveSession`。

通过原生 `runProjectWriteTransaction` 的 staged filesystem 写工程，重新读取验证暂存工程，再写生成快照和 State，最后提交整个目录。新的 baseline 必须是纯源生成结果，不能把用户编辑吸收到 baseline 中，否则下一轮冲突会漏报。没有变更也不使用 force-save。

受控异常（包括快照/State 写入失败及最终目录替换失败）复用 Backend 清理暂存/恢复旧目录，工程与 State 一起恢复。若失败时源或外部文件已经改变，保留这些外部改变，重新预览；不替用户撤销外部写入。

此保证不扩展为断电/进程被强杀的跨平台事务：原生目录替换有两次 rename 之间的窗口。异常终止后若工程目录缺失而同级保留 `.工程名.save-backup-*` / `.工程名.save-*`，先停止相关进程并备份残留目录，再把完整 backup 恢复为原工程目录后重跑 `--dry-run`；不要把旧 State 单独拷入新工程。不要在有未恢复残留时重复写回。原生 advisory lock 能排除协作的 Backend 写入，但不锁住任意第三方编辑器；最后校验后的极短外部写入竞态也不宣称已消除。

## 回归检查

`test/design-import/reimport.test.ts` 覆盖增改删、图片/Binding、用户字段、自建资源、跨包组件引用、连续重导入、旧源/工程/State/路径计划、Backend 锁、私有路径/链接、缺失资源、PSD 身份、暂存元数据失败、最终目录替换失败和晚到的源/工程改变。`scripts/release-smoke.mjs` 另从真实安装包调用预览与应用；本地测试不代替跨 OS CI 或断电试验。

本地验收（Windows / Node 22.22.2）：TypeScript/构建、131 项 Node 测试、5 组内存压力测试、完整 18 项 Chromium 检查及 tarball 全新安装烟测通过。Viewer/Player 均为 0 different pixels，未更新基线。浏览器证据在 `test-results/browser/run-TG1CDY/report.json`，内存证据在 `test-results/memory/node-1788610761947.json`（均不进入 npm 包）。未改依赖，未重跑 npm audit / 跨 OS CI，未执行合并、推送或 npm 发布。
