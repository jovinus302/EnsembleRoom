import { randomUUID } from 'node:crypto';
import {
  EditProposalSchema,
  nsPrivate,
  nsRoom,
  nsVisit,
  pendingApprovalsFor,
  privateTo,
  type ApprovalItemDto,
  type ApprovalOutcome,
  type ApprovalState,
  type EditProposal,
  type OwnerTag,
  type RoomEvent,
} from '@ensemble/shared';
import type { AppContext } from '../context';
import type { RoomRow, VisitRow } from '../db/repo';
import { badRequest, conflict, forbidden, notFound } from '../errors';
import type { Action, ActionHandler, EventDraft, HandlerEnv } from './actions';
import { requireRoom, roomStateOf } from './rooms';

/**
 * 승인 투표·해소 (계획 5절 승인 이벤트, 6절 권한, 7절 방문 takeout).
 *
 * 승인자는 `approval_requested.approvers`(서버가 정한 값)뿐이다. 한 사람은 한 번만 투표한다(중복은 409).
 * - reject: 한 명이라도 거절하면 즉시 rejected.
 * - edit(kind='edit'만): 승인자가 수정안을 내면 edited로 해소되고 수정본이 반영된다.
 * - approve: 승인자 전원이 approve해야 approved. decision형은 선택지를 골라야 하고 서로 다른 선택지는 409(option_mismatch).
 * 해소되면 같은 트랜잭션에서 효과를 적용한다.
 * - edit: 수정안을 실제 보드 카드에 반영(card_created/card_updated). 합의된 Our 카드는 decision 승인 없이는 못 고친다(409).
 * - decision: 확정된 선택지를 approval_resolved.option에 기록. Our Room에서 2인 이상이 승인하면 합의 카드(agreed) +
 *   agreement_formed + room 기억(agreement)을 남긴다. 요청한 Agent는 scheduler가 깨운다.
 * - takeout: 승인되면 방문 중 쌓인 visit:<id> 후보 항목을 Agent의 private ns로 옮기고, 거절되면 폐기한다.
 */

const newId = (prefix: string) => `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
const clip = (s: string, n = 60) => (s.length > n ? `${s.slice(0, n)}…` : s);

type A<K extends Action['type']> = Extract<Action, { type: K }>;

/* ------------------------------ 조회 ------------------------------ */

/** 이벤트 로그에서 해소된 승인의 확정 선택지 */
function resolvedOptions(events: readonly RoomEvent[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const e of events) if (e.type === 'approval_resolved' && e.option) m.set(e.approvalId, e.option);
  return m;
}

export function approvalItem(room: RoomRow, st: ApprovalState, options: Map<string, string> = new Map()): ApprovalItemDto {
  return {
    roomId: room.id,
    roomTitle: room.title,
    approvalId: st.approvalId,
    kind: st.kind,
    summary: st.summary,
    publicRationale: st.publicRationale,
    ...(st.options ? { options: st.options } : {}),
    ...(st.proposal ? { proposal: st.proposal } : {}),
    approvers: st.approvers,
    votes: st.votes,
    status: st.status,
    resolvedOption: options.get(st.approvalId) ?? null,
    requestedSeq: st.requestedSeq,
    requestedBy: st.requestedBy,
    requestedByKind: st.requestedByKind,
  };
}

/** 이 사용자가 아직 투표하지 않은 대기 승인 (내가 승인자인 모든 Room). 오래된 요청부터. */
export function listPendingApprovalsFor(ctx: AppContext, userId: string): ApprovalItemDto[] {
  const out: ApprovalItemDto[] = [];
  for (const room of ctx.repo.listRooms()) {
    if (room.kind === 'dm') continue;
    const mine = room.kind === 'my' ? room.ownerId === userId : ctx.repo.isMember(room.id, userId);
    if (!mine) continue;
    const state = roomStateOf(ctx, room.id);
    for (const st of pendingApprovalsFor(state, userId)) out.push(approvalItem(room, st));
  }
  return out.sort((a, b) => a.requestedSeq - b.requestedSeq);
}

export function getApprovalItem(ctx: AppContext, approvalId: string): ApprovalItemDto {
  const row = ctx.repo.getApproval(approvalId);
  if (!row) throw notFound('approval_not_found', '존재하지 않는 승인');
  const room = requireRoom(ctx, row.roomId);
  const events = ctx.store.listAll(room.id);
  const state = roomStateOf(ctx, room.id).approvals[approvalId];
  if (!state) throw notFound('approval_not_found', '존재하지 않는 승인');
  return approvalItem(room, state, resolvedOptions(events));
}

/** 이 사용자가 보거나 투표할 수 있는 승인인가 (승인자이거나 그 Room 구성원) */
export function canViewApproval(ctx: AppContext, userId: string, approvalId: string): boolean {
  const row = ctx.repo.getApproval(approvalId);
  if (!row) return false;
  const room = ctx.repo.getRoom(row.roomId);
  if (!room) return false;
  return room.kind === 'my' ? room.ownerId === userId : ctx.repo.isMember(room.id, userId);
}

/* ------------------------------ 투표 ------------------------------ */

function parseEdited(raw: Record<string, unknown> | undefined): EditProposal {
  const r = EditProposalSchema.safeParse(raw ?? {});
  if (!r.success) throw badRequest('invalid_edited', '수정안 형식이 올바르지 않습니다');
  if ((r.data.title === undefined || !r.data.title.trim()) && (r.data.body === undefined || !r.data.body.trim())) {
    throw badRequest('empty_proposal', '수정안이 비어 있습니다');
  }
  return r.data;
}

const voteHandler: ActionHandler<A<'vote_approval'>> = {
  capability: null,
  authorize(env, a) {
    const { ctx, actor, room } = env;
    if (actor.kind !== 'human') throw forbidden('humans_only', '승인은 사람만 할 수 있습니다');
    const row = ctx.repo.getApproval(a.approvalId);
    if (!row || row.roomId !== room.id) throw notFound('approval_not_found', '존재하지 않는 승인');
    const st = roomStateOf(ctx, room.id).approvals[a.approvalId];
    if (!st) throw notFound('approval_not_found', '존재하지 않는 승인');
    if (row.status !== 'pending' || st.status !== 'pending') throw conflict('already_resolved', '이미 해소된 승인입니다');
    if (!st.approvers.includes(actor.userId)) throw forbidden('not_approver', '이 승인의 승인자가 아닙니다');
    if (ctx.repo.listApprovalVotes(a.approvalId).some((v) => v.userId === actor.userId)) {
      throw conflict('already_voted', '이미 투표했습니다');
    }
    if (a.decision === 'edit') {
      if (row.kind !== 'edit') throw badRequest('edit_not_supported', '수정 승인은 카드 수정 제안에만 쓸 수 있습니다');
      parseEdited(a.edited);
    }
    if (a.decision === 'approve' && row.kind === 'decision') {
      const options = st.options ?? [];
      if (!a.option || !options.includes(a.option)) throw badRequest('invalid_option', '선택지를 골라야 합니다');
      const prior = ctx.repo.listApprovalVotes(a.approvalId).filter((v) => v.decision === 'approve');
      const priorOption = optionOf(prior);
      if (priorOption && priorOption !== a.option) {
        throw conflict('option_mismatch', '다른 선택지를 이미 고른 승인자가 있습니다', { option: priorOption });
      }
    }
  },
  apply(env, a) {
    const { ctx, room } = env;
    const userId = (env.actor as { userId: string }).userId;
    const row = ctx.repo.getApproval(a.approvalId)!;
    const st = roomStateOf(ctx, room.id).approvals[a.approvalId]!;
    const edited = a.decision === 'edit' ? parseEdited(a.edited) : undefined;
    const option = a.decision === 'approve' && row.kind === 'decision' ? a.option : undefined;

    ctx.repo.insertApprovalVote(a.approvalId, userId, a.decision, edited ?? (option ? { option } : null));
    const events: EventDraft[] = [
      { type: 'approval_voted', approvalId: a.approvalId, userId, decision: a.decision, ...(option ? { option } : {}), ...(edited ? { edited } : {}) },
    ];

    const votes = ctx.repo.listApprovalVotes(a.approvalId);
    let outcome: ApprovalOutcome | null = null;
    if (a.decision === 'reject') outcome = 'rejected';
    else if (a.decision === 'edit') outcome = 'edited';
    else if (st.approvers.every((id) => votes.some((v) => v.userId === id && v.decision === 'approve'))) outcome = 'approved';

    let status: ApprovalOutcome | 'pending' = 'pending';
    if (outcome) {
      status = outcome;
      ctx.repo.setApprovalStatus(a.approvalId, outcome);
      events.push(...resolveEffects(env, row, st, outcome, votes, edited));
    }
    return { events, data: { approvalId: a.approvalId, status, ...(outcome === 'approved' && row.kind === 'decision' ? { option: optionOf(votes) } : {}) } };
  },
};

/** approve 투표 행에는 선택지가 edited_json에 `{option}`으로 저장돼 있다 */
function optionOf(votes: { decision: string; edited: Record<string, unknown> | null }[]): string | undefined {
  for (const v of votes) {
    const o = v.decision === 'approve' ? v.edited?.option : undefined;
    if (typeof o === 'string') return o;
  }
  return undefined;
}

/* ------------------------------ 해소 효과 ------------------------------ */

function resolveEffects(
  env: HandlerEnv,
  row: NonNullable<ReturnType<AppContext['repo']['getApproval']>>,
  st: ApprovalState,
  outcome: ApprovalOutcome,
  votes: { userId: string; decision: string; edited: Record<string, unknown> | null }[],
  edited: EditProposal | undefined,
): EventDraft[] {
  const { ctx, room } = env;
  const resolved = (extra: { option?: string; applied?: EditProposal } = {}): EventDraft => ({
    type: 'approval_resolved',
    approvalId: st.approvalId,
    outcome,
    ...extra,
    asSystem: true,
  });

  if (row.kind === 'edit') {
    if (outcome === 'rejected') return [resolved()];
    const base: EditProposal = (row.payload.proposal as EditProposal | undefined) ?? st.proposal ?? {};
    const applied: EditProposal = { ...base, ...(edited ?? {}) };
    return [resolved({ applied }), ...applyProposal(env, applied, row.requestedBy)];
  }

  if (row.kind === 'decision') {
    if (outcome !== 'approved') return [resolved()];
    const option = optionOf(votes);
    const events: EventDraft[] = [resolved(option ? { option } : {})];
    const approvedBy = votes.filter((v) => v.decision === 'approve').map((v) => v.userId);
    if (room.kind === 'our' && st.approvers.length >= 2 && option) {
      const cardId = newId('c');
      const question = (row.payload.question as string | undefined) ?? st.summary;
      ctx.repo.insertCard({ roomId: room.id, cardId, title: `합의: ${clip(question, 80)}`, body: option, ownerTag: 'ours' });
      ctx.repo.setCardAgreed(room.id, cardId);
      events.push({ type: 'card_created', cardId, title: `합의: ${clip(question, 80)}`, body: option, ownerTag: 'ours', asSystem: true });
      events.push({ type: 'agreement_formed', cardId, memberIds: approvedBy, asSystem: true });
      const item = ctx.memory.commit(nsRoom(room.id), {
        kind: 'agreement',
        text: `${question} → ${option}`,
        sourceRoomId: room.id,
        createdBy: 'system',
      });
      events.push({ type: 'memory_retained', itemId: item.id, ns: item.ns, kind: 'agreement', asSystem: true });
    }
    return events;
  }

  if (row.kind === 'takeout') {
    const itemId = row.payload.itemId as string | undefined;
    const agentId = row.payload.agentId as string | undefined;
    const ownerId = row.payload.ownerId as string | undefined;
    if (outcome !== 'approved' || !itemId || !agentId || !ownerId) {
      if (itemId) ctx.memory.discard(itemId);
      return [resolved()];
    }
    // 호스트가 허용한 takeout만 소유자 쪽(Agent private ns)으로 옮긴다. 기억 생성 이벤트는 소유자의 My Room에 private로 남는다.
    const ns = nsPrivate(agentId);
    ctx.memory.relocate(itemId, ns);
    const events: EventDraft[] = [resolved()];
    const home = ctx.repo.getMyRoomByOwner(ownerId);
    if (home) {
      events.push({ type: 'memory_retained', itemId, ns, kind: 'fact', roomId: home.id, asSystem: true, visibility: privateTo(ownerId) });
    }
    return events;
  }

  return [resolved()];
}

/** 해소된 수정안을 보드에 반영한다. 투영 테이블과 이벤트를 같은 트랜잭션에서 만든다. */
function applyProposal(env: HandlerEnv, p: EditProposal, requestedBy: string | null): EventDraft[] {
  const { ctx, room } = env;
  if (p.cardId) {
    const card = ctx.repo.getCard(room.id, p.cardId);
    if (!card || card.deleted) throw conflict('card_gone', '대상 카드가 더 이상 없습니다');
    if (card.agreed && room.kind === 'our') {
      throw conflict('needs_decision_approval', '합의된 카드는 decision 승인을 거쳐야 수정할 수 있습니다');
    }
    const patch: { title?: string; body?: string } = {};
    if (p.title !== undefined && p.title.trim()) patch.title = p.title;
    if (p.body !== undefined) patch.body = p.body;
    if (patch.title === undefined && patch.body === undefined) throw badRequest('empty_proposal', '수정안이 비어 있습니다');
    const version = card.version + 1;
    ctx.repo.updateCard(room.id, p.cardId, {
      title: patch.title ?? card.title,
      body: patch.body ?? card.body,
      deleted: false,
      version,
    });
    return [{ type: 'card_updated', cardId: p.cardId, patch, version, asSystem: true }];
  }
  if (!p.title?.trim()) throw badRequest('empty_title', '새 카드 제안에는 제목이 필요합니다');
  const cardId = newId('c');
  const ownerTag: OwnerTag =
    room.kind === 'our' ? 'ours' : requestedBy && ctx.repo.getAgent(requestedBy) ? `agent:${requestedBy}` : `user:${room.ownerId ?? 'unknown'}`;
  ctx.repo.insertCard({ roomId: room.id, cardId, title: p.title, body: p.body ?? '', ownerTag });
  return [{ type: 'card_created', cardId, title: p.title, body: p.body ?? '', ownerTag, asSystem: true }];
}

/* ------------------------------ takeout 요청 ------------------------------ */

/**
 * 방문 종료 시 공개 takeout을 승인 대기로 올린다 (end_visit 핸들러가 호출).
 * 후보 텍스트는 `visit:<id>` ns에 임시로 두고, 호스트가 승인해야 소유자 Agent의 private ns로 옮겨진다.
 * 이벤트는 호스트 Room에 system 행위자로 기록된다(방문 Agent는 이미 돌아갔다).
 */
export function requestTakeoutApproval(env: HandlerEnv, visit: VisitRow, text: string): EventDraft[] {
  const { ctx, room } = env;
  if (!visit.visitorAgentId || !room.ownerId) return [];
  const agent = ctx.repo.getAgent(visit.visitorAgentId);
  if (!agent) return [];
  const item = ctx.memory.commit(nsVisit(visit.id), { kind: 'fact', text, sourceRoomId: room.id, createdBy: agent.id });
  const approvalId = newId('appr');
  ctx.repo.insertApproval({
    id: approvalId,
    roomId: room.id,
    kind: 'takeout',
    requestedBy: agent.id,
    payload: { visitId: visit.id, itemId: item.id, text, agentId: agent.id, ownerId: visit.visitorUserId },
  });
  const ownerName = ctx.repo.getUser(visit.visitorUserId)?.name ?? visit.visitorUserId;
  return [
    {
      type: 'approval_requested',
      approvalId,
      approvers: [room.ownerId],
      kind: 'takeout',
      summary: `${agent.name}(${ownerName})가 가져가려는 내용: ${clip(text, 80)}`,
      publicRationale: text,
      asSystem: true,
    },
  ];
}

export const APPROVAL_HANDLERS: { vote_approval: ActionHandler<A<'vote_approval'>> } = { vote_approval: voteHandler };
