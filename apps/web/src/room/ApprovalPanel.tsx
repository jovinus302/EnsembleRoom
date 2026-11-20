import { useMemo } from 'react';
import type { RoomEvent } from '@ensemble/shared';
import { ApprovalCard, approvalViewFromEvents } from '../messenger/ApprovalCards';
import type { RoomModel } from './useRoomModel';

type RequestedEvent = Extract<RoomEvent, { type: 'approval_requested' }>;

/** 이 Room의 승인. 대기 중이 위, 최근 처리된 것이 아래. 결정은 ApprovalCard가 vote API로 보낸다. */
export function ApprovalPanel({ model }: { model: RoomModel }) {
  const items = useMemo(() => {
    const requested = model.events.filter((e): e is RequestedEvent => e.type === 'approval_requested');
    const views = requested.map((e) =>
      approvalViewFromEvents(
        model.roomId,
        e,
        model.state.approvals[e.approvalId],
        e.actorKind === 'human' ? (model.users[e.actorId ?? '']?.name ?? '누군가') : model.resolveAgent(e.actorId).name,
      ),
    );
    const pending = views.filter((v) => v.status === 'pending');
    const done = views.filter((v) => v.status !== 'pending').slice(-3).reverse();
    return { pending, done };
  }, [model.events, model.roomId, model.state.approvals, model.users, model.resolveAgent]);

  return (
    <section aria-label="승인" data-testid="approval-panel" className="px-4 py-3">
      <h2 className="flex items-center gap-2 text-sm font-semibold">
        승인
        {items.pending.length > 0 && (
          <span className="rounded-full bg-[#ff9f43] px-2 text-[11px] font-semibold leading-5 text-[#0b1020]">대기 {items.pending.length}</span>
        )}
      </h2>
      {items.pending.length === 0 && items.done.length === 0 && <p className="mt-2 text-xs text-muted">승인할 일이 없어요.</p>}
      <ul className="mt-2 flex flex-col gap-2">
        {items.pending.map((v) => (
          <ApprovalCard key={v.approvalId} compact view={v} meId={model.meId} users={model.users} />
        ))}
        {items.done.map((v) => (
          <ApprovalCard key={v.approvalId} compact view={v} meId={model.meId} users={model.users} />
        ))}
      </ul>
    </section>
  );
}
