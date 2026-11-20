import type { FastifyInstance } from 'fastify';
import { requireUser } from '../auth';
import type { AppContext } from '../context';
import { canAccessRoom, roomStateOf } from '../domain/rooms';
import { notFound } from '../errors';
import { COVER_MIME } from '../media/covers';

/**
 * GET /api/media/:assetId — 보드 도구 커버 이미지(로컬 캐시). Bearer 인증 + 해당 Room 열람 권한 필수.
 * 서리 유리 방 등 접근 불가 Room의 자산은 존재 여부도 드러내지 않도록 404로 답한다.
 */
export function mediaRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/media/:assetId', async (req, reply) => {
    const user = requireUser(req);
    const { assetId } = req.params as { assetId: string };
    const asset = ctx.covers.readAsset(assetId);
    if (!asset || !canAccessRoom(ctx, user.id, asset.meta.roomId)) throw notFound('asset_not_found', '존재하지 않는 이미지');
    // 도구가 내려갔거나 이 자산이 더는 그 도구의 커버가 아니면 내보내지 않는다
    const tool = roomStateOf(ctx, asset.meta.roomId).boardTools[asset.meta.toolId];
    if (!tool || tool.removed || tool.cover?.assetId !== assetId) throw notFound('asset_not_found', '존재하지 않는 이미지');
    return reply
      .header('Content-Type', COVER_MIME[asset.meta.ext])
      .header('Cache-Control', 'private, max-age=86400')
      .header('X-Content-Type-Options', 'nosniff')
      .send(asset.bytes);
  });
}
