import {
  glassClarity,
  USER_COLORS,
  type AmbienceStage,
  type RoomInfo,
  type VisitRef,
  type WorldRoom,
} from '@ensemble/shared';
import type { WorldUser } from '../types';

/** /lab용 고정 mock 월드. 시드(Alice·Bob·엄마·Dana)와 같은 구성 */
export const MOCK_USERS: Record<string, WorldUser> = {
  u_alice: { id: 'u_alice', name: 'Alice', color: USER_COLORS.coral },
  u_bob: { id: 'u_bob', name: 'Bob', color: USER_COLORS.sky },
  u_mom: { id: 'u_mom', name: '엄마', color: USER_COLORS.pink },
  u_dana: { id: 'u_dana', name: 'Dana', color: USER_COLORS.yellow },
};

export const MOCK_ROOMS: RoomInfo[] = [
  { id: 'my_alice', kind: 'my', ownerId: 'u_alice', title: 'My Room', theme: 'studio', themeVariant: null, memberIds: [] },
  { id: 'my_bob', kind: 'my', ownerId: 'u_bob', title: 'My Room', theme: 'lounge', themeVariant: null, memberIds: [] },
  { id: 'my_mom', kind: 'my', ownerId: 'u_mom', title: 'My Room', theme: 'lounge', themeVariant: null, memberIds: [] },
  { id: 'my_dana', kind: 'my', ownerId: 'u_dana', title: 'My Room', theme: 'studio', themeVariant: null, memberIds: [] },
  { id: 'our_friends', kind: 'our', ownerId: null, title: '친구들', theme: 'cafe', themeVariant: 'meeting', memberIds: ['u_alice', 'u_bob', 'u_dana'] },
  { id: 'our_family', kind: 'our', ownerId: null, title: '우리 가족', theme: 'cafe', themeVariant: 'home', memberIds: ['u_alice', 'u_mom'] },
  { id: 'our_work', kind: 'our', ownerId: null, title: '프로젝트', theme: 'cafe', themeVariant: 'meeting', memberIds: ['u_alice', 'u_bob'] },
];

export const DEFAULT_AMBIENCE: Record<string, AmbienceStage> = {
  my_alice: 'occupied',
  my_bob: 'agentOnly',
  my_mom: 'empty',
  my_dana: 'occupied',
  our_friends: 'occupied',
  our_family: 'empty',
  our_work: 'attention',
};

/** 시점·방문·조명 상태에서 서버가 주는 WorldRoom(preview 포함) 모양을 만든다 (유리는 shared의 glassClarity) */
export function buildMockRooms(
  viewerId: string,
  visits: readonly VisitRef[],
  ambience: Readonly<Record<string, AmbienceStage>>,
): WorldRoom[] {
  return MOCK_ROOMS.map((r) => ({
    ...r,
    preview: {
      roomId: r.id,
      ambience: ambience[r.id] ?? 'occupied',
      glass: glassClarity(viewerId, r, visits),
      detail: null,
    },
  }));
}
