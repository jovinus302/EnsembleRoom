import { create } from 'zustand';

/** 사용자 카메라 조절(오프셋)의 최소 공유 상태. three를 불러오지 않는다(스테이지 크롬이 읽는다). */
export const useOrbit = create<{ dirty: boolean; resetSeq: number; reset: () => void }>((set) => ({
  dirty: false,
  resetSeq: 0,
  reset: () => set((s) => ({ resetSeq: s.resetSeq + 1 })),
}));

/** 조절 한계 */
export const ORBIT_MIN_ELEV_DEG = 8;
export const ORBIT_MAX_ELEV_DEG = 70;
export const ORBIT_MAX_YAW_DEG = 80;
export const ORBIT_MIN_ZOOM = 0.45;
export const ORBIT_MAX_ZOOM = 1.35;
