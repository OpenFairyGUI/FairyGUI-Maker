# Maker Import Bundle v1

Maker Import Bundle v1 是设计源进入 FairyGUI Maker 后的确定性、可校验交换格式。它复用现有
ImportDocument，不定义第二套设计模型，也不包含 Agent 推断的 Button、GList 或 Controller 语义。

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

Agent 语义 Overlay 后续以 `sourceNodeId` 关联 Bundle，但不属于 v1。重新生成默认创建新的 Maker
Draft/Revision，不在 Bundle 层实现人工编辑的三方合并。
