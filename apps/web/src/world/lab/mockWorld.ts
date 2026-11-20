import {
  glassClarity,
  USER_COLORS,
  type AmbienceStage,
  type RoomInfo,
  type VisitRef,
  type WorldRoom,
} from '@ensemble/shared';
import type { WorldUser } from '../types';
import type { BoardToolProp } from '../boardToolScene';

/** /lab용 고정 mock 월드. 시드(Alice·Bob·엄마·아빠·Dana)와 같은 구성 */
export const MOCK_USERS: Record<string, WorldUser> = {
  u_alice: { id: 'u_alice', name: 'Alice', color: USER_COLORS.coral },
  u_bob: { id: 'u_bob', name: 'Bob', color: USER_COLORS.sky },
  u_mom: { id: 'u_mom', name: '엄마', color: USER_COLORS.pink },
  u_dana: { id: 'u_dana', name: 'Dana', color: USER_COLORS.yellow },
  u_dad: { id: 'u_dad', name: '아빠', color: USER_COLORS.green },
};

export const MOCK_ROOMS: RoomInfo[] = [
  { id: 'my_alice', kind: 'my', ownerId: 'u_alice', title: 'My Room', theme: 'studio', themeVariant: null, memberIds: [] },
  { id: 'my_bob', kind: 'my', ownerId: 'u_bob', title: 'My Room', theme: 'lounge', themeVariant: null, memberIds: [] },
  { id: 'my_mom', kind: 'my', ownerId: 'u_mom', title: 'My Room', theme: 'lounge', themeVariant: null, memberIds: [] },
  { id: 'my_dana', kind: 'my', ownerId: 'u_dana', title: 'My Room', theme: 'studio', themeVariant: null, memberIds: [] },
  { id: 'my_dad', kind: 'my', ownerId: 'u_dad', title: 'My Room', theme: 'lounge', themeVariant: null, memberIds: [] },
  { id: 'our_friends', kind: 'our', ownerId: null, title: '친구들', theme: 'cafe', themeVariant: 'meeting', memberIds: ['u_alice', 'u_bob', 'u_dana'] },
  { id: 'our_family', kind: 'our', ownerId: null, title: '우리 가족', theme: 'cafe', themeVariant: 'home', memberIds: ['u_alice', 'u_mom', 'u_dad'] },
  { id: 'our_work', kind: 'our', ownerId: null, title: '프로젝트', theme: 'cafe', themeVariant: 'meeting', memberIds: ['u_alice', 'u_bob'] },
];

const my = (id: string, owner: string, theme: 'studio' | 'lounge'): RoomInfo => ({
  id,
  kind: 'my',
  ownerId: owner,
  title: 'My Room',
  theme,
  themeVariant: null,
  memberIds: [],
});
const our = (id: string, title: string, memberIds: string[], themeVariant: 'meeting' | 'home' = 'meeting'): RoomInfo => ({
  id,
  kind: 'our',
  ownerId: null,
  title,
  theme: 'cafe',
  themeVariant,
  memberIds,
});

/** 배치·관 라우팅 검증용 장면(?scene=). 기본 seed는 MOCK_ROOMS와 같다 */
export type MockSceneName = 'seed' | 'min' | 'k22' | 'wide' | 'ours6';
export const MOCK_SCENES: Record<MockSceneName, RoomInfo[]> = {
  seed: MOCK_ROOMS,
  min: [my('my_alice', 'u_alice', 'studio'), my('my_bob', 'u_bob', 'lounge'), our('our_work', '프로젝트', ['u_alice', 'u_bob'])],
  k22: [
    my('my_alice', 'u_alice', 'studio'),
    my('my_bob', 'u_bob', 'lounge'),
    my('my_dana', 'u_dana', 'studio'),
    our('our_friends', '친구들', ['u_alice', 'u_bob', 'u_dana']),
    our('our_trip', '여행', ['u_alice', 'u_bob', 'u_dana']),
  ],
  wide: [
    my('my_alice', 'u_alice', 'studio'),
    my('my_bob', 'u_bob', 'lounge'),
    my('my_mom', 'u_mom', 'lounge'),
    my('my_dana', 'u_dana', 'studio'),
    my('my_dad', 'u_dad', 'lounge'),
    our('our_friends', '친구들', ['u_alice', 'u_bob', 'u_dana']),
    our('our_family', '우리 가족', ['u_alice', 'u_mom', 'u_dad'], 'home'),
    our('our_work', '프로젝트', ['u_alice', 'u_bob']),
    our('our_book', '독서 모임', ['u_alice', 'u_mom', 'u_dana'], 'home'),
  ],
  ours6: [
    my('my_alice', 'u_alice', 'studio'),
    my('my_bob', 'u_bob', 'lounge'),
    ...[1, 2, 3, 4, 5, 6].map((i) => our(`our_${i}`, `모임 ${i}`, ['u_alice', 'u_bob'])),
  ],
};

export const DEFAULT_AMBIENCE: Record<string, AmbienceStage> = {
  my_alice: 'occupied',
  my_bob: 'agentOnly',
  my_mom: 'empty',
  my_dana: 'occupied',
  my_dad: 'empty',
  our_friends: 'occupied',
  our_family: 'empty',
  our_work: 'attention',
};

/** 시점·방문·조명 상태에서 서버가 주는 WorldRoom(preview 포함) 모양을 만든다 (유리는 shared의 glassClarity) */
export function buildMockRooms(
  viewerId: string,
  visits: readonly VisitRef[],
  ambience: Readonly<Record<string, AmbienceStage>>,
  scene: MockSceneName = 'seed',
): WorldRoom[] {
  return (MOCK_SCENES[scene] ?? MOCK_ROOMS).map((r) => ({
    ...r,
    preview: {
      roomId: r.id,
      ambience: ambience[r.id] ?? 'occupied',
      glass: glassClarity(viewerId, r, visits),
      detail: null,
    },
  }));
}

/** /lab용 가짜 보드 도구(?tools=0 끔, ?tools=4 네 개). 실제 앱에서는 포커스된 Room 모델에서 온다 */
export const MOCK_TOOLS: BoardToolProp[] = [
  { id: 'lab_t_ladder', kind: 'ladder', title: '오늘 커피 누가 살까?', ran: false, createdSeq: 10 },
  { id: 'lab_t_settle', kind: 'settlement', title: '지난주 영화 정산', ran: false, createdSeq: 11 },
  { id: 'lab_t_trip', kind: 'trip', title: '토요일 가족 점심', ran: false, createdSeq: 12 },
  { id: 'lab_t_custom', kind: 'custom', title: '점심 투표', ran: false, createdSeq: 13 },
  { id: 'lab_t_ladder2', kind: 'ladder', title: '회고 역할 정하기', ran: true, createdSeq: 14 },
];
