import type { AgentActivity, AgentCueKind, AgentMode, AgentTarget, InteractionChannel } from '@ensemble/shared';

/** 출발 캐릭터에서 다른 캐릭터로 이어지는 A2A/A2H 연결선 하나(포커스 방에서만 채워진다) */
export interface CharacterLink {
  toCharId: string;
  channel: Exclude<InteractionChannel, 'h2a'>;
  seq: number;
  /** 시간 감쇠 기준 시각(ms). pending이면 무시 */
  at: number;
  pending: boolean;
  /** 펄스가 toCharId -> 이 캐릭터 방향으로 흐른다(a2a_answer) */
  reverse?: boolean;
}

/** 캡슐 안에 서는 인물 하나(사람, Personal Agent, Room Agent)의 표시 입력. WorldCanvas의 `characters` prop이 받는다 */
export interface CharacterInput {
  /** 사람: `h:<userId>`, Agent: agentId */
  id: string;
  kind: 'human' | 'agent' | 'room_agent';
  name: string;
  /** 소유자 색(사람·Personal Agent). Room Agent는 라임 */
  color: string;
  ownerId: string | null;
  /** 지금 화면에서 이 인물이 있어야 할 캡슐. null이면 이동 중(튜브) */
  roomId: string | null;
  /** 이동 중일 때 목적지 힌트(agent_departed.toRoomId). 모르면 null */
  destRoomId?: string | null;
  /** 이동 직전에 있던 캡슐(모르면 undefined) */
  homeRoomId?: string | null;
  isMe: boolean;
  activity: AgentActivity;
  mode: AgentMode;
  recalling: boolean;
  /** 대리 참여: 소유자 좌석에 혼자 앉고 "대리" 표식 */
  representing: boolean;
  /** 다른 Room에서 방문 온 Agent */
  visiting: boolean;
  handoverPending: boolean;
  target: AgentTarget | null;
  /** target이 가리키는 캐릭터 id를 해석한 값 (없으면 null) */
  targetCharId: string | null;
  cue: { kind: AgentCueKind; seq: number } | null;
  /** 말풍선: 실시간 스트리밍 일부, 또는 마지막 발화 */
  speech: { text: string; phase: 'thinking' | 'recalling' | 'writing' | 'acting' | 'said'; tokensPerSec: number } | null;
  /** 이 인물이 만든 승인이 대기 중 */
  awaitingApproval: boolean;
  /** 자세히(포커스 캡슐) 또는 가볍게(조망) */
  detail: 'full' | 'light';
  /** 소유자가 자리를 비운 Agent의 소유자 id (좌석 결정) */
  seatUserId: string | null;
  /** 서버가 알려 준 가장 최근 방문 이동(출발→호스트). seq가 바뀌면 튜브 이동 연출을 한 번 재생한다. 모르면 없음 */
  travel?: { fromRoomId: string; toRoomId: string; seq: number } | null;
  /** 사람 전용: 이 방의 구성원인데 지금 접속해 있지 않음(명시적 Leave 아님). 흐리게 + "자리 비움", 이동 없음. id는 `ha:<userId>:<roomId>` */
  away?: boolean;
  /** 이 캐릭터에서 출발하는 A2A/A2H 연결선 */
  links?: readonly CharacterLink[];
  /** A2A/A2H 연결선의 한쪽 끝(이름표를 펼친다) */
  linked?: boolean;
  /** 사람 전용: 이 사람이 승인자인 미해소 Agent 승인이 있음 */
  alert?: 'approval' | null;
}

/** 월드 전체 캐릭터 입력 */
export interface WorldCharacters {
  /** 모든 인물. roomId가 null이면 이동 중이다 */
  characters: readonly CharacterInput[];
  /** 타임라인 재생 중: 휘발성 효과(입자, 실시간 말풍선)를 끈다 */
  replaying?: boolean;
}

export type CharacterEvent =
  | { type: 'spawn' | 'despawn'; id: string; roomId: string; kind: CharacterInput['kind'] }
  | { type: 'trip_start' | 'trip_end'; id: string; fromRoomId: string | null; toRoomId: string | null }
  | { type: 'cue'; id: string; roomId: string; cue: AgentCueKind };
