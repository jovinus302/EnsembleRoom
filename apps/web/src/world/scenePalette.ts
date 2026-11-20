/**
 * 3D 장면 색 상수. `apps/web/src/styles/themes.css`의 `--scene-*` 토큰(목업 02-tide-glass.html :root)과 동기화한다.
 * 셰이더 uniform에는 `new THREE.Color(hex)`로 넣는다(ColorManagement가 sRGB -> linear 변환).
 */
export const SKY_TOP = '#3f8fd8';
export const SKY_MID = '#7cc0ee';
export const SKY_LOW = '#d6eefa';
export const HAZE = '#e4f3fb';
export const SEA_FAR = '#0b5c8a';
export const SEA_MID = '#12a3b8';
export const SEA_SHORE = '#7fe0d2';
export const FOAM = '#ffffff';
export const SAND = '#f7efe0';
export const SAND_SHADE = '#e6d9c2';
export const SHADOW = '#1e4664';
