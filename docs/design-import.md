# 设计源导入

> **已冻结**：保留现有功能和测试，只修复阻断性问题，不再增加新功能。当前主线见 [README](../README.md)。

Maker 可以把 `.fig`、`.psd` 或 Maker Import Bundle v1 目录转换成新的 FairyGUI 工程目录，并在源变化后安全重导入。链路固定为：

```text
设计源 → ImportDocument（Source IR）→ Semantic Overlay → BuildPlan v2 → UAM → Draft 工程 → 物化到目标目录
```

Bundle、ImportDocument 和 Overlay 的 schema 为 v1，BuildPlan 为 v2；Planner 为 `deterministic-v2`，Compiler 为 `deterministic-v3`。生成算法变化时更新算法版本，不用 npm 包版本代替。

## CLI

```powershell
fairygui-maker import E:\Design\hud.fig --out E:\Projects\hud-imported
fairygui-maker import inspect E:\Design\hud.fig
fairygui-maker import plan E:\Design\hud.fig --out E:\Design\hud-plan.json
fairygui-maker import E:\Design\hud.fig --dry-run
fairygui-maker reimport E:\Projects\hud-imported --dry-run
fairygui-maker reimport E:\Projects\hud-imported --apply <上一步的planDigest>
fairygui-maker view E:\Projects\hud-imported
```

所有导入都先把源复制到 `--data-dir/import-drafts/<draftId>`，再依次保存 Source IR、BuildPlan、UAM 和 Draft 工程。`inspect` 不编译，`plan` 只额外写入指定的计划 JSON，`import --dry-run` 只编译 Draft；只有普通 `import --out` 会在校验完成后物化目标目录。`--out` 必须尚不存在，Maker 通过同盘临时目录和原子改名避免覆盖或留下半成品，并在工程目录写入 State v2 与不可变生成快照。Draft 带 revision，Host 重启后可恢复；七天未更新的 Draft 在下次启动时清理。

## Draft 与 Host API

Host 提供带 bearer token 保护的 `/api/import-drafts` 创建、列表、详情、删除、`parse`、`plan`、`compile` 和 `materialize` 接口。所有变更请求都必须提交当前 `expectedRevision`；`view <project-path>` 只读模式禁用这些接口。

- **Plan**：`POST /api/import-drafts/:draftId/plan` 在 parsed/planned/compiled 状态下接受可选的完整 `semanticOverlay`。省略时沿用已保存的 Overlay；传入时整体替换，不做深度合并，可先读 Draft 详情的 `semanticOverlay` 再修改。Plan 与 Overlay 作为同一份不可变快照保存，由 Draft revision 的原子提交选定；映射或重规划中途失败时，原 revision 仍读取、编译原内容，重启也不会接纳失败请求的输入。省略 `rootIds` 时保留原计划的 exported roots。
- **预览后改稿**：在 planned/compiled 状态修改单节点映射时，Host 自动重新生成 Plan 并回到 planned。成功重规划会撤下旧 Viewer、关闭旧渲染会话并清除当前视觉证据，需要重新编译和捕获。编译使用独立生成目录，由 Draft 元数据原子选中；失败不替换上一代内容，旧目录在重启时回收。
- **旧 Plan**：持久化的 v1 Draft 元数据仍能恢复，但旧 BuildPlan 不会自动加盖新摘要，必须重新调用 Plan，或在 Workbench planned/compiled 状态点击“重新生成 Build Plan”。校验失败不改变 Draft revision。
- **物化与恢复**：Materialize 在提交目标前持久化目标、请求 revision 与生成目录的完整内容摘要。若工程已写入但 Draft 完成状态写入失败，REST 返回 `409 / materialize_recovery_required`、`committed: true`、`draftId` 和 `outputDirectory`；CLI 错误文本也包含 Draft ID、revision 与目标，这种情况不能理解为“未写盘”。重启后 Draft 详情仍提供 `materializeAttempt`，Workbench 可“核对并完成上次物化”。用原参数重试时，Host 只在目标与已记录内容完全一致时恢复状态并返回 `recovered: true`；不会覆盖已有修改，也不会把没有匹配尝试记录的既有目录视为成功。成功响应丢失后，同一请求可重复读取结果而不再次写工程。已物化的 Draft 保留完成记录，不能再改稿。
- **视觉证据**：编译后的 Draft 可上传一张 PNG Reference Image，从同页 Viewer 捕获结果，并持久化 Reference、Capture、Pixel Diff 与原始像素指标。Workbench 提供透明度叠加、并排和热图视图，不设置跨字体、平台或 rasterizer 的全局相似度通过线。
- 浏览器上传的 Draft 遵循[有界上传管线](./architecture.md#有界上传)：未完成上传 30 分钟空闲过期，已完成上传的 Draft 保留七天。

Workbench 只提供单节点映射；字体库存与组件库策略只能通过 Plan API 或程序调用输入。

## Maker Import Bundle v1

Bundle 是设计源进入 Maker 后的确定性、可校验交换格式。它复用 ImportDocument，不定义第二套设计模型，也不包含 Agent 推断的 Button、GList 或 Controller 语义。

### 可直接运行的示例

安装包随附 [minimal-bundle](./examples/minimal-bundle/maker-import.json)：完整的 [fixture.json](./examples/minimal-bundle/fixture.json)、[manifest](./examples/minimal-bundle/maker-import.json) 和 [SVG 资源](./examples/minimal-bundle/assets/000001.svg)，无需源码或测试夹具即可导入。

```powershell
$bundle = Join-Path (npm root) "@openfairygui/fairygui-maker/docs/examples/minimal-bundle"
fairygui-maker import inspect $bundle --data-dir .maker-example-data
fairygui-maker import plan $bundle --out example-plan.json --data-dir .maker-example-data
fairygui-maker import $bundle --dry-run --data-dir .maker-example-data
fairygui-maker import $bundle --out example-output --data-dir .maker-example-data
fairygui-maker view example-output --data-dir .maker-example-data
```

`example-plan.json` 和 `example-output` 必须尚不存在。源码 checkout 可把 `$bundle` 改为 `docs/examples/minimal-bundle`，命令改为 `node scripts/fairygui-maker.mjs ...`（先构建）。示例生成一个 320×160 的 Main 组件，包含 “Hello Maker” 可编辑文本和一个图标。它是人工编写的教学 IR，`source.kind: raster` 与 `source.sha256` 追踪随附 SVG 的实际字节，不代表从 Figma/PSD 导出的真实设计。

只检查时用前三条命令，视觉表现仍需在 Viewer 验证。不要把其他文件放进 Bundle 目录；修改任何文档或资源字节后，必须重新计算 manifest 中对应的 SHA-256 和 byteLength（按字节计，不能用字符串长度）。

### 目录结构

```text
maker-import.json
fixture.json
assets/
  000001.png
  000002.svg
```

- `maker-import.json`：版本、来源、文件摘要和切图绑定。
- `fixture.json`：规范化 ImportDocument；图片节点通过安全相对路径引用 `assets/`。
- `assets/`：PNG 或 SVG 字节；相同内容在一个 Bundle 中只保存一次。

### Manifest

```json
{
  "schemaVersion": 1,
  "source": {
    "kind": "psd",
    "name": "hud.psd",
    "sha256": "64-character-lowercase-sha256"
  },
  "document": {
    "path": "fixture.json",
    "sha256": "64-character-lowercase-sha256",
    "byteLength": 1234
  },
  "assets": [{
    "path": "assets/000001.png",
    "format": "png",
    "sha256": "64-character-lowercase-sha256",
    "byteLength": 5678
  }],
  "bindings": [{
    "sourceNodeId": "psd:12",
    "assetPath": "assets/000001.png",
    "pixelRatio": 1,
    "trimOffset": { "x": 0, "y": 0 },
    "scale9Grid": null
  }]
}
```

`source.kind` 为 `fig`、`psd`、`figma-rest` 或 `raster`。Bundle 不内嵌原设计源；`source.sha256` 由读取原始字节的 Adapter 计算，只用于来源追踪。

每个图片节点必须且只能有一个 binding：

- `pixelRatio` 是资源像素与 FairyGUI 逻辑单位的倍率，必须大于零。
- `trimOffset` 是从未裁切源节点左上角到切图内容左上角的逻辑单位偏移。
- `scale9Grid` 是相对未裁切源节点的逻辑单位矩形，必须完整落在节点边界内。
- 多个节点可以绑定同一个去重后的资源。

### 确定性与校验

- Serializer 固定资源编号、排序、JSON 缩进和结尾换行；相同输入产生相同文件字节。
- Manifest 最大 1 MiB，`fixture.json` 最大 16 MiB，资源总量最大 512 MiB；图片按节点引用累计也最多 512 MiB，避免重复引用放大解析内存。
- Reader 校验 manifest、document 和全部 assets 的字节数与 SHA-256，拒绝额外文件、缺失文件、路径穿越、重复内容资源、重复或错序的 binding 以及节点错绑。
- ImportDocument 自带的 diagnostics 保存在 `fixture.json`，不在 manifest 中复制。
- 语义 Overlay、字体与组件库策略不属于 Bundle manifest，也不改写源文档；重导入的 ID 复用与冲突检查由 State v2 负责。

## ImportDocument v1 字段参考

`fixture.json` 是 ImportDocument 的 JSON 线格式，与内存模型相同，唯一差异是图片载荷：JSON 用 `asset` 相对路径，内存用 `bytes: Uint8Array`。不要在 JSON 中写 `bytes`、Base64、浏览器 URL 或 FairyGUI XML。Bundle 的版本在 `maker-import.json`，`fixture.json` 本身没有 schemaVersion。

除标为“可选”的字段外，下列字段都必须提供。可空字段写 `null`，空集合写 `[]` 或 `{}`，不能靠省略获得默认值。未识别字段不构成受支持的扩展协议。导入时以真实 Reader/Planner/Compiler 的校验与诊断为准，本参考不是另一套验证器。

### 文档、页面与身份

```json
{
  "name": "Example",
  "pages": [{ "id": "page-main", "name": "Demo", "roots": [] }],
  "diagnostics": []
}
```

可编译的非空示例见[完整 fixture.json](./examples/minimal-bundle/fixture.json)。pages 必须非空，每页必须含 roots 数组，roots 的每一项必须是 frame。页面 ID 在文档中唯一，所有节点 ID 在整份文档中唯一。Adapter 应提供非空、稳定的源 ID，不能用当前位置或显示名猜测跨版本身份。节点数组顺序保留层叠和排列语义。

diagnostics 的每一项必须含字符串 `code`、`message`、`nodeId` 和 `severity: "warning" | "error"`；可选字符串为 `nodeName`、`nodeType`、`pageId`、`pageName`、`rootId`、`rootName`。没有诊断时写 `[]`。

### 所有节点的公共字段

| 字段 | JSON 类型 / 含义 |
|---|---|
| kind | `frame`、`instance`、`text`、`shape`、`image` 之一 |
| id、name | 字符串：稳定源 ID 与显示名 |
| x、y | 有限数：父节点内的位置 |
| width、height | 非负有限数：逻辑尺寸 |
| visible、mask、layoutChild | 布尔值；通常为 `true / false / true` |
| opacity | 有限数，通常在 0–1 |
| rotation | 有限数，角度；通常为 0 |
| scaleX、scaleY | 有限数，通常为 1 |
| constraints | `null` 或 `{horizontal,vertical}`；两轴各为 `min / center / max / stretch / scale` |
| interactions（可选） | 最多 64 项 `{trigger,action,source}` 字符串对象；声明性源证据，不是可执行 JavaScript |

### Frame

| 字段 | 类型 / 约束 |
|---|---|
| sourceType | `frame / group / component / componentSet` |
| flattenable | **sourceType 为 group 时必填布尔值**；其他类型不使用 |
| variantProperties | 字符串值对象，如 `{"State":"Default"}`；没有变体写 `{}` |
| layout | `null` 或 `{mode: "horizontal" | "vertical", gap: number}` |
| sourceLayout（可选） | `preserved / baked / dropped`，记录源布局的保留情况 |
| clipContent | 布尔值 |
| backgroundColor | 颜色字符串或 `null` |
| children | 节点数组，可为空；允许五种 kind |

### Text

| 字段 | 类型 / 约束 |
|---|---|
| text、fontFamily、color | 字符串；文字、字体名、颜色（示例 `#172033`） |
| fontSize | 正有限数 |
| fontStyle、fontPostScriptName（可选） | 字符串：源字体证据 |
| align | `left / center / right` |
| verticalAlign | `top / middle / bottom` |
| lineHeight | 有限数或 `null` |
| letterSpacing | 有限数，通常为 0 |
| autoSize | `none / both / height / ellipsis` |
| singleLine、bold、italic、underline、strikethrough | 布尔值 |
| runs | Text Run 数组；纯文本写 `[]` |
| shadow | `null` 或 Shadow 对象 |

每个 Text Run 都需要 `start`、`end`（UTF-16 整数索引），字符串 `fontFamily`、`color`，正有限数 `fontSize`，以及布尔值 `bold`、`italic`、`underline`、`strikethrough`。区间满足 `0 <= start < end <= text.length`，按 start 排序且不重叠；允许未指定 run 的间隙，不做隐式样式继承。Shadow 的完整字段是 `{color: string, offsetX: number, offsetY: number}`，不支持 blur/spread。

### Shape

| 字段 | 类型 / 约束 |
|---|---|
| shape | `rectangle / ellipse / polygon` |
| fillColor | 颜色字符串 |
| strokeColor | 颜色字符串或 `null` |
| strokeWidth | 非负有限数 |
| cornerRadius | 四个有限数的数组或 `null` |
| points | `null` 或有限数数组 `[x0,y0,x1,y1,...]` |
| shadows | Shadow 数组，最多 32 项；没有阴影写 `[]` |

polygon 至少需要三对坐标、坐标数为偶数，cornerRadius 必须为 null；rectangle/ellipse 的 points 必须为 null。

### Image

额外字段只有 `format: "png" | "svg"` 和 `asset: "assets/000001.svg"`。资源名为六位数字加 png/svg 扩展名，扩展名必须与 format 一致。资源非空，必须在 manifest.assets 中声明，并由 manifest.bindings 的 sourceNodeId 精确绑定同一路径；不同节点可以引用同一去重资源。逻辑尺寸来自公共 width/height，像素比例、trimOffset 和 scale9Grid 来自 binding。

### Instance 与 Override

Instance 额外字段为 `componentId: string` 和 `overrides: []`。componentId 必须引用同一 fixture 中某个 `sourceType: "component"` Frame 的源 ID，不是导入后的 FairyGUI resource ID。

每个 Override 必须提供全部下列字段，不修改的字段写 null：

| 字段 | 类型 |
|---|---|
| targetId | 字符串 |
| targetPath | 字符串数组，最多 32 项 |
| componentId、name、text、fillColor、strokeColor、fontFamily | 字符串或 null |
| visible、bold、italic、underline、strikethrough | 布尔值或 null |
| opacity、width、height、strokeWidth、fontSize | 有限数或 null |
| cornerRadius | 四个有限数的数组或 null |

targetId/targetPath 以源组件内部的稳定节点身份定位，替换 componentId 同样使用源组件身份。实际可执行的覆盖受编译器支持范围与依赖校验约束。

### 结构预算

创建目标工程前检查：最多 100 页、每页 1,000 个根、全局 10,000 个节点、节点深度 100；普通集合最多 10,000 项，variantProperties 最多 256 项；单节点最多 4,096 个 Text Run、256 个 Override、32 个 Shadow，Override targetPath 最多 32 项。普通字符串最多 1,024 个 UTF-16 code unit，诊断 message 与 interaction.source 最多 16,384，interaction.trigger/action 最多 128，text 最多 1 Mi；整个 JSON（含字段名和未使用字段）的字符串合计最多 4 Mi，值与键合计最多 1,000,000 项。

检查顺序：先 `fairygui-maker import inspect <bundle>` 验证文件摘要与 IR 结构，再 `fairygui-maker import <bundle> --dry-run` 验证实际规划与编译，最后在 Viewer 检查画面。inspect 和 dry-run 只写私有 Draft，不写目标工程。

## BuildPlan 与确定性编译

`planDocument()` 生成 `FairyBuildPlanV2`；`compilePlanToUam()` 在产生 UAM、写任何生成文件前执行严格的 Zod 与源引用校验。计划包含 `sourceSchemaVersion: 1`、`plannerVersion`、`compilerVersion`、`sourceDocumentId` 和 `sourceDigest`；拒绝旧版本、未知字段、重复 Page/Root、跨 Page 错放的 Root 或自定义保留 Key。Package/Component 名称、exported 和经过校验的 Semantic Overlay 仍可编辑。CLI、Draft Store 和重导入都传入真实 imageBindings，不存在绕过摘要的编译入口。

- **源摘要**：`sourceDigest` 是完整 ImportDocument（含原始诊断）和 `imageBindings` 的规范 JSON SHA-256。对象键按代码点排序，数组顺序保留；图片先按实际字节计算 SHA-256 和长度。Binding 的像素比例、trim、尺寸、scale9Grid 也被绑定，源结构、同尺寸图片内容或 Binding 变化都需要重新 Plan。摘要标识编译输入，不是原始 FIG/PSD 文件摘要，也不是来源签名；更改 Overlay 是编辑计划，不改变源摘要。
- **稳定 ID**：Project、Package、Resource、Display Node、Shadow、Layout、Controller Page 和 Override Clone 的新 ID 使用同一分配器：`SHA-256([maker-id-v1, sourceDocumentId, role, logicalParts, attempt])` 映射为 8 位小写 base36。碰撞时确定性递增 attempt，并预留全部有效旧 ID；当前键有可复用的 State v2 ID 时优先复用。公开的 `conversionIds` 沿用旧键格式，遇到不同角色或来源拼接成相同旧键时明确拒绝。
- **身份范围**：ImportDocument 没有独立文件身份，`sourceDocumentId` 沿用 State v2 的 document name。保持文档标识与逻辑键时，坐标、文本或像素变化不会让 ID 全量漂移；显示用的 Plan 名称不参与 ID。不同文件若同名且逻辑键相同会得到相同 ID，因此不承诺跨文件全局唯一。结果依赖固定的 Planner/Compiler/Core 版本和数组顺序。
- **诊断不可删除**：Plan 的 `diagnostics` 只是展示快照。编译时重新获取选中根与依赖根的源诊断和文档级诊断，重新计算 Planner 诊断，再追加 Compiler 诊断；删改 Plan 中的记录不能消除真实证据。Instance 或替换引用缺失/被忽略时记录 `PLAN_COMPONENT_DEPENDENCY_MISSING` 并编译失败；计划漏掉依赖根同样失败。编译不修改输入的 Document、Overlay、Plan 和旧 ID Map。
- **富文本**：导入文本中的 UBB/HTML 字面量统一转义，未被 Text Run 覆盖的文本使用基础样式。反斜杠、不安全的字体/颜色属性或跨 Runtime 不支持的分段删除线降级为普通文本并产生 `RICH_TEXT_PLAIN_FALLBACK`；替换 RichText 的 Override 文本也改为普通文本节点。
- **编译预算**：每个 Instance 最多 256 个 Override，路径和组件搜索深度最多 32；每次编译最多扫描 1,000,000 个显示节点、克隆 1,024 个组件 / 100,000 个显示节点，克隆组件 JSON 累计最多 32 MiB，超限在写工程前失败。
- **PSD 与命名**：PSD 的 512 MiB 像素预算包含文本层像素，按实际图层像素边界和 8/16/32-bit 深度计算，Artboard 可视矩形不能掩盖超限。Package 与 Resource 名称共用 NFC 规范化、大小写不敏感的冲突后缀和 Windows 保留名规则；ZIP wrapper 必须是安全的单层目录名，危险路径直接拒绝。
- **版本兼容**：State v2 记录独立的 Planner/Compiler 版本，重导入拒绝不匹配的版本；没有这两个字段的旧 State v2 仍兼容，并按原映射复用 ID。旧 Plan 必须重新生成，不静默改写旧工程。

## 语义 Overlay 与保真策略

Plan 请求示例（节点 ID 替换为实际源 ID）：

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

- `fonts`：先做精确的源 family 替换，再按声明库存（family 不区分大小写）选择第一个可用 fallback。普通文本、RichText runs 和 Instance 字体 Override 共用此策略；不自动推断 PostScript 名到 family 的映射。
- `componentLibrary`：显式 key → 当前源文档内的 Component ID；Instance 的 `componentKey` 改变实际资源引用和跨 Page 依赖闭包。不存在的目标、循环引用、带源专属 Override 的重定向都会被拒绝。它不是远程库导入，不接受磁盘路径或 URL。未配置 key 的 Instance 保留原引用并报告 `SEMANTIC_COMPONENT_KEY_UNRESOLVED`；不能把 Frame 当作库映射给 Instance。
- `state`：直接父组件生成原生 Controller 和 Display Gear；页顺序取源节点首次出现顺序，默认选中第 0 页。Button 使用 `button` controller 的 `up/over/down/disabled` 页。根节点、Variant 子节点和 List item 的状态映射明确拒绝；页名不能含逗号。
- `layout: preserve`：受支持的简单横/纵布局生成原生 Group；`bake` 保留当前坐标、不生成动态 Group。源语义不可保留时警告；原生 List 不能同时要求 `bake`。
- `target: rasterize` 或 `asset.rasterize: true`：已有 PNG 直接复用；无描边/阴影、纯色、统一圆角的矩形/椭圆/多边形通过 Resvg 生成 PNG。单图边长 ≤8,192、像素 ≤1,600 万，多边形 ≤20,000 坐标；单次编译新增栅格累计 ≤6,400 万像素。位置、尺寸和约束保留，形状内容不再是可编辑 Graph。
- 不支持的复杂合成、文字或 SVG 显式栅格请求：`unsupportedNode: fail` 阻止编译，`skip` 跳过节点及其子树，默认 `rasterize` 保留原节点并报告 `SEMANTIC_RASTERIZE_UNAVAILABLE`，不把未经合成的内容声称为最终 PNG。
- `asset.scale9Grid` 沿用图片策略；相同 PNG 的不同尺寸或九宫格不会被合并成同一资源。

全局 `fidelity/packageStrategy/componentization` 目前只支持 `hybrid/per-page/balanced`，其他 schema 内选项报告 `SEMANTIC_PROFILE_UNSUPPORTED` 并阻止编译。重导入保留字体和组件库策略；需要跨重导入保留的人工节点指令须标记 `rationale: "User mapping"`。

## 诊断与保真边界

转换报告包含 `fidelity.fonts/layouts/interactions`：

- **字体**：记录 required/resolved、源 style/PostScriptName（若存在）和证据来源。`declared-available/substituted/fallback` 只依据调用方库存或通用 family，不代表 Host 发现或安装了字体；`missing` 表示声明库存中没有命中；未提供库存且没有通用 family 依据时为 `unverified`。`FONT_MISSING/FONT_UNVERIFIED/FONT_FALLBACK/FONT_SUBSTITUTED` 不会自动阻止编译。FIG 渐变文字的 SVG/PNG 解析 fallback 另外报告 `FONT_FALLBACK_ENVIRONMENT_UNVERIFIED`：PNG 依赖解析 Host 的系统字体，SVG 依赖目标渲染器，不能据此声称跨系统确定。
- **运行时字体证据**：Viewer 和 Player 的 observation 文本节点带可选 `font`：family、`loaded-face/generic/bitmap/metrics-distinct/fallback-or-equivalent/unverified`，以及可取得的 `renderedTextWidth` 和单行溢出标志。FontFaceSet 加载证据或 Canvas 度量对比不是系统字体清单，也不证明所有字形、字重或多行排版一致。每次 observation 最多探测/缓存 128 个 family、遍历 1,024 个 FontFace，超出返回 `unverified`，缓存不跨场景保留。不自动下载字体、跨域读取字体或执行业务事件。
- **布局与变换**：布局分为 `layout_semantic_preserved/layout_baked/layout_dropped`；复杂 FIG Auto Layout 报告 `LAYOUT_BAKED`，丢失子节点报告 `LAYOUT_DROPPED`。FIG shear/skew/退化矩阵报告 `FIG_TRANSFORM_APPROXIMATED`，仍只表达位置、旋转和缩放。
- **PSD**：分别报告 `PSD_EFFECTS_DROPPED/PSD_MASK_DROPPED/PSD_ADJUSTMENT_DROPPED/PSD_CLIPPING_DROPPED/PSD_BLEND_APPROXIMATED`；高位深转 PNG 报告 `PSD_PRECISION_REDUCED`，色彩管理为 `PSD_COLOR_MANAGEMENT_UNVERIFIED`。单图层 PNG 不等于 Photoshop 最终合成。
- **交互意图**：FIG Prototype Interaction 以有界的 trigger/action/原始 JSON 保留到 IR 和工程 `customData.maker`，标记 `executable: false` 并报告 `INTERACTION_INTENT_UNSUPPORTED`。每节点最多 64 条、每条原始 JSON 最多 16,384 字符。这是可追踪的声明，不是导航、URL 加载或脚本。
- **计数**：pages/roots/nodes/frames 描述选中源与依赖源；编译后的 editableText/editableShapes/editableInstances/imageBytes 按实际发出的源节点计数，排除 ignore/skip，计入新栅格字节，不重复计 Override clone。解析阶段的计数只是源类型统计。

## 重导入

先预览，再明确批准当前计划。不要在 Host 或其他编辑器仍打开工程时写回：

```powershell
fairygui-maker reimport E:\Projects\hud-imported --dry-run
# 检查 added / changed / removed / preserved，确认 conflict 和 blockers 均为空。
fairygui-maker reimport E:\Projects\hud-imported --apply <预览返回的64位planDigest>
```

两步都支持 `--data-dir`，并继续排除 Maker 私有目录、其子目录和祖先目录。`--apply` 不能省略摘要，不能与 `--dry-run` 混用。成功返回 `applied: true`；失败以非零退出码结束，不自动重试或强制覆盖。只有本地路径的 CLI/Draft 导入可以重导入，仅浏览器上传的 Draft 没有源路径，不支持。

### 计划绑定与授权

- `projectRevision` 是整个工程目录的内容 SHA-256，包括 State、生成快照和 UAM 未建模的文件；不是 mtime，也不是 Backend 的数字 revision。
- `sourceDigest` 绑定实际 `.fig`/`.psd` 字节或 Bundle 的完整文件树（含目录和文件名，逐文件流式哈希），不能用 Bundle 声明的 `source.sha256` 代替。
- `planDigest` 绑定上述两个摘要、规范工程路径、变更列表和阻塞项。应用时重新生成计划并比较摘要；规划期间和暂存写入前后再次检查源与工程，有变化必须重新预览、重新批准。
- `--apply <planDigest>` 是调用者对这一份计划的明确写入授权；摘要不是秘密凭据。重导入没有 REST/MCP 写回入口，Host 的保存授权流程不变。
- 全程持有 Backend 原生工程锁，不能覆盖另一个 Backend 会话的未保存修改；每次内存事务和最终保存都传递当前 `expectedRevision`。

### 三方合并边界

比较「上次源生成快照」「当前磁盘工程」「本次源生成结果」，使用已保存的转换 ID。两侧生成结果都经过 Core Writer/Reader 往返，避免默认字段和图片路径产生伪变化；只有 Binding 变化也会进入计划。

- 按字段保留不重叠的编辑。固定的用户字段包括资源 `favorite`、组件 `customData`，以及节点 `locked`、`touchable`、`tooltips`、`customData`。用户的工程设置、分支、自建资源和无关文件保留。
- display list、controller pages 等有语义顺序的集合按稳定 ID/name 匹配；双方同时改变顺序或成员时停止，不猜插入位置。资源、包和文件夹的排列不是渲染顺序，保留用户顺序并追加新身份。
- 源删除了已修改的目标、同字段双边修改、身份碰撞、失效的手工语义映射或最终悬空引用都会阻塞。没有自动冲突合并或 merge editor。
- PSD State v2 记录 `source.psdIdentityUncertain`。缺失图层 ID 时使用的位置身份不能安全匹配变化后的源；重复图层 ID 直接拒绝；未记录身份信息的旧 PSD State 在源变化时停止，可另建新导入工程。图层 ID 稳定的 PSD 支持增改删。
- 保存受 Backend 事务能力和 UAM 保真检查限制，例如不支持的跨包图片引用会出现在 `blockers`。保留字段的保证限于 Core/UAM 支持的工程语义，不保证保留 Core Reader 已丢弃的私有 XML 扩展。读取不完整或出现 error 诊断时停止。

### 提交与失败恢复

使用 Backend 的 `removePackage` / `addPackage` 快照事务，不维护另一套属性写入协议。因为 Backend 不允许同批删除并重建仍被引用的包，CLI 私有会话分两次 revision 完成移除和重建；中间状态只在内存，不保存、不暴露给 Host。最终完整引用校验通过后只调用一次 `saveSession`。

工程通过原生 `runProjectWriteTransaction` 的 staged filesystem 写入，并重新读取验证暂存工程。Backend 只暂存并提交工程自有条目（`*.fairy`、`settings`、`assets*`），因此生成快照和 State 先写到工程旁的 `.工程名.maker-import-*`，在 Backend 提交前一刻换入工程，随后 Backend 逐项提交工程条目。新 baseline 必须是纯源生成结果，不能吸收用户编辑，否则下一轮冲突会漏报。没有变更时也不使用 force-save。

受控异常（包括快照/State 写入失败和 Backend 提交中途失败）由 Backend 回滚已换入的工程条目，Maker 换回旧 State，工程与 State 一起恢复；旧 State 无法换回时报错并指出保存它的目录。失败时若源或外部文件已改变，保留这些外部改变并重新预览。

这一保证不覆盖断电或进程被强杀：State 换入与原生逐项提交都由多次 rename 组成，各步之间有窗口。异常终止后若同级留有 `.工程名.save-backup-*`、`.工程名.save-*` 或 `.工程名.maker-import-*`，先停止相关进程并备份这些目录，再用 backup 中的工程条目和 `.工程名.maker-import-*/backup` 中的旧 State 一起恢复原工程，然后重跑 `--dry-run`；不要把旧 State 与新工程条目混用，也不要在残留未恢复时再次写回。原生 advisory lock 能排除协作的 Backend 写入，但锁不住任意第三方编辑器。

## 测试与基线

- 单元测试：`test/design-import/*.test.ts`（转换、Draft Store、Bundle、保真、重导入、路径与 CLI 命令）。
- 浏览器烟测：`scripts/semantic-fidelity-smoke.ts`、`import-text-smoke.ts`、`import-iteration-smoke.ts`、`import-recovery-smoke.ts`，由 `pnpm test:browser` 运行。
- 安装包烟测：`scripts/release-smoke.mjs` 从真实安装包比较两次全新导入的文件字节，并调用重导入的预览与应用。

语义保真 Golden 为每个平台 8 张 460×350 图片：Viewer/Player 两种 Runtime × 按钮四态，含订单标题、金额、按钮文字和双行 List。Windows 使用 `semantic-<runtime>-<state>.png`，Linux 使用同名 `.linux.png`；每种 Runtime 各自要求零像素差异，不要求两种 Runtime 相互一致。测试预载 `@fontsource-variable/geist@5.3.0` 的 Latin variable WOFF2（SHA-256 `19f9c92546aa300c312235e3125af1b81394d8db9a4bc4a425cd5b641d2d54e1`），不发远程字体请求；固定字体只覆盖这个 Latin fixture，不覆盖系统字体、中文、复杂脚本或 Photoshop 合成。Linux 基线取自 [CI 34192023956](https://github.com/OpenFairyGUI/FairyGUI-Maker/actions/runs/34192023956)（提交 `81b052c`，Ubuntu 24.04、Playwright 1.62.1、Chromium 151.0.7922.34）的 actual PNG，经人工检查后加入。更新 Golden 的规则见 [CONTRIBUTING](../CONTRIBUTING.md)。
