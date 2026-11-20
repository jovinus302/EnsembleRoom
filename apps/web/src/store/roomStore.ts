import { create } from 'zustand';
import type { AgentDto, RoomEvent, RoomSnapshot } from '@ensemble/shared';

/** 낙관적으로 보낸 메시지. 같은 clientId의 이벤트가 도착하면 사라진다. */
export interface PendingMessage {
  clientId: string;
  roomId: string;
  text: string;
  to?: string;
  /** sending: 서버 응답 대기, acked: seq 확정(이벤트 수신 대기), failed: 실패(재시도 가능) */
  status: 'sending' | 'acked' | 'failed';
  seq?: number;
  error?: string;
  createdAt: number;
}

export interface RoomSlice {
  /** seq 오름차순, seq로 중복 제거 */
  events: RoomEvent[];
  agents: AgentDto[];
  lastSeq: number;
  snapshotLoaded: boolean;
  presence: string[];
}

const emptySlice = (): RoomSlice => ({ events: [], agents: [], lastSeq: 0, snapshotLoaded: false, presence: [] });

/** seq 중복을 제거하며 병합한다 (WS 이벤트와 snapshot이 겹쳐도 안전) */
export function mergeEvents(base: readonly RoomEvent[], incoming: readonly RoomEvent[]): RoomEvent[] {
  if (incoming.length === 0) return base as RoomEvent[];
  const bySeq = new Map<number, RoomEvent>();
  for (const e of base) bySeq.set(e.seq, e);
  for (const e of incoming) bySeq.set(e.seq, e);
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

interface RoomStoreState {
  rooms: Record<string, RoomSlice>;
  pending: PendingMessage[];
  applySnapshot: (roomId: string, snap: RoomSnapshot) => void;
  applyEvent: (e: RoomEvent) => void;
  setPresence: (roomId: string, userIds: string[]) => void;
  addPending: (p: PendingMessage) => void;
  updatePending: (clientId: string, patch: Partial<PendingMessage>) => void;
  removePending: (clientId: string) => void;
  ack: (clientId: string, seq: number) => void;
  reset: () => void;
}

const pendingResolved = (p: PendingMessage, events: readonly RoomEvent[]) =>
  events.some((e) => e.type === 'message' && e.clientId === p.clientId);

export const useRooms = create<RoomStoreState>((set) => ({
  rooms: {},
  pending: [],
  applySnapshot(roomId, snap) {
    set((s) => {
      const cur = s.rooms[roomId] ?? emptySlice();
      const events = mergeEvents(cur.events, snap.events);
      const slice: RoomSlice = {
        ...cur,
        events,
        agents: snap.agents,
        lastSeq: Math.max(cur.lastSeq, snap.lastSeq, events.at(-1)?.seq ?? 0),
        snapshotLoaded: true,
      };
      return {
        rooms: { ...s.rooms, [roomId]: slice },
        pending: s.pending.filter((p) => p.roomId !== roomId || !pendingResolved(p, events)),
      };
    });
  },
  applyEvent(e) {
    set((s) => {
      const cur = s.rooms[e.roomId] ?? emptySlice();
      if (cur.events.some((x) => x.seq === e.seq)) return s;
      const events = mergeEvents(cur.events, [e]);
      return {
        rooms: { ...s.rooms, [e.roomId]: { ...cur, events, lastSeq: Math.max(cur.lastSeq, e.seq) } },
        pending:
          e.type === 'message' && e.clientId ? s.pending.filter((p) => p.clientId !== e.clientId) : s.pending,
      };
    });
  },
  setPresence(roomId, userIds) {
    set((s) => ({ rooms: { ...s.rooms, [roomId]: { ...(s.rooms[roomId] ?? emptySlice()), presence: userIds } } }));
  },
  addPending: (p) => set((s) => ({ pending: [...s.pending, p] })),
  updatePending: (clientId, patch) =>
    set((s) => ({ pending: s.pending.map((p) => (p.clientId === clientId ? { ...p, ...patch } : p)) })),
  removePending: (clientId) => set((s) => ({ pending: s.pending.filter((p) => p.clientId !== clientId) })),
  ack(clientId, seq) {
    set((s) => {
      const p = s.pending.find((x) => x.clientId === clientId);
      if (!p) return s;
      // 이벤트가 이미 도착했으면 pending을 제거, 아니면 acked로 표시
      const slice = s.rooms[p.roomId];
      if (slice?.events.some((e) => e.seq === seq)) return { pending: s.pending.filter((x) => x.clientId !== clientId) };
      return { pending: s.pending.map((x) => (x.clientId === clientId ? { ...x, status: 'acked', seq } : x)) };
    });
  },
  reset: () => set({ rooms: {}, pending: [] }),
}));
