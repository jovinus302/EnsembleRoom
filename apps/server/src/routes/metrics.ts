import type { FastifyInstance } from 'fastify';
import type { MetricsResponse } from '@ensemble/shared';
import { requireUser } from '../auth';
import type { AppContext } from '../context';
import { buildMetrics } from '../domain/metrics';

/** `GET /api/metrics[?roomId=]` — 요청자에게 보이는 이벤트만으로 계산한 지표 (S20). */
export function metricsRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/metrics', async (req): Promise<MetricsResponse> => {
    const user = requireUser(req);
    const { roomId } = req.query as { roomId?: string };
    return buildMetrics(ctx, user.id, roomId || undefined);
  });
}
