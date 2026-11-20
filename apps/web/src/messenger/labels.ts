import { ourColor, roomLabel, type UserDto, type WorldRoom } from '@ensemble/shared';

/** DM의 상대(나를 뺀 구성원) */
export function dmPeer(room: Pick<WorldRoom, 'memberIds'>, meId: string, users: Record<string, UserDto>): UserDto | undefined {
  const id = room.memberIds.find((m) => m !== meId);
  return id ? users[id] : undefined;
}

/** 사이드바·헤더 제목. My Room/Alice의 Room/Our 제목은 shared roomLabel, DM은 상대 이름 */
export function titleOf(room: WorldRoom, meId: string, users: Record<string, UserDto>): string {
  if (room.kind === 'dm') return dmPeer(room, meId, users)?.name ?? room.title;
  return roomLabel(meId, room, (id) => users[id]?.name ?? id);
}

/** Room 대표 색. My Room은 소유자 색, Our는 구성원 색 혼합(우리 색), DM은 상대 색 */
export function colorOf(room: WorldRoom, meId: string, users: Record<string, UserDto>): string {
  if (room.kind === 'my') return users[room.ownerId ?? '']?.color ?? '#a0aec4';
  if (room.kind === 'dm') return dmPeer(room, meId, users)?.color ?? '#a0aec4';
  const colors = room.memberIds.map((m) => users[m]?.color).filter((c): c is string => !!c);
  return colors.length ? ourColor(colors) : '#a0aec4';
}

export const KIND_LABEL = { my: 'My Room', our: '우리', dm: 'DM' } as const;

export const AMBIENCE_LABEL: Record<string, string> = {
  occupied: '사람이 있음',
  agentOnly: 'Agent만 있음',
  empty: '비어 있음',
  attention: '승인 대기',
};

export const AGENT_ACTIVITY_LABEL: Record<string, string> = {
  idle: '대기 중',
  thinking: '생각하는 중',
  drafting: '쓰는 중',
  talking: '말하는 중',
  awaiting: '승인 기다리는 중',
  paused: '멈춤',
};

/** 자리 비움(접속 안 함) 중 서버가 자동으로 깨운 대리 응답. 명시적 Leave 대리("대리 중")와 구분한다 */
export const AUTO_REPLY_LABEL = '자리 비움 · 자동 대리';

export const AGENT_MODE_LABEL: Record<string, string> = {
  accompanied: '동행',
  representing: '대리 중',
  visiting: '방문 중',
  traveling: '이동 중',
};
