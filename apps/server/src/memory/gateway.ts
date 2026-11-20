import {
  allowedNamespaces,
  isSubsetOfProvided,
  nsFor,
  nsPrivate,
  nsRoom,
  parseNamespace,
  writableNamespace,
  type MemoryKind,
} from '@ensemble/shared';
import type { AppContext } from '../context';
import { dispatch } from '../domain/actions';
import { canAccessRoom } from '../domain/rooms';
import { badRequest, forbidden, notFound } from '../errors';
import { namespaceContextFor } from './nsContext';
import type { MemoryItem, MemoryStore, RetainInput } from './types';

/** 프롬프트에 넣는 기억 토큰 상한 (계획 6절: 1.5k) */
export const DEFAULT_RECALL_TOKEN_BUDGET = 1500;

export interface RecallResult {
  /** 이번 턴에 읽은 ns. 서버가 정했다. */
  namespaces: string[];
  items: MemoryItem[];
  /** 이번 턴에 제공된 항목 id. `used_memory_ids` 검증의 기준이다. */
  providedIds: string[];
}

/**
 * 도구가 낸 `used_memory_ids`가 이번 턴에 제공된 항목의 부분집합인지 검증한다(계획 6절). 위반하면 403.
 * S8 runTurn은 `recallForTurn`의 providedIds와 함께 쓴다.
 */
export function validateUsedMemoryIds(used: readonly string[], provided: readonly string[]): void {
  if (!isSubsetOfProvided(used, provided)) {
    throw forbidden('memory_not_provided', '이번 턴에 제공되지 않은 기억을 사용했다고 주장할 수 없습니다');
  }
}

/**
 * 메모리 접근의 유일한 통로 (계획 7절).
 * - Agent 쪽: `recallForTurn` / `retainFromAgent`. ns는 shared의 allowedNamespaces·writableNamespace를
 *   서버 진실(Room 종류·소유자·이벤트 로그의 presence·방문 상태)로 호출해 계산한다. 호출자가 ns를 지정할 방법이 없다.
 * - 소유자 쪽(MemoryPanel REST): 본인 Agent의 private·for:Room 항목만 다룬다.
 * MemoryStore를 직접 쥔 곳은 이 클래스뿐이다.
 */
export class MemoryGateway {
  constructor(
    private readonly ctx: AppContext,
    private readonly store: MemoryStore,
  ) {}

  /* ------------------------------ Agent 턴 ------------------------------ */

  recallForTurn(agentId: string, roomId: string, opts: { query?: string; tokenBudget?: number } = {}): RecallResult {
    const { repo } = this.ctx;
    // 방문 중인 Agent가 다른 Room에서 턴을 도는 일은 없다. 새어 나가지 않도록 아무것도 주지 않는다.
    const open = repo.getAgent(agentId) ? repo.findOpenAgentVisit(agentId) : undefined;
    if (open?.status === 'active' && open.hostRoomId !== roomId) return { namespaces: [], items: [], providedIds: [] };

    const namespaces = allowedNamespaces(namespaceContextFor(this.ctx, agentId, roomId));
    const items = this.store.recall(namespaces, opts.query ?? '', opts.tokenBudget ?? DEFAULT_RECALL_TOKEN_BUDGET);
    return { namespaces, items, providedIds: items.map((i) => i.id) };
  }

  /** `remember` 도구의 저장. ns는 서버가 정한다. 쓸 수 없는 상황이면 403. memory_retained 이벤트도 함께 기록된다. */
  retainFromAgent(
    agentId: string,
    roomId: string,
    item: { kind: MemoryKind; text: string; turnId?: string | null },
  ): { itemId: string; ns: string } {
    const { repo } = this.ctx;
    const ns = writableNamespace(namespaceContextFor(this.ctx, agentId, roomId));
    if (ns === null) throw forbidden('namespace_not_writable', '이 상황에서는 기억을 저장할 수 없습니다');
    const actor = repo.getAgent(agentId)
      ? ({ kind: 'agent', agentId, turnId: item.turnId } as const)
      : ({ kind: 'room_agent', roomAgentId: agentId, turnId: item.turnId } as const);
    const r = dispatch(this.ctx, actor, { type: 'retain_memory', roomId, ns, kind: item.kind, text: item.text });
    return { itemId: r.data.itemId as string, ns };
  }

  /** dispatch의 retain_memory 핸들러만 호출한다. 검증은 핸들러가 이미 마쳤다. */
  commit(ns: string, input: RetainInput): MemoryItem {
    return this.store.retain(ns, input);
  }

  /**
   * 서버 내부용(승인 해소): 방문 takeout 후보를 소유자 쪽 ns로 옮기거나 폐기한다.
   * 호출자는 domain/approvals.ts뿐이고, 호스트가 승인한 takeout만 relocate된다.
   */
  relocate(itemId: string, ns: string): void {
    this.store.reassign(itemId, ns);
  }
  discard(itemId: string): void {
    this.store.forget(itemId);
  }

  /* ------------------------------ 소유자(MemoryPanel) ------------------------------ */

  /** 소유자가 직접 다룰 수 있는 ns인지 검증하고 파싱한다: 내 Agent의 private 또는 내가 속한 Our Room의 for. */
  private ownedNs(userId: string, ns: string) {
    const { repo } = this.ctx;
    const p = parseNamespace(ns);
    if (!p || (p.kind !== 'private' && p.kind !== 'for')) throw badRequest('invalid_namespace', '개인 기억 공간만 지정할 수 있습니다');
    const agent = repo.getAgent(p.agentId);
    if (!agent || agent.ownerId !== userId) throw forbidden('not_your_memory', '내 Agent의 기억이 아닙니다');
    if (p.kind === 'for') {
      const room = repo.getRoom(p.roomId);
      if (!room || room.kind !== 'our' || !repo.isMember(room.id, userId)) {
        throw forbidden('namespace_not_writable', '내가 속한 Our Room에만 공유할 수 있습니다');
      }
    }
    return { p, agent };
  }

  private ownedItem(userId: string, itemId: string): MemoryItem {
    const item = this.store.get(itemId);
    if (!item || item.status !== 'active') throw notFound('memory_not_found', '존재하지 않는 기억');
    this.ownedNs(userId, item.ns); // 내 것이 아니면 403
    return item;
  }

  /** 내 private 항목과 Room별로 공유한 항목 전부 */
  listOwned(userId: string): MemoryItem[] {
    const { repo } = this.ctx;
    const agent = repo.getAgentByOwner(userId);
    if (!agent) return [];
    const ours = repo.listRooms().filter((r) => r.kind === 'our' && repo.isMember(r.id, userId));
    const nsList = [nsPrivate(agent.id), ...ours.map((r) => nsFor(agent.id, r.id))];
    return repo.listMemoryItemsIn(nsList);
  }

  createOwned(userId: string, input: { ns: string; kind: MemoryKind; text: string }): MemoryItem {
    const { repo } = this.ctx;
    const { p, agent } = this.ownedNs(userId, input.ns);
    // memory_retained 이벤트는 private이면 내 Room에, 공유 항목이면 그 Room에 private:소유자로 남는다.
    const roomId = p.kind === 'for' ? p.roomId : repo.getMyRoomByOwner(userId)?.id;
    if (!roomId) throw badRequest('no_room', '기록할 Room이 없습니다');
    const r = dispatch(this.ctx, { kind: 'human', userId }, {
      type: 'retain_memory',
      roomId,
      ns: nsPrivateOrFor(agent.id, p),
      kind: input.kind,
      text: input.text,
    });
    return this.store.get(r.data.itemId as string)!;
  }

  deleteOwned(userId: string, itemId: string): void {
    this.ownedItem(userId, itemId);
    this.store.forget(itemId);
  }

  /** 항목별 공유 대상 지정·변경·해제(private으로 되돌리기) */
  reshareOwned(userId: string, itemId: string, ns: string): MemoryItem {
    this.ownedItem(userId, itemId);
    this.ownedNs(userId, ns);
    this.store.reassign(itemId, ns);
    return this.store.get(itemId)!;
  }

  /** Room 구성원이 보는 그 Room의 기억: room ns 항목 + 그 Room에 공유한 내 항목. 방문자·비구성원은 403. */
  listForRoom(userId: string, roomId: string): MemoryItem[] {
    const { repo } = this.ctx;
    const room = repo.getRoom(roomId);
    if (!room) throw notFound('room_not_found', '존재하지 않는 Room');
    const participant = room.kind === 'my' ? room.ownerId === userId : repo.isMember(roomId, userId);
    if (!participant || !canAccessRoom(this.ctx, userId, roomId)) throw forbidden('not_in_room', '이 Room에 접근할 수 없습니다');
    if (room.kind === 'dm') return [];
    const nsList = [nsRoom(roomId)];
    const agent = repo.getAgentByOwner(userId);
    if (agent) nsList.push(nsFor(agent.id, roomId));
    return repo.listMemoryItemsIn(nsList);
  }
}

function nsPrivateOrFor(agentId: string, p: { kind: 'private' } | { kind: 'for'; roomId: string }): string {
  return p.kind === 'private' ? nsPrivate(agentId) : nsFor(agentId, p.roomId);
}
