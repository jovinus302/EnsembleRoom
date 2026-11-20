import { create } from 'zustand';
import type { BoardToolKind } from '@ensemble/shared';

/**
 * 3D 탁자 소품이 그릴 도구 목록(Room별). 데이터는 포커스된 Room 모델(접근 확인된 스냅샷)에서만 채워진다 —
 * 서리 낀 방·조망의 다른 방에는 값이 오지 않으므로 소품이 구조적으로 보이지 않는다.
 */
export interface BoardToolProp {
  id: string;
  kind: BoardToolKind;
  title: string;
  /** 사다리: 이미 실행됨(소품 표시만 바뀐다) */
  ran: boolean;
  createdSeq: number;
}

interface BoardToolSceneState {
  byRoom: Record<string, BoardToolProp[]>;
  /** 포커스 중에 새로 생긴 도구 id(처음 채워질 때 이미 있던 도구는 포함하지 않는다) → 등장 애니메이션 대상 */
  fresh: Record<string, string[]>;
  setRoom: (roomId: string, props: BoardToolProp[]) => void;
  clear: (roomId?: string) => void;
}

export const useBoardToolScene = create<BoardToolSceneState>((set) => ({
  byRoom: {},
  fresh: {},
  setRoom: (roomId, props) =>
    set((s) => {
      const prev = s.byRoom[roomId];
      const prevIds = new Set(prev?.map((t) => t.id));
      const added = prev ? props.filter((t) => !prevIds.has(t.id)).map((t) => t.id) : [];
      return {
        byRoom: { ...s.byRoom, [roomId]: props },
        fresh: { ...s.fresh, [roomId]: [...(s.fresh[roomId] ?? []), ...added] },
      };
    }),
  clear: (roomId) =>
    set((s) => {
      if (!roomId) return Object.keys(s.byRoom).length ? { byRoom: {}, fresh: {} } : s;
      if (!(roomId in s.byRoom)) return s;
      const { [roomId]: _gone, ...rest } = s.byRoom;
      const { [roomId]: _f, ...restFresh } = s.fresh;
      return { byRoom: rest, fresh: restFresh };
    }),
}));

/** visibleBoardTools 결과를 소품 입력으로 */
export function toolProps(tools: ReadonlyArray<{ toolId: string; kind: BoardToolKind; title: string; createdSeq: number; run?: unknown }>): BoardToolProp[] {
  return tools.map((t) => ({ id: t.toolId, kind: t.kind, title: t.title, ran: !!t.run, createdSeq: t.createdSeq }));
}
