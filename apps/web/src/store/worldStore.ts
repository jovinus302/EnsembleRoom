import { create } from 'zustand';
import type { MyAgentStatus, RoomPreview, UserDto, WorldRoom } from '@ensemble/shared';
import { api } from '../api/client';

export type WsStatus = 'idle' | 'connecting' | 'open' | 'reconnecting';

interface WorldState {
  loaded: boolean;
  users: Record<string, UserDto>;
  rooms: Record<string, WorldRoom>;
  /** 서버가 준 순서(내 Room, Our, DM, 남의 Room) */
  roomOrder: string[];
  selectedRoomId: string | null;
  /** 내 Agent의 현재 위치·상태 */
  myAgent: MyAgentStatus | null;
  wsStatus: WsStatus;
  load: () => Promise<void>;
  reset: () => void;
  applyPreview: (p: RoomPreview, myAgent?: MyAgentStatus | null) => void;
  clearUnread: (roomId: string) => void;
  select: (roomId: string) => void;
  setWsStatus: (s: WsStatus) => void;
}

export const useWorld = create<WorldState>((set, get) => ({
  loaded: false,
  users: {},
  rooms: {},
  roomOrder: [],
  selectedRoomId: null,
  myAgent: null,
  wsStatus: 'idle',
  async load() {
    const w = await api.world();
    const users: Record<string, UserDto> = {};
    for (const u of w.users) users[u.id] = u;
    users[w.me.id] = w.me;
    const rooms: Record<string, WorldRoom> = {};
    for (const r of w.rooms) rooms[r.id] = r;
    const cur = get().selectedRoomId;
    const myRoom = w.rooms.find((r) => r.kind === 'my' && r.ownerId === w.me.id);
    set({
      loaded: true,
      myAgent: w.myAgent ?? null,
      users,
      rooms,
      roomOrder: w.rooms.map((r) => r.id),
      selectedRoomId: cur && rooms[cur] ? cur : (myRoom?.id ?? w.rooms[0]?.id ?? null),
    });
  },
  reset: () => set({ loaded: false, users: {}, rooms: {}, roomOrder: [], selectedRoomId: null, myAgent: null, wsStatus: 'idle' }),
  applyPreview(p, myAgent) {
    const room = get().rooms[p.roomId];
    // myAgent가 undefined면 서버가 보내지 않은 것이므로 기존 값을 유지한다.
    const agentPatch = myAgent === undefined ? {} : { myAgent };
    if (!room) {
      if (myAgent !== undefined) set(agentPatch);
      return;
    }
    set((s) => ({ ...agentPatch, rooms: { ...s.rooms, [p.roomId]: { ...room, preview: p } } }));
  },
  clearUnread(roomId) {
    const room = get().rooms[roomId];
    if (!room?.preview.detail || room.preview.detail.unread === 0) return;
    const preview = { ...room.preview, detail: { ...room.preview.detail, unread: 0 } };
    set((s) => ({ rooms: { ...s.rooms, [roomId]: { ...room, preview } } }));
  },
  select: (roomId) => set({ selectedRoomId: roomId }),
  setWsStatus: (wsStatus) => set({ wsStatus }),
}));
