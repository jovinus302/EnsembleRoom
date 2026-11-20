import { create } from 'zustand';
import type { AmbienceStage } from '@ensemble/shared';
import type { RoomModel } from '../room/useRoomModel';

/** 설정 가능한 품질. 'off'는 3D를 끄고 2D 폴백만 쓴다(저사양). three를 불러오지 않도록 world/는 type으로만 참조한다. */
export type QualitySetting = 'auto' | 'high' | 'mid' | 'low' | 'off';
export const QUALITY_SETTINGS: readonly QualitySetting[] = ['auto', 'high', 'mid', 'low', 'off'];

const KEY = 'ensemble.quality';

function readQuality(): QualitySetting {
  try {
    const v = localStorage.getItem(KEY);
    if (v && (QUALITY_SETTINGS as readonly string[]).includes(v)) return v as QualitySetting;
  } catch {
    /* 저장소 사용 불가 */
  }
  return 'auto';
}

/** WebGL2 지원 여부. 컨텍스트를 만들어 보고 바로 버린다. */
export function detectWebgl2(): boolean {
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2');
    if (!gl) return false;
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return true;
  } catch {
    return false;
  }
}

interface StageState {
  quality: QualitySetting;
  /** ok: 사용 가능, unsupported: WebGL2 없음, error: 렌더 중 오류(오류 경계) */
  webgl: 'ok' | 'unsupported' | 'error';
  /** Room 화면의 "3D가 비쳐 보이는 창" DOM. 있으면 캔버스를 이 사각형에 맞춘다 */
  slotEl: HTMLElement | null;
  hoverRoomId: string | null;
  /** 타임라인 재생 중인 Room의 조명 단계(재생 값). 라이브면 비어 있다 */
  ambienceOverrides: Record<string, AmbienceStage>;
  /** 포커스된 Room의 표시 모델(RoomStage가 올린다). 3D 캐릭터가 replaySeq까지 반영된 이 모델을 읽는다 */
  focusModel: RoomModel | null;
  setFocusModel: (m: RoomModel | null) => void;
  setQuality: (q: QualitySetting) => void;
  setWebgl: (s: 'ok' | 'unsupported' | 'error') => void;
  setSlotEl: (el: HTMLElement | null) => void;
  setHover: (id: string | null) => void;
  setAmbienceOverrides: (o: Record<string, AmbienceStage>) => void;
}

export const useStage = create<StageState>((set) => ({
  quality: readQuality(),
  webgl: detectWebgl2() ? 'ok' : 'unsupported',
  slotEl: null,
  hoverRoomId: null,
  ambienceOverrides: {},
  focusModel: null,
  setFocusModel: (focusModel) => set({ focusModel }),
  setQuality(quality) {
    try {
      localStorage.setItem(KEY, quality);
    } catch {
      /* 무시 */
    }
    // 렌더 오류로 꺼진 3D는 품질 버튼을 누르면 다시 시도한다
    set((st) => ({ quality, webgl: st.webgl === 'error' ? 'ok' : st.webgl }));
  },
  setWebgl: (webgl) => set({ webgl }),
  setSlotEl: (slotEl) => set({ slotEl }),
  setHover: (hoverRoomId) => set({ hoverRoomId }),
  setAmbienceOverrides: (ambienceOverrides) => set({ ambienceOverrides }),
}));

/** 3D가 실제로 그려지는 중인가 (RoomStage가 2D 폴백을 숨길지 판단) */
export function useWorldActive(): boolean {
  return useStage((s) => s.webgl === 'ok' && s.quality !== 'off');
}
