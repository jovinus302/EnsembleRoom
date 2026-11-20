import type { FastifyInstance } from 'fastify';
import type { ZodType } from 'zod';
import { AcceptVisitRequestSchema, AgentVisitRequestSchema, HumanVisitRequestSchema, type VisitDto } from '@ensemble/shared';
import { requireUser } from '../auth';
import type { AppContext } from '../context';
import { acceptVisit, declineVisit, endVisit, requestHumanVisit, sendAgentVisit } from '../domain/visits';
import { Repo } from '../db/repo';
import { badRequest, notFound } from '../errors';

function parse<T>(schema: ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body);
  if (!r.success) throw badRequest('invalid_body', r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  return r.data;
}

export function visitRoutes(app: FastifyInstance, ctx: AppContext): void {
  const visitOut = (visitId: string, seq: number | null): { visitId: string; seq: number; visit: VisitDto } => ({
    visitId,
    seq: seq ?? 0,
    visit: Repo.visitDto(ctx.repo.getVisit(visitId)!),
  });

  // 사람 방문 요청: :id는 호스트 My Room
  app.post('/api/rooms/:id/visits', async (req) => {
    const user = requireUser(req);
    const { id } = req.params as { id: string };
    parse(HumanVisitRequestSchema, req.body);
    const r = requestHumanVisit(ctx, user.id, id);
    return visitOut(r.visitId, r.seq);
  });

  // 내 Agent 보내기
  app.post('/api/rooms/:id/visits/agent', async (req) => {
    const user = requireUser(req);
    const { id } = req.params as { id: string };
    const body = parse(AgentVisitRequestSchema, req.body);
    const r = sendAgentVisit(ctx, user.id, id, body.mandate);
    return visitOut(r.visitId, r.seq);
  });

  app.post('/api/visits/:id/accept', async (req) => {
    const user = requireUser(req);
    const { id } = req.params as { id: string };
    const body = parse(AcceptVisitRequestSchema, req.body);
    const r = acceptVisit(ctx, user.id, id, body.permissions);
    return visitOut(id, r.seq);
  });

  app.post('/api/visits/:id/decline', async (req) => {
    const user = requireUser(req);
    const { id } = req.params as { id: string };
    const r = declineVisit(ctx, user.id, id);
    return visitOut(id, r.seq);
  });

  // 종료: 호스트, 방문자, Agent를 보낸 사람이 할 수 있다(사유는 행위자로 정해진다).
  app.post('/api/visits/:id/end', async (req) => {
    const user = requireUser(req);
    const { id } = req.params as { id: string };
    if (!ctx.repo.getVisit(id)) throw notFound('visit_not_found', '존재하지 않는 방문');
    const r = endVisit(ctx, { kind: 'human', userId: user.id }, id);
    return visitOut(id, r.seq);
  });
}
