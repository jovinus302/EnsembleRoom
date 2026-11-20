import { create } from 'zustand';

/**
 * 보드 도구 패널 열림 상태. 2D 도구 카드와 (이후) 3D 탁자 소품 클릭이 같이 쓴다.
 * 도구 데이터 자체는 RoomState.boardTools(WS 이벤트 리듀싱)에서 읽는다 — 여기엔 "어느 도구를 열었나"만 둔다.
 */
interface BoardToolUiState {
  openToolId: string | null;
  open: (toolId: string) => void;
  close: () => void;
}

export const useBoardToolUi = create<BoardToolUiState>((set) => ({
  openToolId: null,
  open: (toolId) => set({ openToolId: toolId }),
  close: () => set({ openToolId: null }),
}));
