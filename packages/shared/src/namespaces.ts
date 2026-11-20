import type { RoomKind } from './events';

/**
 * 메모리 네임스페이스 규칙 (계획 7절). 서버가 서버 진실로 계산하며 도구에는 ns 파라미터가 없다.
 * `allowedNamespaces`는 Agent 턴의 읽기 범위, `writableNamespace`는 `remember`가 쓰는 곳이다.
 * 사람이 MemoryPanel에서 읽고 쓰는 경로는 별도 API(소유자 본인 것만)이므로 여기서 다루지 않는다.
 */

export const nsRoom = (roomId: string) => `room:${roomId}`;
export const nsPrivate = (agentId: string) => `agent:${agentId}:private`;
export const nsFor = (agentId: string, roomId: string) => `agent:${agentId}:for:${roomId}`;
export const nsVisit = (visitId: string) => `visit:${visitId}`;

export type ParsedNamespace =
  | { kind: 'room'; roomId: string }
  | { kind: 'private'; agentId: string }
  | { kind: 'for'; agentId: string; roomId: string }
  | { kind: 'visit'; visitId: string };

export function parseNamespace(ns: string): ParsedNamespace | null {
  let m = /^room:(.+)$/.exec(ns);
  if (m) return { kind: 'room', roomId: m[1]! };
  m = /^visit:(.+)$/.exec(ns);
  if (m) return { kind: 'visit', visitId: m[1]! };
  m = /^agent:([^:]+):private$/.exec(ns);
  if (m) return { kind: 'private', agentId: m[1]! };
  m = /^agent:([^:]+):for:(.+)$/.exec(ns);
  if (m) return { kind: 'for', agentId: m[1]!, roomId: m[2]! };
  return null;
}

/** 소유자 개인 기억이라 이벤트 가시성도 private:소유자로 두어야 하는 ns (`memory_retained`) */
export function isPrivateNamespace(ns: string): boolean {
  const p = parseNamespace(ns);
  return p?.kind === 'private' || p?.kind === 'for';
}

export type NamespaceAgent =
  | { kind: 'personal'; agentId: string; ownerId: string }
  | { kind: 'room_agent'; roomAgentId: string };

/** 턴이 실행되는 상황. 서버가 DB와 presence에서 만든다 */
export interface NamespaceContext {
  agent: NamespaceAgent;
  room: { id: string; kind: RoomKind; ownerId: string | null };
  /** 지금 Room 안에 있는 사람 (방문자 포함) */
  presentUserIds: readonly string[];
  /** 지금 Room 안에 있는 방문 Agent (호스트 쪽에서 본 값) */
  presentVisitorAgentIds: readonly string[];
  /** 이 Agent가 방문 중이면 그 방문 id. 있으면 방문 모드다 */
  visitId?: string | null;
}

/**
 * private ns 조건: room.kind='my' AND 소유자 일치 AND Room 안에 소유자와 그 Agent뿐.
 * 소유자가 자리를 비웠거나(대리 참여), 방문자(사람/Agent)가 있으면 닫힌다.
 */
export function privateNamespaceOpen(ctx: NamespaceContext): boolean {
  const { agent, room } = ctx;
  if (agent.kind !== 'personal' || ctx.visitId) return false;
  if (room.kind !== 'my' || room.ownerId !== agent.ownerId) return false;
  if (ctx.presentVisitorAgentIds.length > 0) return false;
  return ctx.presentUserIds.length === 1 && ctx.presentUserIds[0] === agent.ownerId;
}

/** 이번 턴에 읽을 수 있는 ns 목록 (recallForTurn의 입력) */
export function allowedNamespaces(ctx: NamespaceContext): string[] {
  const { agent, room } = ctx;
  if (room.kind === 'dm') return [];

  if (agent.kind === 'room_agent') return [nsRoom(room.id)];

  // 방문 Agent: 개인 ns와 호스트 Room ns 모두 없이 방문 범위만
  if (ctx.visitId) return [nsVisit(ctx.visitId)];

  const out: string[] = [];
  if (privateNamespaceOpen(ctx)) out.push(nsPrivate(agent.agentId));
  out.push(nsFor(agent.agentId, room.id));
  out.push(nsRoom(room.id));
  return out;
}

/**
 * `remember`가 쓸 ns. 쓸 수 없으면 null.
 * - 방문 Agent, Room Agent, DM: 쓰지 않는다
 * - My Room에 소유자와 그 Agent뿐: 개인 private
 * - 그 외(방문자 있음, 대리 참여, Our Room): 그 Room의 room ns
 */
export function writableNamespace(ctx: NamespaceContext): string | null {
  const { agent, room } = ctx;
  if (room.kind === 'dm' || agent.kind !== 'personal' || ctx.visitId) return null;
  if (privateNamespaceOpen(ctx)) return nsPrivate(agent.agentId);
  return nsRoom(room.id);
}

/** 도구가 낸 `used_memory_ids`가 이번 턴에 제공된 항목의 부분집합인지 (계획 6절 검증) */
export function isSubsetOfProvided(used: readonly string[], provided: readonly string[]): boolean {
  const allowed = new Set(provided);
  return used.every((id) => allowed.has(id));
}
