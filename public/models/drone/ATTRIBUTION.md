# DJI drone model

- Original title: 无人机(1)
- Author: [fh51692305](https://sketchfab.com/fh51692305)
- Source: [Sketchfab model](https://sketchfab.com/3d-models/1-812ac69bd9924e2bb24310dd03a607bf)
- License: [Creative Commons Attribution 4.0 International (CC BY 4.0)](https://creativecommons.org/licenses/by/4.0/)

This copy reduces the body normal-map JPEG from 4096 × 4096 to 2048 × 2048 at JPEG quality 92 and repacks the GLB binary buffer with four-byte alignment. Geometry, materials, transforms, and all other texture images are unchanged. This model is not endorsed by its author or DJI.

To reproduce on Windows from the original downloaded file:

```powershell
cd preview
node tools/prepare-drone.mjs D:/djiair.glb
```
