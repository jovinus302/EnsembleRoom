import type { FastifyInstance } from 'fastify';
import type { ZodType } from 'zod';
import {
  CreateMemoryRequestSchema,
  UpdateMemoryRequestSchema,
  type MemoryItemDto,
  type MemoryListResponse,
} from '@ensemble/shared';
import { requireUser } from '../auth';
import type { AppContext } from '../context';
import { badRequest } from '../errors';
import type { MemoryItem } from '../memory/types';

function parse<T>(schema: ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body);
  if (!r.success) throw badRequest('invalid_body', r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  return r.data;
}

const dto = (m: MemoryItem): MemoryItemDto => ({
  id: m.id,
  ns: m.ns,
  kind: m.kind,
  text: m.text,
  sourceRoomId: m.sourceRoomId,
  createdBy: m.createdBy,
  status: m.status === 'deleted' ? 'deleted' : 'active',
  createdAt: m.createdAt,
});

/** 모든 접근은 ctx.memory(gateway)를 거친다. */
export function memoryRoutes(app: FastifyInstance, ctx: AppContext): void {
  // 내 개인 기억: private + 공유 대상 Room별 항목
  app.get('/api/memory', async (req): Promise<MemoryListResponse> => {
    const user = requireUser(req);
    return { items: ctx.memory.listOwned(user.id).map(dto) };
  });

  app.post('/api/memory', async (req): Promise<MemoryItemDto> => {
    const user = requireUser(req);
    const body = parse(CreateMemoryRequestSchema, req.body);
    return dto(ctx.memory.createOwned(user.id, body));
  });

  // 항목별 공유 대상 지정·변경·해제 (ns를 private ↔ for:<Room>으로 옮긴다)
  app.patch('/api/memory/:id', async (req): Promise<MemoryItemDto> => {
    const user = requireUser(req);
    const { id } = req.params as { id: string };
    const body = parse(UpdateMemoryRequestSchema, req.body);
    return dto(ctx.memory.reshareOwned(user.id, id, body.ns));
  });

  app.delete('/api/memory/:id', async (req) => {
    const user = requireUser(req);
    const { id } = req.params as { id: string };
    ctx.memory.deleteOwned(user.id, id);
    return { ok: true };
  });

  // Room 구성원이 보는 그 Room의 기억 (room ns + 그 Room에 공유한 내 항목)
  app.get('/api/rooms/:id/memory', async (req): Promise<MemoryListResponse> => {
    const user = requireUser(req);
    const { id } = req.params as { id: string };
    return { items: ctx.memory.listForRoom(user.id, id).map(dto) };
  });
}
