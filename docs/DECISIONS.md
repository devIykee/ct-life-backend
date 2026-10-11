# Decisions Log

### 2026-10-11 - Decode likeness photos with Sharp; keep originals private and transient

Use `sharp ^0.35.5` for strict PNG/JPEG decode, bounded pixel processing, orientation
correction and normalized JPEG re-encoding. Signature sniffing alone cannot reject
truncated/decompression-heavy files or strip metadata. The official release lists
0.35.5 (2026-09-27); its Node >=20.9 requirement supports this backend's Node22 floor.
The implementation uses `failOn: 'warning'`, pixel limits, libvips timeout and a wall
clock timeout, because the library's processing timeout excludes queue waiting.
No provider or public photo collection is enabled by this dependency.

Sources: [install/release requirements](https://sharp.pixelplumbing.com/install/),
[constructor limits](https://sharp.pixelplumbing.com/api-constructor/),
[output/timeout behavior](https://sharp.pixelplumbing.com/api-output/),
[orientation](https://sharp.pixelplumbing.com/api-operation/).
