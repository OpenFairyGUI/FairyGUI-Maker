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
