import type { FastifyInstance } from 'fastify';
import type { Capability, Mandate, VisitStatus } from '@ensemble/shared';
import { buildApp } from '../src/app';
import type { Config } from '../src/config';
import { createContext, type AppContext } from '../src/context';
import { openDb } from '../src/db/index';
import { SEED, seedDatabase } from '../src/db/seed';

export { SEED };

/** 인메모리 DB + 시드 + 서버 컨텍스트 */
export function makeCtx(config: Partial<Config> = {}): AppContext {
  const ctx = createContext(openDb(':memory:'), { agentMode: 'mock', ...config });
  seedDatabase(ctx);
  return ctx;
}

export async function makeApp(config: Partial<Config> = {}): Promise<{ ctx: AppContext; app: FastifyInstance }> {
  const ctx = makeCtx(config);
  const app = await buildApp(ctx);
  return { ctx, app };
}

let visitCounter = 0;
/** 방문 행을 직접 넣는다(방문 흐름 자체는 domain/visits.ts). */
export function insertVisit(
  ctx: AppContext,
  v: {
    hostRoomId: string;
    visitorUserId: string;
    visitorKind?: 'human' | 'agent';
    visitorAgentId?: string | null;
    status?: VisitStatus;
    permissions?: Capability[];
    mandate?: Mandate | null;
    startSeq?: number | null;
  },
): string {
  const id = `visit_test_${++visitCounter}`;
  ctx.db.raw
    .prepare(
      `INSERT INTO visits (id, host_room_id, visitor_kind, visitor_user_id, visitor_agent_id, status, permissions_json, mandate_json, start_seq)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      v.hostRoomId,
      v.visitorKind ?? 'human',
      v.visitorUserId,
      v.visitorAgentId ?? null,
      v.status ?? 'active',
      JSON.stringify(v.permissions ?? []),
      v.mandate ? JSON.stringify(v.mandate) : null,
      v.startSeq ?? null,
    );
  return id;
}

export async function loginAs(app: FastifyInstance, name: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/login', payload: { name } });
  return (res.json() as { token: string }).token;
}

export const auth = (token: string) => ({ authorization: `Bearer ${token}` });
