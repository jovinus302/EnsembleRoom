import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { UserDto } from '@ensemble/shared';
import type { AppContext } from './context';
import { DomainError, forbidden, unauthorized } from './errors';

// HOSTING: 이름 로그인 → 실제 인증. login()/authenticateToken()/requireUser()만 바꾸면 된다.

declare module 'fastify' {
  interface FastifyRequest {
    user: UserDto | null;
  }
}

/** 이름으로 로그인해 토큰 세션을 만든다. 시드 사용자는 로그인할 수 없다. */
export function login(ctx: AppContext, name: string): { token: string; user: UserDto } {
  const user = ctx.repo.getUserByName(name);
  if (!user) throw new DomainError(401, 'unknown_user', `알 수 없는 사용자: ${name}`);
  if (user.kind === 'seed') throw forbidden('seed_user', '시드 사용자는 로그인할 수 없습니다');
  const token = randomBytes(24).toString('base64url');
  ctx.repo.createSession(token, user.id);
  return { token, user };
}

export function authenticateToken(ctx: AppContext, token: string | undefined | null): UserDto | null {
  if (!token) return null;
  return ctx.repo.getSessionUser(token) ?? null;
}

function bearer(req: FastifyRequest): string | null {
  const h = req.headers.authorization;
  if (!h) return null;
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1]!.trim() : null;
}

export function registerAuth(app: FastifyInstance, ctx: AppContext): void {
  app.decorateRequest('user', null);
  app.addHook('onRequest', async (req) => {
    req.user = authenticateToken(ctx, bearer(req));
  });
}

export function requireUser(req: FastifyRequest): UserDto {
  if (!req.user) throw unauthorized();
  return req.user;
}
