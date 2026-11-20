# tools

- `extract-demo-assets.mjs` (`npm run assets:extract`): 데모 파일에서 캐릭터·아바타·Lottie 추출.
- `import-props.mjs` (`npm run assets:props`): 3D용 소품 GLB, HDRI, 모래 텍스처, 폰트를 `assets-src/`에서 골라 `apps/web/public/assets/{props,hdri,textures,fonts}/`로 복사하고 `public/assets/props-manifest.json`을 생성한다. 재실행해도 결과가 같다.
  - `npm run assets:props -- --download`: 없는 원본을 공식 배포처(kenney.nl, polyhaven, github google/fonts)에서 받는다. 인증서 검증은 끄지 않으며, 막히면 그 출처만 건너뛰고 manifest에 `available:false`(HDRI는 `fallback:"procedural-sky"`, 모래는 `procedural-noise-shader`)로 남긴다.
  - `npm run assets:props -- --force`: 폰트 서브셋을 다시 만든다(Python `fonttools` 필요: `pip install fonttools`).
- `props-manifest.json`: 입력 목록(테마별 소품, 출처 URL, md5). 출력 manifest는 `apps/web/public/assets/props-manifest.json`.

## 수동으로 받아 둘 원본 (`assets-src/`는 gitignore)
| 출처 | 받을 파일 | 저장 위치 |
|---|---|---|
| Kenney Furniture Kit (CC0) | https://kenney.nl/assets/furniture-kit 에서 "Continue without donating..." | `assets-src/kenney-furniture-kit/kit.zip` (zip 그대로) |
| Poly Haven HDRI (CC0) | https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/1k/venice_sunset_1k.hdr | `assets-src/polyhaven-hdri/venice_sunset_1k.hdr` |
| Poly Haven 모래 (CC0) | https://dl.polyhaven.org/file/ph-assets/Textures/jpg/1k/sand_01/sand_01_diff_1k.jpg, `..._nor_gl_1k.jpg`, `..._rough_1k.jpg` | `assets-src/polyhaven-textures/` |
| Noto Sans KR (OFL) | https://github.com/google/fonts/raw/main/ofl/notosanskr/NotoSansKR%5Bwght%5D.ttf, https://raw.githubusercontent.com/google/fonts/main/ofl/notosanskr/OFL.txt | `assets-src/noto-sans-kr/NotoSansKR[wght].ttf`, `OFL.txt` |
