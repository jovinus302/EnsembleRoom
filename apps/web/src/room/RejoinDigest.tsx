import { useCallback, useEffect, useMemo, useState } from 'react';
import type { DigestBoardChange, DigestResponse } from '@ensemble/shared';
import { api, ApiError } from '../api/client';
import { ApprovalCard, approvalViewFromDto } from '../messenger/ApprovalCards';
import { makeAgentResolver } from '../messenger/agentIdentity';
import { titleOf } from '../messenger/labels';
import { useDigestUi } from '../store/digestStore';
import { useRooms } from '../store/roomStore';
import { useSession } from '../store/session';
import { useWorld } from '../store/worldStore';
import { btn } from '../ui/tg';
import { Sheet } from './Sheet';

/** 보드 변화 종류별 아이콘 (목업 .dg .ic) */
const CHANGE_ICON: Record<DigestBoardChange['change'], { cls: string; glyph: string }> = {
  created: { cls: 'y', glyph: '✓' },
  agreed: { cls: 'y', glyph: '✓' },
  updated: { cls: 'm', glyph: '·' },
  commented: { cls: 'm', glyph: '·' },
  deleted: { cls: 'x', glyph: '×' },
};

const CHANGE_LABEL: Record<DigestBoardChange['change'], string> = {
  created: '새 카드',
  updated: '수정됨',
  deleted: '삭제됨',
  commented: '댓글',
  agreed: '합의',
};

/** Rejoin 직후 보이는 "내가 없는 동안" 요약: 요약문, 보드 변화, 내가 결정할 승인. [확인]하면 digest_viewed를 보낸다. */
export function RejoinDigest() {
  const roomId = useDigestUi((s) => s.roomId);
  if (!roomId) return null;
  return <DigestSheet key={roomId} roomId={roomId} />;
}

function DigestSheet({ roomId }: { roomId: string }) {
  const meId = useSession((s) => s.user!.id);
  const meAgent = useSession((s) => s.agent);
  const users = useWorld((s) => s.users);
  const room = useWorld((s) => s.rooms[roomId]);
  const slice = useRooms((s) => s.rooms[roomId]);
  const [digest, setDigest] = useState<DigestResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const close = useDigestUi((s) => s.close);

  useEffect(() => {
    let alive = true;
    api
      .digest(roomId)
      .then((d) => alive && setDigest(d))
      .catch((e) => alive && setError(e instanceof ApiError ? e.message : '다이제스트를 불러오지 못했어요'));
    return () => {
      alive = false;
    };
  }, [roomId]);

  const resolve = useMemo(
    () => makeAgentResolver(users, slice?.agents ?? [], slice?.events ?? [], { agent: meAgent }),
    [users, slice?.agents, slice?.events, meAgent],
  );
  const requesterName = useCallback(
    (by: string | null, kind: string) => (kind === 'human' ? (users[by ?? '']?.name ?? '누군가') : resolve(by).name),
    [users, resolve],
  );

  async function confirm() {
    setBusy(true);
    try {
      await api.digestViewed(roomId);
    } catch {
      /* 이미 확인했거나 상태가 바뀜: 닫는다 */
    }
    setBusy(false);
    close();
  }

  const title = room ? titleOf(room, meId, users) : 'Room';
  return (
    <Sheet title={`돌아온 것을 환영해요 · ${title}`} onClose={() => void confirm()} testId="rejoin-digest">
      {!digest && !error && <p className="tg-aux mt-4">내가 없는 동안의 일을 정리하는 중…</p>}
      {error && (
        <p role="alert" className="mt-4 text-body text-danger">
          {error}
        </p>
      )}
      {digest && (
        <div className="mt-3 flex flex-col gap-4 text-body">
          <p data-testid="digest-count" className="tg-aux">
            자리를 비운 동안 <b className="text-fg">{digest.missedCount}건</b>의 변화가 있었어요.
          </p>
          <section aria-label="요약">
            <h3 className="tg-mono mb-2">요약</h3>
            <p data-testid="digest-summary" className="tg-card whitespace-pre-wrap break-words p-3 text-aux leading-relaxed">
              {digest.summary ?? '요약할 내용이 없어요.'}
            </p>
          </section>
          <section aria-label="보드 변화">
            <h3 className="tg-mono mb-1">보드 변화</h3>
            {digest.boardChanges.length === 0 ? (
              <p className="tg-aux">보드에는 변화가 없었어요.</p>
            ) : (
              <ul className="tg-dg" data-testid="digest-board-changes">
                {digest.boardChanges.map((c, i) => (
                  <li key={`${c.cardId}-${i}`}>
                    <span className={`ic ${CHANGE_ICON[c.change].cls}`} aria-hidden="true">
                      {CHANGE_ICON[c.change].glyph}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{c.title}</span>
                    <span className="tg-chip">{CHANGE_LABEL[c.change]}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section aria-label="내가 결정할 승인">
            <h3 className="tg-mono mb-2">내가 결정할 승인 {digest.pendingApprovals.length}건</h3>
            {digest.pendingApprovals.length === 0 ? (
              <p className="tg-aux">대기 중인 승인이 없어요.</p>
            ) : (
              <ul className="flex flex-col gap-2" data-testid="digest-approvals">
                {digest.pendingApprovals.map((a) => (
                  <ApprovalCard
                    key={a.approvalId}
                    compact
                    view={approvalViewFromDto(a, requesterName(a.requestedBy, a.requestedByKind))}
                    meId={meId}
                    users={users}
                    onVoted={(item) =>
                      setDigest((d) =>
                        d ? { ...d, pendingApprovals: d.pendingApprovals.map((x) => (x.approvalId === item.approvalId ? item : x)) } : d,
                      )
                    }
                  />
                ))}
              </ul>
            )}
          </section>
          <div className="flex justify-end">
            <button type="button" data-testid="digest-confirm" disabled={busy} onClick={() => void confirm()} className={btn('primary')}>
              확인했어요
            </button>
          </div>
        </div>
      )}
    </Sheet>
  );
}
