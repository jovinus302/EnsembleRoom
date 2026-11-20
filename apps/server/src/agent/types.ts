import type { BoardCard, BoardTool, Mandate, MemoryKind, PassReason, RoomEvent, ToolName } from '@ensemble/shared';

/**
 * Agent 런타임 공용 타입 (계획 6절). provider(mock/claude)와 runTurn·scheduler가 공유한다.
 */

export type AgentKind = 'personal' | 'room_agent';

/**
 * 프롬프트·권한 모드.
 * accompanied/representing/visiting은 계획 8.5의 AgentMode와 같다. member는 Our Room의 구성원 Agent(소유자가 자리에 있음),
 * room은 Room Agent. traveling 중에는 턴이 없다.
 */
export type TurnMode = 'accompanied' | 'representing' | 'visiting' | 'member' | 'room';

export type TriggerReason =
  | 'addressed' // message.to로 지정됨
  | 'pointed' // 카드 지목
  | 'owner_message' // my Room에서 소유자가 말함 → 소유자의 Agent
  | 'visitor_message' // 소유자 부재 중 방문자가 말함 → 호스트 Agent
  | 'host_message' // 방문 중인 Agent가 호스트 Room의 사람 발언을 봄
  | 'room_agent_call' // Our Room의 질문·정리·부재 구성원 관련 → Room Agent
  | 'representing' // Our Room에서 부재(대리 참여) 구성원이 언급됨 → 그 구성원의 Agent
  | 'auto_reply' // Our Room에서 접속하지 않은(명시적 Leave 아님) 구성원의 Agent가 자동 대리 응답
  | 'agent_chain' // 다른 Agent의 to 지정
  | 'approval_resolved' // 내가 올린 decision 승인이 해소됨 → 결과를 이어서 처리
  | 'arrival' // 방문 도착 턴
  | 'a2a_ask' // 다른 Agent(Room Agent 포함)가 ask_agents로 나에게 물음 → 보수적으로 답한다
  | 'a2a_collect' // 내가 ask_agents로 물은 질문에 수신자 전원이 답했거나 정산됨 → 정리 턴
  | 'visit_turn_limit'; // 방문 턴 상한: end_visit 강제

/** A2A 질문·정리 턴에 붙는 정보 (scheduler가 job에 싣는다) */
export interface A2AJob {
  /** 질문 메시지(recipients가 있는 message)의 seq */
  askSeq: number;
  askerId: string;
  askerKind: 'personal' | 'room_agent';
  role: 'answer' | 'collect';
}

/** 물어볼 수 있는 Agent (Our Room의 부재 구성원 Agent) */
export interface AskableAgent {
  id: string;
  name: string;
  ownerId: string;
  ownerName: string;
}

/** 모델 입력에 실리는 A2A 맥락 */
export type TurnA2A =
  | { role: 'answer'; askSeq: number; askerId: string; askerName: string; askerKind: 'personal' | 'room_agent'; question: string }
  | {
      role: 'collect';
      askSeq: number;
      question: string;
      answers: { agentId: string; name: string; ownerName: string | null; text: string; approvalPending: boolean }[];
    };

export interface Trigger {
  /** 트리거가 된 이벤트의 seq */
  seq: number;
  reason: TriggerReason;
  /** 트리거 이벤트 (server 내부용. 프롬프트·mock이 쓴다) */
  event: RoomEvent | null;
}

/** 모델에 주는 도구 정의. inputSchema는 JSON Schema (Anthropic tool use의 input_schema와 같은 모양) */
export interface ToolSpec {
  name: ToolName;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolCall {
  name: ToolName;
  input: Record<string, unknown>;
}

export interface TurnMemory {
  id: string;
  kind: MemoryKind;
  text: string;
}

/** 이번 턴에 provider가 받는 입력. 권한으로 걸러진 도구와 gateway가 허용한 기억만 들어 있다. */
export interface TurnInput {
  turnId: string;
  roomId: string;
  agent: {
    id: string;
    kind: AgentKind;
    name: string;
    personaPublic: string;
    /** Personal Agent의 소유자. Room Agent는 null */
    ownerId: string | null;
    ownerName: string | null;
  };
  mode: TurnMode;
  trigger: Trigger;
  /** 값이 있으면 이 도구만 허용된 강제 턴 (방문 턴 상한의 end_visit) */
  forcedTool: ToolName | null;
  /** 서버가 권한으로 걸러서 준 도구. 여기에 없는 도구는 실행되지 않는다 */
  tools: ToolSpec[];
  mandate: Mandate | null;
  /** 이 턴에 제공된 기억 (최근 20개, 1.5k 토큰 이하). `used_memory_ids`는 이 id의 부분집합이어야 한다 */
  memories: TurnMemory[];
  /** 보이는 최근 이벤트 (최대 30개). private 가시성과 방문 범위 밖 이벤트는 없다 */
  events: RoomEvent[];
  board: BoardCard[];
  /** 보드에 올라 있는 도구(사다리·정산표·여행 계획). board와 같은 가시 범위 */
  boardTools: BoardTool[];
  /** Room의 사람(구성원·소유자·활성 사람 방문자). 사다리 참가자 등에 쓴다 */
  members: { id: string; name: string }[];
  roomSummary: string | null;
  /** id → 표시 이름 (사람, Agent, Room Agent) */
  names: Record<string, string>;
  /** 호스트 Room 이름 등 방문 시 쓸 맥락 */
  roomTitle: string;
  /** ask_agents로 물어볼 수 있는 Agent. 이 턴에 ask_agents가 주어졌을 때만 채운다 */
  askable: AskableAgent[];
  /** A2A 질문(answer)·정리(collect) 턴일 때만 */
  a2a: TurnA2A | null;
  /** LLM provider용으로 렌더링한 프롬프트 (prompts.ts) */
  system: string;
  prompt: string;
}

/**
 * provider가 내보내는 스트림. Anthropic 스트리밍에 그대로 대응한다(S9):
 *   content_block_start(tool_use) → tool_start, input_json_delta의 `to` 확정 → target,
 *   say.text/comment.text의 partial → text_delta, content_block_stop/message_stop → tool_call.
 */
export type ProviderEvent =
  | { type: 'phase'; phase: 'thinking' | 'recalling' | 'writing' }
  | { type: 'tool_start'; tool: ToolName }
  | { type: 'target'; to: string }
  | { type: 'text_delta'; tool: ToolName; delta: string }
  | { type: 'tool_call'; call: ToolCall };

export interface AgentProvider {
  readonly name: string;
  /** 턴당 하나의 tool_call을 내보낸다. 여러 개면 runTurn이 첫 번째만 쓴다. */
  stream(input: TurnInput, signal?: AbortSignal): AsyncIterable<ProviderEvent>;
}

export interface TurnOutcome {
  turnId: string;
  roomId: string;
  agentId: string;
  result: 'acted' | 'pass' | 'error';
  tool: ToolName | null;
  passReason?: PassReason;
  /** result가 error일 때 DomainError code 또는 'provider_error' 등 */
  errorCode?: string;
  errorStatus?: number;
}
