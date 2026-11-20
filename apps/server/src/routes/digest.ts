import type { FastifyInstance } from 'fastify';
import type { DigestResponse } from '@ensemble/shared';
import { requireUser } from '../auth';
import type { AppContext } from '../context';

/**
 * Rejoin 다이제스트 (계획 7절): `left_at_seq` 이후 요청자에게 보이는 이벤트의 요약 + 보드 변화 + 대기 중인 승인.
 * 자리를 비운 적이 없으면 leftAtSeq/summary가 null이다. Room에 접근할 수 없으면 403.
 */
export function digestRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/rooms/:id/digest', async (req): Promise<DigestResponse> => {
    const user = requireUser(req);
    const { id } = req.params as { id: string };
    return ctx.summarizer.digest(user.id, id);
  });
}
