import { create } from 'zustand';
import type { TourId } from './tourSteps';

interface TourState {
  active: TourId | null;
  open: (id: TourId) => void;
  close: () => void;
}

export const useTour = create<TourState>((set) => ({
  active: null,
  open: (id) => set({ active: id }),
  close: () => set({ active: null }),
}));

/** 사용자별 완료/건너뛰기 기록. localStorage가 막혀 있어도 앱은 동작해야 한다(그 세션에서만 기억). */
const memory = new Set<string>();
const key = (userId: string, id: TourId) => `ensemble.guide.v1.${userId}.${id}`;

export function hasSeenTour(userId: string, id: TourId): boolean {
  if (memory.has(key(userId, id))) return true;
  try {
    return localStorage.getItem(key(userId, id)) !== null;
  } catch {
    return false;
  }
}

export function markTourSeen(userId: string, id: TourId, how: 'done' | 'skipped'): void {
  memory.add(key(userId, id));
  try {
    localStorage.setItem(key(userId, id), how);
  } catch {
    /* 저장소를 못 쓰면 이번 세션만 기억한다 */
  }
}
