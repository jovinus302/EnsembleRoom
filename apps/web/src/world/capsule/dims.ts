/**
 * 캡슐 치수와 내부 좌표계 (월드 단위). 캡슐 그룹의 원점은 **바닥 윗면 중심**이다.
 *  - +x: 알약 긴 축, +y: 위, +z: 카메라(관객) 쪽. 바닥은 y=0 평면의 스타디움 모양.
 *  - 미니어처 스케일: Kenney 소품 1m = MINI_SCALE 월드 단위. 소품은 `props-manifest.json`의 pivotOffset을 적용한 뒤
 *    `scale={MINI_SCALE}`로 넣는다.
 */
export const MINI_SCALE = 1.4;

export type CapsuleProportion = 'long' | 'plump';

export interface CapsuleDims {
  proportion: CapsuleProportion;
  /** 구 반지름 */
  radius: number;
  /** 원기둥 부분 길이 (전체 길이 = length + 2*radius) */
  length: number;
  /** 모래 위에서 바닥 윗면까지의 높이 */
  floorHeight: number;
  /** 바닥 스타디움: x 방향 반길이(둥근 끝 포함), z 방향 반폭 */
  floorHalfLength: number;
  floorHalfDepth: number;
  /** 바닥에서 유리 천장까지의 높이 */
  ceiling: number;
  /** 모래 위 캡슐 축의 높이 */
  axisHeight: number;
}

/** 축에서 바닥까지의 비율(반지름 대비). 0.5면 바닥 폭이 지름의 87% */
const FLOOR_DROP = 0.5;
const BASE_LIFT = 0.5;

export function capsuleDims(proportion: CapsuleProportion): CapsuleDims {
  const radius = proportion === 'plump' ? 2.7 : 1.7;
  const length = proportion === 'plump' ? 3.6 : 4.2;
  const half = Math.sqrt(1 - FLOOR_DROP * FLOOR_DROP) * radius;
  const axisHeight = radius + BASE_LIFT;
  return {
    proportion,
    radius,
    length,
    floorHeight: axisHeight - FLOOR_DROP * radius,
    floorHalfLength: length / 2 + half,
    floorHalfDepth: half,
    ceiling: radius + FLOOR_DROP * radius,
    axisHeight,
  };
}

export function totalLength(d: CapsuleDims): number {
  return d.length + 2 * d.radius;
}
