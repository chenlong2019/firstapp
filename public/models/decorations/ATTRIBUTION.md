# Chinese knot asset

- Original: **Dreaming Knot (Chinese knot)**
- Author: [IForgetHowToRead](https://sketchfab.com/dirb)
- Source: https://sketchfab.com/3d-models/dreaming-knot-chinese-knot-5097ce74eee6430e8a5b596c04c77a4e
- License: [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)

Modified for this preview: extracted the independent `knot:knot_2` assembly,
removed its display pose, oriented upright, moved the origin to the hanging loop,
retained vertex colours, simplified geometry and replaced the unlit material with
a rough PBR thread material. The downloaded original is not overwritten.

Build command (from `preview`):

```powershell
node tools/prepare-chinese-knot.mjs 'D:\dreaming_knot_chinese_knot-.glb'
```

The generated GLB is uncompressed and needs no Meshopt decoder at runtime.
`meshoptimizer` is used only in the offline preparation script. Source hash and
geometry statistics are in `chinese-knot.source.json`.

The same tool also emits `chinese-knot-medium.glb` and `chinese-knot-far.glb`.
All levels retain the source hanging anchor and vertex colours; LOD statistics
and simplification errors are in `chinese-knot.lods.json`.

The source's curled tassel meshes have been replaced with procedural silk fibres
attached to four measured terminal positions, with wrapped cuffs and graded LOD
strand density. The original flared lower gold connectors and green beads are
replaced by downward double cords, interlaced loops and rounded beads. The red
crossbar and all upper woven parts remain derived from the source.
Runtime adds small GPU pendulum/breeze motion with a fixed top anchor and bending
from each red-crossbar mount through the connector and each tassel's own bead root.
This is approximate decorative motion rather
than a full cloth simulation. The procedural replacement is an adaptation of the
asset; source attribution above continues to apply to the resulting decoration.
