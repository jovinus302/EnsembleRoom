import type { RoomKind, VisitStatus, VisitorKind } from './events';

/**
 * 시점(viewer) 기준 계산 (계획 8.3). 서버(world 미리보기)와 웹(캡슐 라벨·유리·배치)이 같은 함수를 쓴다.
 * 같은 Room도 Alice 창과 Bob 창에서 mine/yours가 반대로 나온다.
 */

export type Relation = 'mine' | 'yours' | 'ours';

export interface RoomRef {
  id: string;
  kind: RoomKind;
  /** my Room 소유자. our/dm은 null */
  ownerId: string | null;
  /** our/dm 구성원 */
  memberIds: readonly string[];
  title: string;
}

/** 내 Room은 mine, 남의 My Room은 yours, Our(와 DM)는 ours. Our 캡슐의 유리 투명도는 `glassClarity`가 따로 판단한다 */
export function relation(viewerId: string, room: Pick<RoomRef, 'kind' | 'ownerId'>): Relation {
  if (room.kind === 'my') return room.ownerId === viewerId ? 'mine' : 'yours';
  return 'ours';
}

/** 벽 간판·목록 라벨. mine → "My Room", yours → "<이름>의 Room", ours → Room 제목 */
export function roomLabel(
  viewerId: string,
  room: Pick<RoomRef, 'kind' | 'ownerId' | 'title'>,
  nameOf: (userId: string) => string,
): string {
  switch (relation(viewerId, room)) {
    case 'mine':
      return 'My Room';
    case 'yours':
      return `${nameOf(room.ownerId!)}의 Room`;
    case 'ours':
      return room.title;
  }
}

/** clear=투명(구성원·사람 방문), frosted=서리, agent=내 Agent가 방문 중인 남의 Room(옅은 서리가 남는 'agent 시야') */
export type GlassClarity = 'clear' | 'frosted' | 'agent';
export const GLASS_CLARITIES: readonly GlassClarity[] = ['clear', 'frosted', 'agent'];
/** 서리 ↔ 투명 전환 시간(초). 와이프가 눈에 보이도록 1.8s (웹 CapsuleShell이 그대로 쓴다) */
export const GLASS_TRANSITION_SECONDS = 1.8;

export interface VisitRef {
  hostRoomId: string;
  visitorKind: VisitorKind;
  visitorUserId: string;
  status: VisitStatus;
}

/**
 * 유리 = 경계 (소유, 권한, 기억이 1:1).
 * - 내 캡슐, 내가 구성원인 Our 캡슐: 투명
 * - 남의 캡슐: 서리 유리
 * - 내가 한 사람 방문이 수락돼 활성이면 그 캡슐은 투명, 끝나면 다시 서리
 * - 내 Agent의 방문이 활성이면 'agent'(옅은 서리 + 뷰어 색 림). 사람 방문의 clear가 우선한다. 끝나면 다시 서리.
 *   미리보기 detail은 어느 경우든 남의 캡슐에 주지 않는다(서버 previewFor).
 */
export function glassClarity(
  viewerId: string,
  room: Pick<RoomRef, 'id' | 'kind' | 'ownerId' | 'memberIds'>,
  visits: readonly VisitRef[],
): GlassClarity {
  if (room.kind === 'my' && room.ownerId === viewerId) return 'clear';
  if (room.kind !== 'my' && room.memberIds.includes(viewerId)) return 'clear';
  const active = visits.filter((v) => v.hostRoomId === room.id && v.visitorUserId === viewerId && v.status === 'active');
  if (active.some((v) => v.visitorKind === 'human')) return 'clear';
  return active.some((v) => v.visitorKind === 'agent') ? 'agent' : 'frosted';
}

/** 유리 상태별로 밖에서 보이는 것. 서리 유리여도 조명과 실루엣과 간판은 보인다 */
export function glassReveals(clarity: GlassClarity): { sign: true; lights: true; silhouettes: true; detail: boolean } {
  return { sign: true, lights: true, silhouettes: true, detail: clarity === 'clear' };
}

export interface WorldTopology {
  /** 카메라 앞 중앙의 캡슐 = 내 My Room */
  front: string | null;
  /** 그 뒤에 부채꼴로 놓이는, 내가 구성원인 Our 캡슐들과 각 Our 뒤편의 다른 구성원 My Room */
  ours: { roomId: string; behind: string[] }[];
  /** 유리 튜브 연결: 내 캡슐 ↔ Our, Our ↔ 다른 구성원 캡슐 */
  tubes: { from: string; to: string }[];
}

export function worldTopology(viewerId: string, rooms: readonly RoomRef[]): WorldTopology {
  const myRoomOf = new Map<string, string>();
  for (const r of rooms) if (r.kind === 'my' && r.ownerId) myRoomOf.set(r.ownerId, r.id);
  const front = myRoomOf.get(viewerId) ?? null;

  const ours: WorldTopology['ours'] = [];
  const tubes: WorldTopology['tubes'] = [];
  for (const r of rooms) {
    if (r.kind !== 'our' || !r.memberIds.includes(viewerId)) continue;
    const behind = r.memberIds
      .filter((u) => u !== viewerId)
      .map((u) => myRoomOf.get(u))
      .filter((id): id is string => id !== undefined);
    ours.push({ roomId: r.id, behind });
    if (front) tubes.push({ from: front, to: r.id });
    for (const b of behind) tubes.push({ from: r.id, to: b });
  }
  return { front, ours, tubes };
}
