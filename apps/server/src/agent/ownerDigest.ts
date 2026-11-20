import { BOARD_TOOL_LABEL, boardToolSummary, nsFor, nsRoom, visibleBoardTools, visibleCards, type SourceChip } from '@ensemble/shared';
import type { AppContext } from '../context';
import { roomStateOf } from '../domain/rooms';
import type { DigestItem, OwnerDigest } from './types';

/**
 * [내 Room 현황]: My Room에서 소유자가 자기 Agent에게 물을 때만 싣는 소유자 전용 요약.
 * 소유자가 구성원인 Our Room마다 카드·내가 승인자인 대기 승인·보드 도구·방 합의 기억·소유자 본인의 for:<방> 기억.
 * 넣지 않는 것: 다른 사람의 for/private 기억, 그 방들의 메시지 원문.
 * 호출자는 privateNamespaceOpen(소유자가 혼자 자기 My Room에 있음)을 이미 확인했다.
 */

export const DIGEST_MAX_LINES = 24;
export const DIGEST_TOKEN_BUDGET = 800;

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
const tokens = (s: string) => Math.ceil(s.length / 2) + 1;

export function buildOwnerDigest(ctx: AppContext, ownerId: string): OwnerDigest {
  const { repo } = ctx;
  const items: DigestItem[] = [];
  const refs = new Map<string, SourceChip>();
  let n = 0;
  const add = (roomId: string, roomTitle: string, kind: DigestItem['kind'], text: string, label: string, chipKind: SourceChip['kind'], agreed?: boolean) => {
    const id = `d${++n}`;
    items.push({ id, roomTitle, kind, text, ...(agreed !== undefined ? { agreed } : {}) });
    refs.set(id, { kind: chipKind, label: clip(label, 40), roomId });
  };

  const myAgent = repo.getAgentByOwner(ownerId);
  for (const room of repo.listRooms()) {
    if (room.kind !== 'our' || !repo.isMember(room.id, ownerId)) continue;
    const state = roomStateOf(ctx, room.id);
    const title = room.title;
    for (const c of visibleCards(state)) {
      add(room.id, title, 'card', `카드 "${clip(c.title, 40)}"${c.agreed ? '(합의됨)' : ''}: ${clip(c.body, 100)}`, `${title} · 카드`, 'room', c.agreed);
    }
    for (const a of Object.values(state.approvals)) {
      if (a.status !== 'pending' || !a.approvers.includes(ownerId)) continue;
      add(room.id, title, 'approval', `승인 대기: ${clip(a.summary, 80)}${a.options?.length ? ` (선택지: ${a.options.join(' / ')})` : ''}`, `${title} · 승인 대기`, 'room');
    }
    for (const t of visibleBoardTools(state)) {
      add(room.id, title, 'tool', `${BOARD_TOOL_LABEL[t.kind]} "${clip(t.title, 40)}": ${boardToolSummary(t)}`, `${title} · ${BOARD_TOOL_LABEL[t.kind]}`, 'room');
    }
    for (const m of repo.listMemoryItemsIn([nsRoom(room.id)])) {
      if (m.kind === 'agreement') add(room.id, title, 'agreement', `방 기억(합의): ${clip(m.text, 100)}`, `${title} 기억`, 'memory');
    }
    if (myAgent) {
      for (const m of repo.listMemoryItemsIn([nsFor(myAgent.id, room.id)])) {
        add(room.id, title, 'mine', `내가 이 방에 공유한 기억: ${clip(m.text, 100)}`, `내 기억 · ${title}`, 'memory');
      }
    }
  }

  // 줄 수·토큰 예산: 앞에서부터 채운다
  const kept: DigestItem[] = [];
  const lines: string[] = [];
  let used = 0;
  for (const it of items) {
    const line = `${it.id} [${it.roomTitle}] ${it.text}`;
    if (kept.length >= DIGEST_MAX_LINES || used + tokens(line) > DIGEST_TOKEN_BUDGET) break;
    kept.push(it);
    lines.push(line);
    used += tokens(line);
  }
  const keptIds = new Set(kept.map((k) => k.id));
  for (const id of [...refs.keys()]) if (!keptIds.has(id)) refs.delete(id);
  return { lines, items: kept, refs };
}
