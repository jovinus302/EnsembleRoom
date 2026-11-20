import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodType } from 'zod';
import { VoteRequestSchema, type ApprovalListResponse, type VoteResponse } from '@ensemble/shared';
import { requireUser } from '../auth';
import type { AppContext } from '../context';
import { dispatch } from '../domain/actions';
import { canViewApproval, getApprovalItem, listPendingApprovalsFor } from '../domain/approvals';
import { badRequest, notFound } from '../errors';

function parse<T>(schema: ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body);
  if (!r.success) throw badRequest('invalid_body', r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  return r.data;
}

/**
 * 승인 REST (계획 5절).
 *  - GET  /api/approvals?mine=pending : 내가 승인자이고 아직 투표하지 않은 대기 승인
 *  - GET  /api/approvals/:id          : 승인 한 건 (같은 Room 구성원만)
 *  - POST /api/approvals/:id/vote     : {decision: approve|edit|reject, option?, edited?}  (계획의 계약)
 *  - POST /api/approvals/:id/resolve  : vote의 별칭(같은 body·같은 처리). 승인자가 1명이면 곧 해소다.
 */
export function approvalRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/approvals', async (req): Promise<ApprovalListResponse> => {
    const user = requireUser(req);
    const mine = (req.query as { mine?: string }).mine;
    if (mine !== undefined && mine !== 'pending') throw badRequest('invalid_query', "mine은 'pending'만 지원합니다");
    return { approvals: listPendingApprovalsFor(ctx, user.id) };
  });

  app.get('/api/approvals/:id', async (req) => {
    const user = requireUser(req);
    const { id } = req.params as { id: string };
    if (!canViewApproval(ctx, user.id, id)) throw notFound('approval_not_found', '존재하지 않는 승인');
    return getApprovalItem(ctx, id);
  });

  const vote = async (req: FastifyRequest): Promise<VoteResponse> => {
    const user = requireUser(req);
    const { id } = req.params as { id: string };
    const body = parse(VoteRequestSchema, req.body);
    // 승인을 볼 수 없는 사람에게는 존재 자체를 숨긴다
    if (!canViewApproval(ctx, user.id, id)) throw notFound('approval_not_found', '존재하지 않는 승인');
    const roomId = ctx.repo.getApproval(id)!.roomId;
    const r = dispatch(ctx, { kind: 'human', userId: user.id }, { type: 'vote_approval', roomId, approvalId: id, ...body });
    const approval = getApprovalItem(ctx, id);
    return { seq: r.seq ?? 0, status: approval.status, approval };
  };
  app.post('/api/approvals/:id/vote', vote);
  app.post('/api/approvals/:id/resolve', vote);
}
