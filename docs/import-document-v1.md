# ImportDocument v1：fixture.json 完整字段参考

这是 Maker Import Bundle v1 中 `fixture.json` 的 JSON 线格式，与内存中的 ImportDocument 使用同一模型；唯一的图片载荷差异是 JSON 用 `asset` 相对路径，内存用 `bytes: Uint8Array`。不要在 JSON 中写 `bytes`、Base64、浏览器 URL 或 FairyGUI XML。Bundle 外层版本在 `maker-import.json`，`fixture.json` 本身没有 schemaVersion。

除明确标为“可选”的字段外，下表字段均必须提供。可空字段写 `null`，空集合写 `[]` 或 `{}`，不能靠省略字段获得默认值。未识别字段不构成受支持的扩展协议。导入时仍以真实 Reader/Planner/Compiler 的校验与诊断为准；本参考不增加另一套验证器。

## 文档、页面与身份

```json
{
  "name": "Example",
  "pages": [{ "id": "page-main", "name": "Demo", "roots": [] }],
  "diagnostics": []
}
```

上面只展示外层结构；可编译的非空示例见 [完整 fixture.json](./examples/minimal-bundle/fixture.json)。pages 必须非空，每页必须含 roots 数组，roots 的每一项必须是 frame。页面 ID 在文档中唯一；所有节点 ID 在整份文档中唯一。Adapter 应提供非空、稳定的源 ID，不能用当前位置或显示名猜测跨版本身份。节点数组顺序保留层叠/排列语义。

diagnostics 的每一项必须含字符串 `code`、`message`、`nodeId`，以及 `severity: "warning" | "error"`；可选字符串为 `nodeName`、`nodeType`、`pageId`、`pageName`、`rootId`、`rootName`。没有诊断时写 `[]`。

## 所有节点的公共字段

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

## Frame

除公共字段外：

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

## Text

| 字段 | 类型 / 约束 |
|---|---|
| text、fontFamily、color | 字符串；文字、字体名、颜色（示例 `#172033`） |
| fontSize | 有限数；使用有效的正字号 |
| fontStyle、fontPostScriptName（可选） | 字符串：源字体证据 |
| align | `left / center / right` |
| verticalAlign | `top / middle / bottom` |
| lineHeight | 有限数或 `null` |
| letterSpacing | 有限数，通常为 0 |
| autoSize | `none / both / height / ellipsis` |
| singleLine、bold、italic、underline、strikethrough | 布尔值 |
| runs | Text Run 数组；纯文本写 `[]` |
| shadow | `null` 或 Shadow 对象 |

每个 Text Run 均需 `start`、`end`（UTF-16 整数索引），字符串 `fontFamily`、`color`，正有限数 `fontSize`，布尔值 `bold`、`italic`、`underline`、`strikethrough`。满足 `0 <= start < end <= text.length`，按 start 排序、不重叠；允许未指定 run 的间隙，不做隐式样式继承补字段。

Shadow 的完整字段是 `{color: string, offsetX: number, offsetY: number}`。不支持在这里填写 blur/spread。

## Shape

| 字段 | 类型 / 约束 |
|---|---|
| shape | `rectangle / ellipse / polygon` |
| fillColor | 颜色字符串 |
| strokeColor | 颜色字符串或 `null` |
| strokeWidth | 非负有限数 |
| cornerRadius | 四个有限数的数组或 `null` |
| points | `null` 或有限数数组 `[x0,y0,x1,y1,...]` |
| shadows | Shadow 数组，最多 32 项；没有阴影写 `[]` |

polygon 至少需要三对坐标、坐标数为偶数，cornerRadius 必须是 null。rectangle/ellipse 的 points 必须是 null。

## Image

图片节点的额外字段只有 `format: "png" | "svg"` 和 `asset: "assets/000001.svg"`。资源名为六位数字加 png/svg 扩展名，扩展名必须与 format 一致。资源非空，必须在 manifest.assets 声明，并且每个图片节点必须由 manifest.bindings 的 sourceNodeId 精确绑定同一路径。不同节点可以引用同一去重资源。

图片逻辑尺寸来自公共 width/height，像素比例、trimOffset 和 scale9Grid 来自 manifest binding。完整 binding 字段与矩形约束见 [Bundle v1](./maker-import-bundle-v1.md)。

## Instance 与 Override

Instance 额外字段为 `componentId: string`、`overrides: []`。componentId 必须引用同一 fixture 中某个 `sourceType: "component"` Frame 的源 ID，不是导入后的 FairyGUI resource ID。没有覆盖写空数组。

每个 Override 必须提供全部下列字段；不修改的字段写 null：

| 字段 | 类型 |
|---|---|
| targetId | 字符串 |
| targetPath | 字符串数组，最多 32 项 |
| componentId、name、text、fillColor、strokeColor、fontFamily | 字符串或 null |
| visible、bold、italic、underline、strikethrough | 布尔值或 null |
| opacity、width、height、strokeWidth、fontSize | 有限数或 null |
| cornerRadius | 四个有限数的数组或 null |

targetId/targetPath 以源组件内部的稳定节点身份定位；替换 componentId 同样使用源组件身份。实际可执行覆盖仍受编译器支持范围与依赖校验约束。

## 预算和验证入口

最多 100 页、每页 1,000 roots、全局 10,000 节点、节点深度 100；每个 Text 最多 4,096 runs，每个 Instance 最多 256 overrides，每个 variantProperties 最多 256 项。普通字符串最多 1,024 UTF-16 code units，text 最多 1 Mi，诊断 message 与 interaction.source 最多 16,384；interaction.trigger/action 最多 128。整个 JSON 字符串合计最多 4 Mi，值与键合计最多 1,000,000。

先运行 `fairygui-maker import inspect <bundle>` 验证外层文件摘要与 IR 结构，再运行 `fairygui-maker import <bundle> --dry-run` 验证实际规划/编译，最后在 Viewer 检查画面。inspect 和 dry-run 写私有 Draft，但不写目标工程。Bundle 字节与引用预算、跨版本兼容说明见 [Bundle v1](./maker-import-bundle-v1.md)。
