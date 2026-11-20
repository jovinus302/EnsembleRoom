import type { FastifyInstance } from 'fastify';
import { LoginRequestSchema, type LoginResponse, type MeResponse, type UsersResponse } from '@ensemble/shared';
import { login, requireUser } from '../auth';
import type { AppContext } from '../context';
import { Repo } from '../db/repo';
import { badRequest } from '../errors';

export function authRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post('/api/login', async (req): Promise<LoginResponse> => {
    const body = LoginRequestSchema.safeParse(req.body);
    if (!body.success) throw badRequest('invalid_body', 'name이 필요합니다');
    return login(ctx, body.data.name);
  });

  app.get('/api/me', async (req): Promise<MeResponse> => {
    const user = requireUser(req);
    const agent = ctx.repo.getAgentByOwner(user.id);
    return { user, agent: agent ? Repo.agentDto(agent) : null };
  });

  app.get('/api/users', async (req): Promise<UsersResponse> => {
    requireUser(req);
    return { users: ctx.repo.listUsers() };
  });
}
