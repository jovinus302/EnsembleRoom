import { useState } from 'react';
import { VISITOR_GRANTABLE, type Capability, type RoomEvent, type UserDto, type WorldRoom } from '@ensemble/shared';
import { api, ApiError } from '../api/client';
import { MandateBlock } from './MandateBlock';
import { APPROVAL_ORANGE, CAPABILITY_LABEL, END_REASON_LABEL, type VisitState } from './visits';

type VisitEvent = Extract<RoomEvent, { type: 'visit_requested' | 'visit_accepted' | 'visit_declined' | 'visit_ended' }>;
export const isVisitEvent = (e: RoomEvent): e is VisitEvent =>
  e.type === 'visit_requested' || e.type === 'visit_accepted' || e.type === 'visit_declined' || e.type === 'visit_ended';

const fmtTime = (ts: number) => new Date(ts).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });

/** 이 대화에서 내가 방문의 호스트인가. My Room은 소유자, DM은 방문자가 아닌 쪽. */
function amHost(room: WorldRoom | undefined, meId: string, state: VisitState): boolean {
  if (!room) return false;
  if (room.kind === 'my') return room.ownerId === meId;
  return state.visitorUserId !== meId;
}

function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '요청에 실패했습니다');
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, run };
}

function AcceptForm({ visitId }: { visitId: string }) {
  const [perms, setPerms] = useState<Capability[]>(['chat', 'comment']);
  const { busy, error, run } = useAction();
  const toggle = (c: Capability) => setPerms((p) => (p.includes(c) ? p.filter((x) => x !== c) : [...p, c]));
  return (
    <div className="mt-3 flex flex-col gap-2">
      <fieldset className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        <legend className="mb-1 text-muted">허용할 권한</legend>
        {VISITOR_GRANTABLE.map((c) => (
          <label key={c} className="flex items-center gap-1">
            <input type="checkbox" checked={perms.includes(c)} onChange={() => toggle(c)} />
            {CAPABILITY_LABEL[c]}
          </label>
        ))}
      </fieldset>
      <div className="flex gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => void run(() => api.acceptVisit(visitId, { permissions: perms }))}
          className="rounded-md px-3 py-1 text-xs font-semibold text-[#0b1020] disabled:opacity-50"
          style={{ background: APPROVAL_ORANGE }}
        >
          수락
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void run(() => api.declineVisit(visitId))}
          className="rounded-md border border-line px-3 py-1 text-xs hover:bg-raised disabled:opacity-50"
        >
          거절
        </button>
      </div>
      {error && (
        <p role="alert" className="text-xs text-red-300">
          {error}
        </p>
      )}
    </div>
  );
}

function EndButton({ visitId }: { visitId: string }) {
  const { busy, error, run } = useAction();
  return (
    <div className="mt-3">
      <button
        type="button"
        disabled={busy}
        onClick={() => void run(() => api.endVisit(visitId))}
        className="rounded-md border border-line px-3 py-1 text-xs hover:bg-raised disabled:opacity-50"
      >
        방문 종료
      </button>
      {error && (
        <p role="alert" className="mt-1 text-xs text-red-300">
          {error}
        </p>
      )}
    </div>
  );
}

/** 방문 요청/수락/거절/종료 이벤트 카드. 상태 변화 버튼은 요청 카드에만 붙는다(현재 상태 기준). */
export function VisitCard({
  event,
  state,
  room,
  meId,
  users,
}: {
  event: VisitEvent;
  state: VisitState | undefined;
  room: WorldRoom | undefined;
  meId: string;
  users: Record<string, UserDto>;
}) {
  if (!state) return null;
  const visitor = users[state.visitorUserId];
  const visitorName = visitor?.name ?? '알 수 없음';
  const color = visitor?.color ?? '#a0aec4';
  const who = state.visitorKind === 'agent' ? `${visitorName}의 Agent` : visitorName;
  const host = amHost(room, meId, state);
  const iAmVisitor = state.visitorUserId === meId;

  let title: string;
  let accent = color;
  let detail: string | null = null;
  switch (event.type) {
    case 'visit_requested':
      title = state.visitorKind === 'agent' ? `${who}를 보내고 싶어 해요` : `${who}님이 방문을 요청했어요`;
      if (state.status === 'requested') accent = APPROVAL_ORANGE;
      break;
    case 'visit_accepted':
      title = '방문이 수락됐어요';
      detail = event.permissions.length ? `허용: ${event.permissions.map((c) => CAPABILITY_LABEL[c]).join(', ')}` : '허용된 권한 없음(보기만)';
      break;
    case 'visit_declined':
      title = '방문 요청이 거절됐어요';
      break;
    case 'visit_ended':
      title = '방문이 끝났어요';
      detail = END_REASON_LABEL[event.reason];
      break;
  }

  const showButtons = event.type === 'visit_requested';
  return (
    <li
      data-testid="visit-card"
      data-visit-event={event.type}
      data-visit-status={state.status}
      className="mx-auto w-full max-w-[480px] rounded-xl border bg-raised/60 px-4 py-3 text-sm"
      style={{ borderColor: accent }}
    >
      <div className="flex items-center gap-2">
        <span aria-hidden="true" className="h-2.5 w-2.5 rounded-full" style={{ background: accent }} />
        <span className="font-medium" style={{ color: event.type === 'visit_requested' ? accent : undefined }}>
          {title}
        </span>
        <span className="ml-auto text-[11px] text-muted">{fmtTime(event.ts)}</span>
      </div>
      {detail && <p className="mt-1 text-xs text-muted">{detail}</p>}
      {event.type === 'visit_requested' && state.visitorKind === 'agent' && state.mandate && (
        <MandateBlock mandate={state.mandate} ownerName={visitorName} color={color} viewerIsOwner={iAmVisitor} />
      )}
      {event.type === 'visit_requested' && (
        <p className="mt-1 text-xs text-muted">
          현재 상태:{' '}
          {{ requested: '승인 대기', active: '방문 중', declined: '거절됨', ended: '종료됨' }[state.status]}
        </p>
      )}
      {showButtons && state.status === 'requested' && host && <AcceptForm visitId={state.visitId} />}
      {showButtons && state.status === 'requested' && !host && iAmVisitor && (
        <p className="mt-2 text-xs" style={{ color: APPROVAL_ORANGE }}>
          호스트의 승인을 기다리는 중…
        </p>
      )}
      {showButtons && state.status === 'active' && (host || iAmVisitor) && <EndButton visitId={state.visitId} />}
    </li>
  );
}
