import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import type { HealthResponse } from '@ensemble/shared';
import { authenticateToken, registerAuth } from './auth';
import type { AppContext } from './context';
import { DomainError } from './errors';
import type { WsLike } from './realtime/hub';
import { approvalRoutes } from './routes/approvals';
import { authRoutes } from './routes/auth';
import { digestRoutes } from './routes/digest';
import { memoryRoutes } from './routes/memory';
import { metricsRoutes } from './routes/metrics';
import { roomRoutes } from './routes/rooms';
import { visitRoutes } from './routes/visits';

/** HTTP + WS 서버를 조립한다. index.ts와 테스트가 같은 함수를 쓴다. */
export async function buildApp(ctx: AppContext, opts: { logger?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ? { level: 'info' } : false });
  await app.register(websocket);
  registerAuth(app, ctx);

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof DomainError) {
      return reply.status(err.status).send({ error: err.message, code: err.code, ...err.data });
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500) return reply.status(status).send({ error: (err as Error).message, code: 'bad_request' });
    app.log.error(err);
    return reply.status(500).send({ error: 'internal_error', code: 'internal' });
  });

  app.get('/api/health', async (): Promise<HealthResponse> => ({
    ok: true,
    service: 'ensemble-room-server',
    time: new Date().toISOString(),
    agentMode: ctx.config.agentMode,
  }));

  authRoutes(app, ctx);
  roomRoutes(app, ctx);
  visitRoutes(app, ctx);
  memoryRoutes(app, ctx);
  approvalRoutes(app, ctx);
  digestRoutes(app, ctx);
  metricsRoutes(app, ctx);

  // /ws?token=<세션 토큰>. 인증 실패는 4401로 닫는다.
  app.get('/ws', { websocket: true }, (socket, req) => {
    const token = (req.query as { token?: string }).token;
    const user = authenticateToken(ctx, token);
    if (!user) {
      socket.close(4401, 'unauthorized');
      return;
    }
    ctx.hub.register(socket as unknown as WsLike, user);
  });

  return app;
}
