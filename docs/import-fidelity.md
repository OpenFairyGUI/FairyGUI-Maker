# T5：导入语义与视觉保真

T5 复用现有 ImportDocument → Semantic Overlay → BuildPlan → UAM 链路，不新增依赖、组件库服务或事件执行器。
Planner 为 `deterministic-v2`，Compiler 为 `deterministic-v3`；Bundle/ImportDocument/Overlay schema 仍为 v1，BuildPlan 仍为 v2。
旧 Plan 必须重新生成；明确记录旧 Planner/Compiler 的 State 不能直接重导入，沿用已有版本拒绝规则，不静默改写旧工程。

## 可执行的计划字段

`POST /api/import-drafts/:draftId/plan` 在原有鉴权、`expectedRevision` 和 parsed/planned 状态检查下接受可选的完整 `semanticOverlay`。
省略它会沿用已保存的 Overlay；传入时是完整替换，不是深度合并。可先读取 Draft 详情的 `semanticOverlay` 再修改。
Workbench 的单节点映射接口保持不变；本批字体库存与组件库策略通过 Plan API/程序调用输入，没有新增字体安装或库选择界面。

示例（节点 ID 应替换为实际源 ID）：

```json
{
  "expectedRevision": 3,
  "rootIds": ["screen"],
  "semanticOverlay": {
    "schemaVersion": 1,
    "profile": {
      "fidelity": "hybrid",
      "packageStrategy": "per-page",
      "componentization": "balanced",
      "unsupportedNode": "fail"
    },
    "fonts": {
      "availableFamilies": ["Project Sans"],
      "substitutions": { "Design Sans": "Project Sans" },
      "fallbackFamilies": ["sans-serif"]
    },
    "componentLibrary": { "PrimaryButton": "library-button" },
    "nodes": {
      "instance": { "target": "component", "componentKey": "PrimaryButton", "rationale": "User mapping" },
      "row": { "target": "component", "layout": "bake", "rationale": "User mapping" },
      "button": { "target": "button", "rationale": "User mapping" },
      "button-up": { "target": "graph", "state": { "controller": "button", "page": "up" }, "rationale": "User mapping" },
      "indicator": { "target": "rasterize", "rationale": "User mapping" }
    }
  }
}
```

- `fonts`：精确的源 family 替换，然后按声明库存（family 比较不区分大小写）选择第一个可用 fallback。普通文本、RichText runs 和 Instance 字体 Override 共用此策略；不自动推断 PostScript 名到 family 的映射。
- `componentLibrary`：显式 key → 当前源文档内 Component ID；Instance 的 `componentKey` 改变实际资源引用和跨 Page 依赖闭包。不存在的目标、循环引用、带源专属 Overrides 的重定向均拒绝。它不是远程库导入，不接受磁盘路径/URL。未配置 key 的 Instance 保留原引用并报告 `SEMANTIC_COMPONENT_KEY_UNRESOLVED`；Frame 的既有 componentKey 命名用途保持不变，但不能把 Frame 当库映射 Instance。
- `state`：直接父组件生成原生 Controller 和 Display Gear；页顺序采用源节点首次出现顺序，默认选中第 0 页。Button 使用 `button` controller 的 `up/over/down/disabled` 页。根节点、Variant 子节点和 List item 状态映射明确拒绝；页名不能含逗号。
- `layout: preserve`：支持的简单横/纵布局生成原生 Group；`bake` 保留当前坐标、不生成动态 Group。源语义不可保留时警告；原生 List 不能同时要求 `bake`。
- `target: rasterize` 或 `asset.rasterize: true`：已有 PNG 直接复用；无描边/阴影、纯色、统一圆角的矩形/椭圆/多边形通过已安装 Resvg 生成真实 PNG。单图边长 ≤8,192、像素 ≤1,600 万，多边形 ≤20,000 坐标；单次编译新增栅格累计 ≤6,400 万像素。位置、尺寸、约束继续保留，但形状内容不再是可编辑 Graph。
- 未支持的复杂合成、文字或 SVG 显式栅格请求：`unsupportedNode: fail` 阻止编译，`skip` 跳过节点与其子树，默认 `rasterize` 保留原节点并报告 `SEMANTIC_RASTERIZE_UNAVAILABLE`，不把未经合成的内容声称为最终 PNG。
- `asset.scale9Grid` 沿用图片策略；相同 PNG 的不同尺寸/九宫格不会错误合并成同一资源。

全局 `fidelity/packageStrategy/componentization` 当前只支持 `hybrid/per-page/balanced`。
其他 schema 内选项产生 `SEMANTIC_PROFILE_UNSUPPORTED` 并阻止编译，避免“能填但无效”。所有编译前诊断重新计算，删除 Plan 的 diagnostics 不能绕过错误。
重导入保留字体/库策略；需要跨重导入保留的人工节点指令仍按原契约标记 `rationale: "User mapping"`。

## 诊断与证据边界

转换报告新增 `fidelity.fonts/layouts/interactions`。字体记录 required/resolved、源 style/PostScriptName（若存在）和证据来源：

- `declared-available/substituted/fallback` 仅依据调用方库存或通用 family；不代表 Host 已发现或安装字体。
- `missing` 表示声明库存中没有命中；未提供库存且没有通用 family 依据时为 `unverified`，不把未知误报为缺失。
- `FONT_MISSING/FONT_UNVERIFIED/FONT_FALLBACK/FONT_SUBSTITUTED` 保留到诊断。缺失和未验证字体不会自动阻止编译。

已有 FIG 渐变文字的 SVG/PNG Parser fallback 另外报告 `FONT_FALLBACK_ENVIRONMENT_UNVERIFIED`：PNG 仍依赖解析 Host 的系统字体，SVG 依赖目标渲染器；后续 Overlay 不会重排已生成的图片，不能据此声称跨系统确定性。

两种 Runtime 的 observation 文本节点增加可选 `font`：family、`loaded-face/generic/bitmap/metrics-distinct/fallback-or-equivalent/unverified`，以及可取得的真实 `renderedTextWidth` 和单行溢出标志。
FontFaceSet 已加载证据或 Canvas fallback 度量对比不是系统字体清单，也不证明所有字形、字重或多行排版一致；相同度量可能是 fallback，也可能是等价字体。
每次 observation 最多探测/缓存 128 个 family、每次最多遍历 1,024 个 FontFace；超过探测预算返回 `unverified`，缓存不跨场景保留。
无自动下载字体、跨域读取字体或业务事件执行。

布局明确分为 `layout_semantic_preserved/layout_baked/layout_dropped`；复杂 FIG Auto Layout 报告 `LAYOUT_BAKED`，丢失子节点时报告 `LAYOUT_DROPPED`。
FIG shear/skew/退化矩阵报告 `FIG_TRANSFORM_APPROXIMATED`，仍只表达位置、旋转、缩放。
PSD 分别报告 `PSD_EFFECTS_DROPPED/PSD_MASK_DROPPED/PSD_ADJUSTMENT_DROPPED/PSD_CLIPPING_DROPPED/PSD_BLEND_APPROXIMATED`；高位深转 PNG 报告 `PSD_PRECISION_REDUCED`，色彩管理为 `PSD_COLOR_MANAGEMENT_UNVERIFIED`。单图层 PNG 不等于 Photoshop 最终合成。

FIG Prototype Interaction Intent 保留有界的 trigger/action/原始 JSON 到 IR 与工程 `customData.maker`，标记 `executable: false` 并报告 `INTERACTION_INTENT_UNSUPPORTED`。
每节点最多 64 条、每条原始 JSON 最多 16,384 字符；Bundle 的全局字符串/结构预算仍生效。这是可追踪的声明，不是导航、URL 加载或脚本。

报告的 pages/roots/nodes/frames 仍描述选中源与依赖源；编译后的 editableText/editableShapes/editableInstances/imageBytes 按实际发出的源节点计数，排除 ignore/skip，计入新栅格字节，不把 Override clone 重复计为源节点。解析阶段尚无输出，计数只是源类型统计。

## 验收

`test/design-import/fidelity.test.ts` 检查策略改变 UAM、不同九宫格去重、错误不可绕过、Core 写入/回读与修改文字后再次写入回读。
真实 FIG/PSD corpus 继续验证适配器诊断。

`scripts/semantic-fidelity-smoke.ts` 纳入 `pnpm test:browser`：同一导入计划生成可编辑工程供 Viewer 使用，再经 Core 发布真实 `.fui` 与 PNG atlas，由独立原生 Player 加载。
工程背景使用原生 Graph（Core 的 component bgColor 是编辑器属性，发布 FUI 不渲染）；Viewer 保留按钮源标题、使用正确的文字垂直对齐属性，并且只有声明描边颜色时才启用文字描边。

新增 8 张 460×350 独立 Golden：两种 Runtime × 四种按钮状态，包含真实订单标题、金额、按钮文字和双行 List。
通过既有 Broker 切页并检查仅当前背景可见、文字存在、单行未溢出、List 两项，以及四页图片不同。
测试预载已安装 `@fontsource-variable/geist@5.3.0` 的 Latin variable WOFF2（SHA-256 `19f9c92546aa300c312235e3125af1b81394d8db9a4bc4a425cd5b641d2d54e1`），无远程字体请求。
每种 Runtime 各自零像素差异/零 MAE，保存 reference/actual/diff 与版本证据；并不要求两个 Runtime 相互像素一致。
固定字体只覆盖此 Latin fixture，不覆盖任意系统字体、中文、复杂脚本或 Photoshop 合成保真。
Windows/Linux 的字体栅格化仍需同提交 CI 证据；本地通过不能代替完整 CI 矩阵。

基线更新沿用显式 `UPDATE_VISUAL_GOLDENS=1`、CI 禁止更新、所有功能/诊断通过后才写回的机制；更新后审查图片，并关闭更新重跑。
