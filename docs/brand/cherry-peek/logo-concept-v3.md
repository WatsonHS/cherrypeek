# Cherry Peek Logo 概念稿 v3

日期：2026-11-10。状态：按“一高一低、叶子改成箭头”的反馈修订，尚未接入应用。

## 修订

- 左侧实心果子较低，右侧空心果子较高，调整连接它们的果梗长度。
- 顶部叶片改为与果梗相连的右上箭头。
- 延续 v2 的几何风格、樱桃红与深炭色字标；保留此前版本。

## 产物与验证

- [透明 PNG](logo-concept-v3.png)：2172 × 724，带 alpha 通道。
- 编辑输入：[v2](logo-concept-v2.png)。
- 生成方式：内置 image_gen 图像编辑工具，transparent_background=true；未使用 CLI。
- 已查看结果：两颗果子明显错位，顶部为箭头，品牌拼写正确；检查文件尺寸与 alpha 通道。
- 当前为栅格概念稿；小尺寸、深色背景及发行图标尚未验收。

## 完整提示词

```text
Use case: precise-object-edit / logo-brand.
Edit target: the attached Cherry Peek logo.
Make exactly these two user-requested changes to the emblem:
1. Stagger the two cherry/commit fruits vertically. Keep the LEFT SOLID red fruit LOWER, and move the RIGHT HOLLOW ring fruit HIGHER by approximately two-thirds of one fruit diameter. They must visibly sit at two different heights, like a natural pair of cherries on unequal stems. Adjust only the lengths of their connected stems to accommodate this. Keep both fruits the same diameter and preserve one solid, one hollow.
2. Replace the small diagonal leaf/capsule at the top with a clear simple ARROW pointing UP-RIGHT. It should be the connected terminal of the upper stem, with a recognizable arrowhead and short shaft, drawn in the same cherry red and consistent stroke weight. No leaf, no floating capsule, no separate detached arrow.
Preserve the rest: clean modern geometric style, rounded branching paths, the existing wordmark exactly "Cherry Peek", same typeface and letter spacing, same red and charcoal colors, same wordmark position, same transparent canvas and ample padding. Keep the fruit-and-stem silhouette legible as cherries combined with Git branches. Keep comfortable space between the lowest fruit and the wordmark.
Render flat solid colors and clean edges. No gradients, shadows, textures, extra text, background, app tile, or additional symbols. This is a focused revision of the supplied logo, not a new concept. Preserve actual alpha transparency.
```

