import { api } from '../api/client';
import { useDigestUi } from '../store/digestStore';

/** Rejoin: 놓친 변화가 있으면 다이제스트 시트를 연다(확인하면 digest_viewed). */
export async function rejoinAndShowDigest(roomId: string): Promise<number> {
  const r = await api.rejoin(roomId);
  if (r.missedCount > 0) useDigestUi.getState().open(roomId);
  return r.missedCount;
}
