import type { FastifyInstance } from 'fastify';
import type { ZodType } from 'zod';
import {
  BoardToolOpRequestSchema,
  CommentRequestSchema,
  CreateBoardToolRequestSchema,
  CreateCardRequestSchema,
  LeaveRequestSchema,
  PatchCardRequestSchema,
  PointRequestSchema,
  SeenRequestSchema,
  SendMessageRequestSchema,
  type AppendResponse,
  type RoomSnapshot,
  type WorldResponse,
} from '@ensemble/shared';
import { requireUser } from '../auth';
import type { AppContext } from '../context';
import { dispatch, type Action, type DispatchResult } from '../domain/actions';
import { enterRoom, leaveRoom, rejoinRoom, viewDigest } from '../domain/presence';
import { buildSnapshot, buildWorld } from '../domain/rooms';
import { badRequest, forbidden } from '../errors';

function parse<T>(schema: ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body);
  if (!r.success) throw badRequest('invalid_body', r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  return r.data;
}

export function roomRoutes(app: FastifyInstance, ctx: AppContext): void {
  const write = (userId: string, action: Action): DispatchResult => dispatch(ctx, { kind: 'human', userId }, action);
  const appended = (r: DispatchResult): AppendResponse & Record<string, unknown> => ({ seq: r.seq ?? 0, ...r.data });

  app.get('/api/world', async (req): Promise<WorldResponse> => buildWorld(ctx, requireUser(req).id));

  app.get('/api/rooms/:id/snapshot', async (req): Promise<RoomSnapshot> => {
    const { id } = req.params as { id: string };
    return buildSnapshot(ctx, requireUser(req).id, id);
  });

  app.post('/api/rooms/:id/messages', async (req) => {
    const user = requireUser(req);
    const { id } = req.params as { id: string };
    const body = parse(SendMessageRequestSchema, req.body);
    // A2A 전용 필드는 사람이 보낼 수 없다(스키마가 모르는 키는 버리므로 원본 본문을 직접 확인한다)
    const raw = req.body as Record<string, unknown> | null;
    if (raw && typeof raw === 'object' && (raw.recipients !== undefined || raw.replyTo !== undefined || raw.blocks !== undefined)) {
      throw forbidden('agent_only_field', 'recipients·replyTo·blocks는 Agent만 쓸 수 있습니다');
    }
    const r = write(user.id, { type: 'send_message', roomId: id, text: body.text, to: body.to, clientId: body.clientId });
    const out = appended(r);
    ctx.hub.ack(user.id, body.clientId, out.seq);
    return { ...out, clientId: body.clientId };
  });

  app.post('/api/rooms/:id/cards', async (req) => {
    const user = requireUser(req);
    const { id } = req.params as { id: string };
    const body = parse(CreateCardRequestSchema, req.body);
    return appended(write(user.id, { type: 'create_card', roomId: id, title: body.title, body: body.body ?? '', ownerTag: body.ownerTag }));
  });

  app.patch('/api/rooms/:id/cards/:cardId', async (req) => {
    const user = requireUser(req);
    const { id, cardId } = req.params as { id: string; cardId: string };
    const body = parse(PatchCardRequestSchema, req.body);
    return appended(write(user.id, { type: 'update_card', roomId: id, cardId, patch: body.patch, baseVersion: body.baseVersion }));
  });

  app.post('/api/rooms/:id/comments', async (req) => {
    const user = requireUser(req);
    const { id } = req.params as { id: string };
    const body = parse(CommentRequestSchema, req.body);
    return appended(write(user.id, { type: 'add_comment', roomId: id, cardId: body.cardId, text: body.text }));
  });

  app.post('/api/rooms/:id/point', async (req) => {
    const user = requireUser(req);
    const { id } = req.params as { id: string };
    const body = parse(PointRequestSchema, req.body);
    return appended(write(user.id, { type: 'point_card', roomId: id, cardId: body.cardId, agentId: body.agentId }));
  });

  /* ----- 보드 도구 (domain/boardTools.ts) ----- */

  app.post('/api/rooms/:id/tools', async (req) => {
    const user = requireUser(req);
    const { id } = req.params as { id: string };
    const body = parse(CreateBoardToolRequestSchema, req.body);
    return appended(write(user.id, { type: 'create_board_tool', roomId: id, title: body.title, init: body.init }));
  });

  app.post('/api/rooms/:id/tools/:toolId/ops', async (req) => {
    const user = requireUser(req);
    const { id, toolId } = req.params as { id: string; toolId: string };
    const body = parse(BoardToolOpRequestSchema, req.body);
    return appended(write(user.id, { type: 'update_board_tool', roomId: id, toolId, op: body.op }));
  });

  app.delete('/api/rooms/:id/tools/:toolId', async (req) => {
    const user = requireUser(req);
    const { id, toolId } = req.params as { id: string; toolId: string };
    return appended(write(user.id, { type: 'remove_board_tool', roomId: id, toolId }));
  });

  app.post('/api/rooms/:id/seen', async (req) => {
    const user = requireUser(req);
    const { id } = req.params as { id: string };
    const body = parse(SeenRequestSchema, req.body);
    write(user.id, { type: 'mark_seen', roomId: id, seq: body.seq });
    return { ok: true };
  });

  /* ----- presence (domain/presence.ts) ----- */

  // 명시적 진입. 이미 있으면 이벤트 없이 seq 0을 돌려준다.
  app.post('/api/rooms/:id/enter', async (req) => {
    const user = requireUser(req);
    const { id } = req.params as { id: string };
    return appended(enterRoom(ctx, user.id, id));
  });

  // Leave. mandate가 있으면 내 Agent가 대리 참여한다.
  app.post('/api/rooms/:id/leave', async (req) => {
    const user = requireUser(req);
    const { id } = req.params as { id: string };
    const body = parse(LeaveRequestSchema, req.body ?? {});
    return appended(leaveRoom(ctx, user.id, id, body.mandate));
  });

  // Rejoin. 응답의 missedCount가 "내가 없는 동안 변화" 수다.
  app.post('/api/rooms/:id/rejoin', async (req) => {
    const user = requireUser(req);
    const { id } = req.params as { id: string };
    const r = rejoinRoom(ctx, user.id, id);
    const ev = r.events.find((e) => e.type === 'member_rejoined');
    return { ...appended(r), missedCount: ev && ev.type === 'member_rejoined' ? ev.missedCount : 0 };
  });

  // Rejoin 다이제스트를 확인했다
  app.post('/api/rooms/:id/digest_viewed', async (req) => {
    const user = requireUser(req);
    const { id } = req.params as { id: string };
    return appended(viewDigest(ctx, user.id, id));
  });
}
