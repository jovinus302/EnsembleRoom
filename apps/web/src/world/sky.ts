import { useSyncExternalStore } from 'react';
import * as THREE from 'three';
import { HAZE } from './scenePalette';

const TARGET_AZIMUTH = -Math.PI / 2 - 0.55; // atan2(z,x). -90deg = 정면 안쪽, 목업처럼 왼쪽 위
/** 조명용 태양 고도(라디안) */
export const SUN_ELEVATION = THREE.MathUtils.degToRad(40);
export const SUN_DIRECTION = new THREE.Vector3(
  Math.cos(TARGET_AZIMUTH) * Math.cos(SUN_ELEVATION),
  Math.sin(SUN_ELEVATION),
  Math.sin(TARGET_AZIMUTH) * Math.cos(SUN_ELEVATION),
);
/** 하늘에 그려지는 태양 원반의 방향. 조명 방향(SUN_DIRECTION)과 방위가 같다 */
const SUN_VIS_EL = THREE.MathUtils.degToRad(28);
export const SUN_VISUAL_DIRECTION = new THREE.Vector3(
  Math.cos(TARGET_AZIMUTH) * Math.cos(SUN_VIS_EL),
  Math.sin(SUN_VIS_EL),
  Math.sin(TARGET_AZIMUTH) * Math.cos(SUN_VIS_EL),
);
export const FOG_COLOR = HAZE;

/**
 * 하늘·바다·모래(텍스처 로딩 뒤 마운트)가 화면에 올라왔는가. 월드 캔버스는 이게 true가 되기 전에는 투명(opacity 0)이라
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
