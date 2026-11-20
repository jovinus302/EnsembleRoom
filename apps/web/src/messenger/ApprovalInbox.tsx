import { useEffect, useState } from 'react';
import { navigate } from '../router';
import { useApprovalInbox } from '../store/approvalStore';
import { useSession } from '../store/session';
import { useWorld } from '../store/worldStore';
import { ApprovalCard, approvalViewFromDto } from './ApprovalCards';
import { APPROVAL_ORANGE } from './visits';

/** 사이드바 "내 승인 대기": 모든 Room에서 내가 결정해야 하는 승인. 배지 + 펼치면 목록(바로 결정 가능). */
export function ApprovalInbox() {
  const meId = useSession((s) => s.user!.id);
  const users = useWorld((s) => s.users);
  const rooms = useWorld((s) => s.rooms);
  const items = useApprovalInbox((s) => s.items);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    void useApprovalInbox.getState().load();
  }, []);

  const n = items.length;
  return (
    <section aria-label="내 승인 대기" className="mt-5" data-testid="approval-inbox">
      <button
        type="button"
        aria-expanded={open}
        data-testid="approval-inbox-toggle"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-4 pb-1 text-left text-xs font-medium tracking-wide text-muted hover:text-fg"
      >
        <span aria-hidden="true" className="inline-block transition-transform" style={{ transform: open ? 'rotate(90deg)' : undefined }}>
          ›
        </span>
        내 승인 대기
        <span
          data-testid="approval-inbox-badge"
          aria-label={`승인 대기 ${n}건`}
          className="ml-auto rounded-full px-1.5 text-[11px] font-semibold leading-5 text-[#0b1020]"
          style={{ background: n > 0 ? APPROVAL_ORANGE : 'var(--line)', color: n > 0 ? '#0b1020' : 'var(--muted)' }}
        >
          {n}
        </span>
      </button>
      {open && (
        <ul className="flex flex-col gap-2 px-2" data-testid="approval-inbox-list">
          {n === 0 && <li className="px-2 py-1 text-xs text-muted">결정할 승인이 없어요.</li>}
          {items.map((a) => {
            const requester =
              a.requestedByKind === 'human' ? (users[a.requestedBy ?? '']?.name ?? '누군가') : a.requestedByKind === 'system' ? '시스템' : 'Agent';
            const room = rooms[a.roomId];
            return (
              <ApprovalCard
                key={a.approvalId}
                compact
                view={approvalViewFromDto(a, requester)}
                meId={meId}
                users={users}
                onOpenRoom={room && room.kind !== 'dm' ? () => navigate(`/room/${a.roomId}`) : undefined}
              />
            );
          })}
        </ul>
      )}
    </section>
  );
}
