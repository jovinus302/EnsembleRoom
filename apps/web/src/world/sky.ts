import { useSyncExternalStore } from 'react';
import * as THREE from 'three';

/**
 * sunset_1k.hdr의 태양은 방위 u=0.599(atan2(z,x)=+35.6deg), 고도 3.5deg에 있다(픽셀 분석으로 측정).
 * 환경 맵을 y축으로 돌려 태양이 카메라(+z)에서 보아 월드 안쪽(-z), 살짝 왼쪽 뒤에 오게 한다 → 캡슐이 역광을 받는다.
 */
const HDR_SUN_AZIMUTH = (0.5992810599964234 - 0.5) * Math.PI * 2;
const TARGET_AZIMUTH = -Math.PI / 2 - 0.2; // atan2(z,x). -90deg = 정면 안쪽
export const ENV_ROTATION_Y = HDR_SUN_AZIMUTH - TARGET_AZIMUTH;
/** 조명용 태양 고도(라디안). 실제 3.5deg보다 높여 그림자가 읽히게 한다 */
export const SUN_ELEVATION = THREE.MathUtils.degToRad(15);
export const SUN_DIRECTION = new THREE.Vector3(
  Math.cos(TARGET_AZIMUTH) * Math.cos(SUN_ELEVATION),
  Math.sin(SUN_ELEVATION),
  Math.sin(TARGET_AZIMUTH) * Math.cos(SUN_ELEVATION),
);
/** 하늘에 그려지는 태양 원반의 방향(HDRI의 표시용 고도 6.5deg). 조명 방향(SUN_DIRECTION)과 방위가 같다 */
const SUN_VIS_EL = THREE.MathUtils.degToRad(6.5);
export const SUN_VISUAL_DIRECTION = new THREE.Vector3(
  Math.cos(TARGET_AZIMUTH) * Math.cos(SUN_VIS_EL),
  Math.sin(SUN_VIS_EL),
  Math.sin(TARGET_AZIMUTH) * Math.cos(SUN_VIS_EL),
);
export const FOG_COLOR = '#e9a67c';

/**
 * 하늘·바다·모래(HDRI 로딩 뒤 마운트)가 화면에 올라왔는가. 월드 캔버스는 이게 true가 되기 전에는 투명(opacity 0)이라
 * 검은 첫 프레임이 보이지 않고, 인트로 카메라도 이 뒤에 시작한다.
 * introActive: 인트로 연출 중(이름표 칩은 끝난 뒤에 나타난다).
 */
export const skyState = { ready: false, introActive: false };
const subs = new Set<() => void>();
export function patchSky(p: Partial<typeof skyState>): void {
  let changed = false;
  for (const k of Object.keys(p) as (keyof typeof skyState)[]) {
    if (skyState[k] !== p[k]) {
      skyState[k] = p[k]!;
      changed = true;
    }
  }
  if (changed) subs.forEach((f) => f());
}
export function useSkyFlag(k: keyof typeof skyState): boolean {
  return useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => subs.delete(f);
    },
    () => skyState[k],
  );
}
