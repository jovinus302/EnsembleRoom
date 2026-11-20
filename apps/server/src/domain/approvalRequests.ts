import { randomUUID } from 'node:crypto';
import { badRequest, conflict, notFound } from '../errors';
import type { Action, ActionHandler, HandlerEnv } from './actions';

/**
 * Agent(·방문자)가 올리는 승인 요청 핸들러 (계획 6절 `propose_edit`, `request_approval`).
 * S8은 요청(approvals 행 + approval_requested 이벤트)까지다. 투표·해소·적용은 S10(domain/approvals.ts).
 * 승인자는 호출자가 정하지 못한다. 서버가 Room 종류와 행위자로 계산한다.
 */

type A<K extends Action['type']> = Extract<Action, { type: K }>;

const newId = (prefix: string) => `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 12)}`;

/** 시드가 아닌 사람 구성원 (Our Room) */
function realMembers(env: HandlerEnv): string[] {
  const { ctx, room } = env;
  return ctx.repo.memberIds(room.id).filter((id) => ctx.repo.getUser(id)?.kind === 'person');
}

/** 승인자를 서버 진실로 정한다. 비어 있으면 409. */
export function approversFor(env: HandlerEnv, kind: 'edit' | 'decision'): string[] {
  const { ctx, room, actor } = env;
  let approvers: string[] = [];

  if (room.kind === 'my') {
    // 소유자 Agent(동행·대리), 방문 Agent, 방문자(사람): 모두 승인자는 Room 소유자
    if (room.ownerId) approvers = [room.ownerId];
  } else if (room.kind === 'our') {
    if (actor.kind === 'room_agent') {
      // decision은 시드가 아닌 사람 구성원 전원
      approvers = realMembers(env);
    } else if (actor.kind === 'agent') {
      const owner = ctx.repo.getAgent(actor.agentId)?.ownerId;
      if (owner) {
        if (kind === 'edit') {
          // 소유자를 제외한 사람 구성원 1인. 없으면(시드뿐인 Room) 소유자 본인에게 묻는다.
          const other = realMembers(env).find((m) => m !== owner);
          approvers = [other ?? owner];
        } else {
          approvers = [owner];
        }
      }
    }
  }
  if (approvers.length === 0) throw conflict('no_approver', '승인할 사람을 찾을 수 없습니다');
  return approvers;
}

const clip = (s: string, n = 60) => (s.length > n ? `${s.slice(0, n)}…` : s);

const proposeEdit: ActionHandler<A<'propose_edit'>> = {
  capability: 'propose_edit',
  authorize(env, a) {
    const hasTitle = a.title !== undefined && a.title.trim() !== '';
    const hasBody = a.body !== undefined && a.body.trim() !== '';
    if (a.cardId) {
      const card = env.ctx.repo.getCard(env.room.id, a.cardId);
      if (!card || card.deleted) throw notFound('card_not_found', '존재하지 않는 카드');
      if (!hasTitle && !hasBody) throw badRequest('empty_proposal', '수정안이 비어 있습니다');
    } else if (!hasTitle) {
      throw badRequest('empty_title', '새 카드 제안에는 제목이 필요합니다');
    }
    approversFor(env, 'edit');
  },
  apply(env, a) {
    const approvers = approversFor(env, 'edit');
    const approvalId = newId('appr');
    const proposal = { cardId: a.cardId, title: a.title, body: a.body };
    const target = a.cardId ? env.ctx.repo.getCard(env.room.id, a.cardId)!.title : (a.title ?? '');
    const requestedBy = env.actor.kind === 'agent' ? env.actor.agentId : env.actor.kind === 'room_agent' ? env.actor.roomAgentId : null;
    env.ctx.repo.insertApproval({
      id: approvalId,
      roomId: env.room.id,
      kind: 'edit',
      requestedBy,
      payload: { proposal, rationale: a.rationale ?? null },
    });
    return {
      events: [
        {
          type: 'approval_requested',
          approvalId,
          approvers,
          kind: 'edit',
          summary: a.cardId ? `카드 "${clip(target)}" 수정 제안` : `새 카드 제안: ${clip(target)}`,
          ...(a.rationale ? { publicRationale: a.rationale } : {}),
          proposal: {
            ...(a.cardId ? { cardId: a.cardId } : {}),
            ...(a.title !== undefined ? { title: a.title } : {}),
            ...(a.body !== undefined ? { body: a.body } : {}),
          },
        },
      ],
      data: { approvalId, approvers },
    };
  },
};

const requestApproval: ActionHandler<A<'request_approval'>> = {
  capability: 'request_approval',
  authorize(env, a) {
    if (!a.question.trim()) throw badRequest('empty_question');
    const opts = a.options.map((o) => o.trim());
    if (opts.length < 2 || opts.length > 4 || opts.some((o) => !o) || new Set(opts).size !== opts.length) {
      throw badRequest('invalid_options', '선택지는 서로 다른 2~4개여야 합니다');
    }
    approversFor(env, 'decision');
  },
  apply(env, a) {
    const approvers = approversFor(env, 'decision');
    const approvalId = newId('appr');
    const options = a.options.map((o) => o.trim());
    const requestedBy = env.actor.kind === 'agent' ? env.actor.agentId : env.actor.kind === 'room_agent' ? env.actor.roomAgentId : null;
    env.ctx.repo.insertApproval({
      id: approvalId,
      roomId: env.room.id,
      kind: 'decision',
      requestedBy,
      payload: { question: a.question, options, rationale: a.rationale ?? null },
    });
    return {
      events: [
        {
          type: 'approval_requested',
          approvalId,
          approvers,
          kind: 'decision',
          summary: a.question.trim(),
          ...(a.rationale ? { publicRationale: a.rationale } : {}),
          options,
        },
      ],
      data: { approvalId, approvers },
    };
  },
};

export const APPROVAL_REQUEST_HANDLERS: {
  propose_edit: ActionHandler<A<'propose_edit'>>;
  request_approval: ActionHandler<A<'request_approval'>>;
} = { propose_edit: proposeEdit, request_approval: requestApproval };
