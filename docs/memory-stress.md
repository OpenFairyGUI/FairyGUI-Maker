# T3 内存压力验收

入口：构建后运行 `pnpm test:memory` 和 `pnpm test:browser`。两者均进入 `pnpm verify:release`；CI 的 Node 22/24、Windows/Linux 矩阵另行执行 Node 压力门禁。JSON 证据保存在 `test-results/memory/` 和浏览器报告的 `checks.runtime-budgets.result.memory`，CI 留存，不进入 npm 包。

## 用例与门禁

| 用例 | 可重复输入与断言 |
|---|---|
| Bundle | 16 × 8 MiB 合成资源，真实序列化/摘要/解析；513 MiB 声明在摘要前拒绝，随后合法 Bundle 可解析 |
| Base64 | 64 MiB Uint8Array 走 CLI/Host 共用持久化编码器，往返字节相同 |
| 大量图片 | 5,000 × 32 KiB 源字节做 Asset 分析；5,001 个资源拒绝；在途哈希最多 1 |
| 引用 | 50,000 条引用成功，50,001 条拒绝，随后小输入恢复 |
| Override | 1 MiB 文本的 33 个克隆触发 32 MiB 预算，随后 16 个克隆成功 |
| 实际解码 | Viewer 加载 4 张 4096 × 2048 PNG（RGBA 估算 128 MiB），第 5 张在解码前拒绝；失败/替换后的已捕获原生纹理句柄全部 destroyed |
| 实例展开 | 100 × 100 叶对象请求在 5,000 场景节点边界终止，正常场景恢复 |
| Player A/B | 同一真实隔离 iframe 中 100 次两阶段加载，每次 256 个 atlas 子纹理；每 10 次卸载并 GC，检查包、Blob、缓存、原生资源和 JS 堆回落 |
| Player 闭包 | 真实跨包组件引用可创建，未选包未注册；切换根包移除旧闭包；父页面不读取未请求的 500 MiB 文件声明 |
| 音频 | 合法 WAV 以流式媒体播放、不调用 PCM loader；31 秒 WAV 拒绝；卸载后媒体 paused、src 清空、Blob 撤销，正常加载恢复 |

Node 每例在独立子进程执行，峰值 RSS < 1 GiB；三次 GC 后相对初始的 heapUsed 增量 < 32 MiB、ArrayBuffer 增量 < 4 MiB。在阶段边界和摘要调用处采样 RSS/heap/external/ArrayBuffer，并使用进程 RSS 高水位补足同步分配峰值。JSON 的 heap/external/ArrayBuffer 峰值只是采样峰值，不宣称覆盖每个瞬时分配。RSS 不作为“必须还给操作系统”的回落断言。

Player 通过绑定到 iframe 的 Chromium CDP 获取 JS heap 与 backing storage，按 10 次间隔强制 GC。第 100 次相对第 10 次堆增量 < 4 MiB、backing storage 增量 < 1 MiB；最后 50 次堆增量 < 1 MiB。卸载后的包与 Blob 为零，缓存项和原生资源数必须与热身基线一致。有限 100 次采样不等价于无限期无泄漏证明。

## 定点优化与实测

2026-09-05 本地 Windows / Node v22.22.2 单次对照，改动前代码基线为 `fe05b74`。这些是同机样本，不是跨平台性能承诺或多次中位数。

| 用例 | 优化前峰值 RSS | 优化后样本峰值 RSS | 优化后 GC 回落 |
|---|---:|---:|---:|
| 5,000 图片分析 | 578.7 MiB | 258.4 MiB | 99.0 MiB |
| 128 MiB Bundle | 750.5 MiB | 616.5 MiB | 88.3 MiB |
| 64 MiB Base64 | 708.9 MiB | 644.7 MiB | 90.9 MiB |

对应本地 Node 报告：`node-1788605414726.json`（哈希基线）、`node-1788606000287.json`（Base64 原编码器基线）、`node-1788606107148.json`（优化后样本）。Base64 与 Bundle 的 JSON/独立快照仍有内存放大，没有宣称流式处理或 512 MiB 极限实包已通过。

完整 Chromium 报告 `test-results/browser/run-upLg4U/report.json`：18 项检查通过、0 项意外诊断，Viewer/Player Golden 均为 0 different pixels。Player 采样峰值 JS heap 37.5 MiB；卸载后第 10/100 次为 10.98/11.28 MiB，原生资源数恒为 11，缓存/包/Blob 均为 0；实际捕获的大图纹理 RGBA 估算从 128 MiB 回到 0。音频测试主动卸载产生的 `blob:null` 媒体 `ERR_ABORTED` 单独归为预期故障，其他来源/阶段/错误仍阻断。

改动复用现有所有者与 `ResourceBudget`：Asset/Bundle 顺序哈希、去掉 Web Crypto 前的重复字节复制；CLI/Host 共用原 Base64 格式并减少额外复制；Player 只加载所选包依赖闭包的资源，沿用原生 FUI 解析器。音频单文件 8 MiB、累计 32 MiB、32 段、30 秒/段、最多 8 个播放；同段重复播放从头开始，不叠加 voice。未知 URL 不播放，浏览器自动播放策略仍有效。

未验证：真实 GPU/VRAM 和驱动占用、浏览器媒体解码器内部内存。当前 SwiftShader 下 Laya 的 CPU/GPU 记账可能恒为 0，报告原值仅用于诊断，不能当作零内存证据。RGBA 估算来自实际已解码纹理尺寸与销毁状态；Node 的合成图像字节用例只测 Bundle/摘要，不冒充图片解码。未新增资源管理框架、解析库或业务缓存。
