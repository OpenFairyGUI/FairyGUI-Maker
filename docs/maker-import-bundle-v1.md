# Maker Import Bundle v1

Maker Import Bundle v1 是设计源进入 FairyGUI Maker 后的确定性、可校验交换格式。它复用现有
ImportDocument，不定义第二套设计模型，也不包含 Agent 推断的 Button、GList 或 Controller 语义。

## 可直接运行的完整示例

安装包随附 [minimal-bundle](./examples/minimal-bundle/maker-import.json)：完整的 [fixture.json](./examples/minimal-bundle/fixture.json)、[manifest](./examples/minimal-bundle/maker-import.json) 和 [SVG 资源](./examples/minimal-bundle/assets/000001.svg)，可直接导入，无需源码或测试夹具。

```powershell
$bundle = Join-Path (npm root) "@openfairygui/fairygui-maker/docs/examples/minimal-bundle"
fairygui-maker import inspect $bundle --data-dir .maker-example-data
fairygui-maker import plan $bundle --out example-plan.json --data-dir .maker-example-data
fairygui-maker import $bundle --dry-run --data-dir .maker-example-data
fairygui-maker import $bundle --out example-output --data-dir .maker-example-data
fairygui-maker view example-output --data-dir .maker-example-data
```

`example-plan.json` 和 `example-output` 必须尚不存在。源码 checkout 可将 `$bundle` 改为 `docs/examples/minimal-bundle`，命令改为 `node scripts/fairygui-maker.mjs ...`（先构建）。示例生成一个 320×160 的 Main 组件，包含 “Hello Maker” 可编辑文本和一个图标。它是人工编写的教学 IR，`source.kind: raster` 与 `source.sha256` 追踪随附 SVG 的实际字节，不代表从 Figma/PSD 服务导出的真实设计。

只检查时用前三条命令；视觉表现仍需 Viewer 验证。精确的 `fixture.json` 字段、必填 null/空数组及节点引用规则见 [ImportDocument v1 完整字段参考](./import-document-v1.md)。不要把其他文件放进 Bundle 目录；修改任何文档/资源字节后必须重新计算 manifest 中对应的 SHA-256 和 byteLength（以字节计，不能用字符串长度）。

## 目录结构

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

## Manifest

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

`source.kind` 固定为 `fig`、`psd`、`figma-rest` 或 `raster`。Bundle 不内嵌原设计源；
`source.sha256` 由读取原始字节的 Adapter 计算，用于来源追踪。

每个 ImportImage 必须且只能有一个 binding：

- `pixelRatio` 是资源像素与 FairyGUI 逻辑单位的倍率，必须大于零。
- `trimOffset` 是从未裁切源节点左上角到切图内容左上角的逻辑单位偏移。
- `scale9Grid` 是相对未裁切源节点的逻辑单位矩形，必须完整落在节点边界内。
- 多个节点可以绑定同一个内容去重后的资源。

## 确定性与信任边界

- Serializer 固定资源编号、排序、JSON 缩进和结尾换行；相同输入产生相同文件字节。
- Manifest 最大 1 MiB，`fixture.json` 最大 16 MiB，资源总量最大 512 MiB。
- Reader 校验 manifest、document 和全部 assets 的字节数与 SHA-256。
- Reader 拒绝额外文件、缺失文件、路径穿越、重复内容资源、重复/错序 binding 和节点错绑。
- ImportDocument 自带的 diagnostics 保存在 `fixture.json`，不在 manifest 中复制。

Fixture 在创建目标工程前还会检查结构预算：最多 100 页、每页 1,000 个根、全局 10,000 个节点、
节点深度 100；普通集合最多 10,000 项，variantProperties 最多 256 项，单节点最多 4,096 个
Text Run、256 个 Override、32 个 Shadow，Override targetPath 最多 32 项。
普通字符串最多 1,024 个 UTF-16 code unit，诊断 message 最多 16,384，text 最多 1 Mi；
整个 JSON（包括字段名和未使用字段）的字符串合计最多 4 Mi，值与键合计最多 1,000,000 项。
图片按节点引用累计最多 512 MiB，避免重复引用同一资源放大解析内存。
Text Run 使用 UTF-16 索引，必须为非空整数区间，满足 `0 <= start < end <= text.length`，
按 start 排序且不重叠；允许未指定样式的间隙。

语义 Overlay 已落地为独立的 `MakerSemanticOverlayV1`：`nodes` 以 ImportDocument 节点 ID
关联源节点，由 Draft 保存并进入 BuildPlan；它不属于 Bundle v1 manifest，也不改写源文档。
重导入的 ID 复用与冲突检查由 State v2 负责，不在 Bundle 层实现人工编辑的三方合并。

T5 在 ImportDocument v1 中增加可选的文本 `fontStyle/fontPostScriptName`、Frame `sourceLayout`
和有界 `interactions` 元数据，旧 Fixture 仍可读取。字体解析、组件库映射和栅格策略属于独立 Overlay，
不是 Bundle manifest 字段；可执行范围、Plan API 与视觉证据见[导入语义与视觉保真](./import-fidelity.md)。
