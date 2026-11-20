import { useState } from 'react';
import type {
  ApprovalItemDto,
  ApprovalKind,
  ApprovalOutcome,
  ApprovalState,
  EditProposal,
  RoomEvent,
  UserDto,
  VoteDecision,
} from '@ensemble/shared';
import { api, voteErrorText } from '../api/client';
import { useApprovalInbox } from '../store/approvalStore';
import { APPROVAL_ORANGE } from './visits';

export const APPROVAL_KIND_LABEL: Record<ApprovalKind, string> = {
  edit: '수정 제안',
  decision: '결정 요청',
  visit: '방문 승인',
  takeout: '가져가기 승인',
};

const OUTCOME_LABEL: Record<ApprovalOutcome, string> = {
  approved: '승인됨',
  edited: '수정되어 반영됨',
  rejected: '거절됨',
};

const VOTE_LABEL: Record<VoteDecision, string> = { approve: '승인', edit: '수정 승인', reject: '거절' };

const fmtTime = (ts: number) => new Date(ts).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });

/** 승인 카드가 그리는 정보. Room 이벤트에서도, REST DTO(인박스·다이제스트)에서도 만든다. */
export interface ApprovalView {
  roomId: string;
  roomTitle?: string;
  approvalId: string;
  kind: ApprovalKind;
  summary: string;
  publicRationale: string | null;
  options?: string[];
  proposal?: EditProposal;
  approvers: string[];
  votes: Record<string, VoteDecision>;
  status: 'pending' | ApprovalOutcome;
  requesterName: string;
  ts?: number;
  /** 확정된 선택지 (decision형) */
  resolvedOption?: string | null;
  /** 실제로 반영된 수정안 */
  applied?: EditProposal;
  /** 투표자별로 고른 선택지 / 수정안 (approval_voted 이벤트) */
  voteDetail?: Record<string, { option?: string; edited?: EditProposal }>;
}

type ApprovalRequestedEvent = Extract<RoomEvent, { type: 'approval_requested' }>;

/** shared가 리듀싱한 ApprovalState(투표 선택지·수정본·확정 값 포함)로 승인 카드 정보를 만든다 */
export function approvalViewFromEvents(
  roomId: string,
  event: ApprovalRequestedEvent,
  state: ApprovalState | undefined,
  requesterName: string,
): ApprovalView {
  const voteDetail: NonNullable<ApprovalView['voteDetail']> = {};
  for (const uid of Object.keys(state?.votes ?? {})) {
    voteDetail[uid] = { option: state?.voteOptions?.[uid], edited: state?.voteEdits?.[uid] };
  }
  return {
    roomId,
    approvalId: event.approvalId,
    kind: event.kind,
    summary: event.summary,
    publicRationale: event.publicRationale ?? null,
    options: event.options,
    proposal: event.proposal,
    approvers: event.approvers,
    votes: state?.votes ?? {},
    status: state?.status ?? 'pending',
    requesterName,
    ts: event.ts,
    resolvedOption: state?.resolvedOption ?? null,
    applied: state?.appliedProposal,
    voteDetail,
  };
}

export function approvalViewFromDto(a: ApprovalItemDto, requesterName: string): ApprovalView {
  return {
    roomId: a.roomId,
    roomTitle: a.roomTitle,
    approvalId: a.approvalId,
    kind: a.kind,
    summary: a.summary,
    publicRationale: a.publicRationale,
    options: a.options,
    proposal: a.proposal,
    approvers: a.approvers,
    votes: a.votes,
    status: a.status,
    requesterName,
    resolvedOption: a.resolvedOption,
  };
}

const primary =
  'rounded-md px-3 py-1.5 text-sm font-semibold text-[#0b1020] transition hover:brightness-110 disabled:opacity-50';
const ghost = 'rounded-md border px-3 py-1.5 text-sm transition hover:bg-white/5 disabled:opacity-50';

function EditForm({
  proposal,
  busy,
  onSubmit,
  onCancel,
}: {
  proposal: EditProposal;
  busy: boolean;
  onSubmit: (edited: EditProposal) => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState(proposal.title ?? '');
  const [body, setBody] = useState(proposal.body ?? '');
  return (
    <form
      data-testid="approval-edit-form"
      className="mt-3 flex flex-col gap-2 rounded-lg border bg-bg/60 p-2.5"
      style={{ borderColor: `${APPROVAL_ORANGE}88` }}
      onSubmit={(e) => {
        e.preventDefault();
        const edited: EditProposal = { ...(proposal.cardId ? { cardId: proposal.cardId } : {}) };
        if (title.trim()) edited.title = title.trim();
        if (body.trim()) edited.body = body.trim();
        onSubmit(edited);
      }}
    >
      <label className="text-[11px] text-muted">
        제목
        <input
          data-testid="approval-edit-title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className="mt-0.5 w-full rounded-md border border-line bg-bg px-2 py-1 text-sm text-fg"
        />
      </label>
      <label className="text-[11px] text-muted">
        내용
        <textarea
          data-testid="approval-edit-body"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={3}
          className="mt-0.5 w-full resize-none rounded-md border border-line bg-bg px-2 py-1 text-sm text-fg"
        />
      </label>
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={busy}
          data-testid="approval-edit-submit"
          className={primary}
          style={{ background: APPROVAL_ORANGE }}
        >
          수정해서 승인
        </button>
        <button type="button" onClick={onCancel} className={ghost} style={{ borderColor: 'var(--line)' }}>
          취소
        </button>
      </div>
    </form>
  );
}

function ProposalBox({ label, p }: { label: string; p: EditProposal }) {
  return (
    <div className="mt-2.5 rounded-lg border border-line bg-bg/60 p-2.5" data-testid="approval-proposal">
      <div className="text-[11px] text-muted">{label}</div>
      {p.title && <div className="mt-0.5 font-semibold">{p.title}</div>}
      {p.body && <div className="mt-0.5 whitespace-pre-wrap break-words text-[13px] text-fg/90">{p.body}</div>}
    </div>
  );
}

/**
 * 승인 카드. 주황(승인 전용 색)으로 강조한다.
 * - 결정형(options): 선택지 버튼. 수정안(proposal): 승인 / 수정해서 승인 / 거절. takeout·visit: 승인 / 거절.
 * - 결정은 POST /api/approvals/:id/vote. 오류 코드별 문구로 안내한다.
 */
export function ApprovalCard({
  view,
  meId,
  users,
  compact = false,
  onOpenRoom,
  onVoted,
}: {
  view: ApprovalView;
  meId: string;
  users: Record<string, UserDto>;
  compact?: boolean;
  onOpenRoom?: () => void;
  /** 투표가 서버에 반영된 뒤 최신 항목을 돌려준다 */
  onVoted?: (item: ApprovalItemDto) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [note, setNote] = useState<{ kind: 'info' | 'error'; text: string } | null>(null);
  const status = view.status;
  const myVote = view.votes[meId];
  const isApprover = view.approvers.includes(meId);
  const actionable = status === 'pending' && isApprover && myVote === undefined;
  const nameOf = (id: string) => (id === meId ? '나' : (users[id]?.name ?? id));
  const approverNames = view.approvers.map(nameOf).join(', ');

  async function decide(decision: VoteDecision, extra?: { option?: string; edited?: EditProposal }) {
    setBusy(true);
    setNote(null);
    try {
      const r = await api.vote(view.approvalId, {
        decision,
        ...(extra?.option ? { option: extra.option } : {}),
        ...(extra?.edited ? { edited: extra.edited as Record<string, unknown> } : {}),
      });
      useApprovalInbox.getState().applyItem(r.approval, meId);
      onVoted?.(r.approval);
      setEditing(false);
      setNote({
        kind: 'info',
        text: r.status === 'pending' ? '내 결정을 보냈어요. 다른 승인자를 기다려요.' : `결정이 반영됐어요 · ${OUTCOME_LABEL[r.status]}`,
      });
    } catch (e) {
      setNote({ kind: 'error', text: voteErrorText(e) });
    } finally {
      setBusy(false);
    }
  }

  const votes = Object.entries(view.votes);

  return (
    <li
      data-testid="approval-card"
      data-status={status}
      data-kind={view.kind}
      data-actionable={actionable ? 'true' : 'false'}
      className={`anim-card my-1 w-full rounded-xl p-3.5 text-sm ${status === 'pending' ? 'approval-pending border-2' : 'border'} ${compact ? '' : 'max-w-[560px] self-center'}`}
      style={
        {
          // 색 값(PALETTE.approvalOrange)은 그대로 두고, L1(승인)이 가장 눈에 띄도록 두꺼운 테두리·왼쪽 띠·글로우(approval-pending, index.css)로 보강한다
          '--glow': APPROVAL_ORANGE,
          borderColor: status === 'pending' ? APPROVAL_ORANGE : `${APPROVAL_ORANGE}66`,
          background: `${APPROVAL_ORANGE}${status === 'pending' ? '1f' : '0a'}`,
        } as React.CSSProperties
      }
    >
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="rounded-full px-2 py-0.5 font-semibold text-[#0b1020]" style={{ background: APPROVAL_ORANGE }}>
          {status === 'pending' && <span aria-hidden="true" className="approval-dot mr-1.5 inline-block h-1.5 w-1.5 rounded-full bg-[#0b1020] align-middle" />}
          {APPROVAL_KIND_LABEL[view.kind]}
        </span>
        <span className="text-muted">
          {view.roomTitle ? `${view.roomTitle} · ` : ''}
          {view.requesterName} 요청{view.ts ? ` · ${fmtTime(view.ts)}` : ''}
        </span>
        {status !== 'pending' && (
          <span className="ml-auto font-medium" style={{ color: APPROVAL_ORANGE }} data-testid="approval-outcome">
            {OUTCOME_LABEL[status]}
            {status === 'approved' && view.resolvedOption ? ` · ${view.resolvedOption}` : ''}
          </span>
        )}
      </div>

      <p className="mt-2 whitespace-pre-wrap break-words font-medium leading-relaxed">{view.summary}</p>
      {view.publicRationale && <p className="mt-1 text-xs text-muted">이유 · {view.publicRationale}</p>}

      {view.proposal && (
        <ProposalBox
          label={view.proposal.cardId ? `카드 수정안 · ${view.proposal.cardId.slice(0, 8)}` : '새 카드 제안'}
          p={view.proposal}
        />
      )}
      {view.applied && status !== 'pending' && <ProposalBox label="보드에 반영된 내용" p={view.applied} />}

      {votes.length > 0 && (
        <ul className="mt-2 flex flex-wrap gap-1.5 text-[11px]" data-testid="approval-votes">
          {votes.map(([uid, d]) => {
            const det = view.voteDetail?.[uid];
            return (
              <li key={uid} className="rounded-full border px-2 py-0.5" style={{ borderColor: `${APPROVAL_ORANGE}88` }}>
                {nameOf(uid)} · {VOTE_LABEL[d]}
                {det?.option ? ` (${det.option})` : ''}
              </li>
            );
          })}
        </ul>
      )}

      {actionable && !editing && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {view.options ? (
            view.options.map((o) => (
              <button
                key={o}
                type="button"
                disabled={busy}
                className={primary}
                style={{ background: APPROVAL_ORANGE }}
                data-testid="approval-option"
                onClick={() => void decide('approve', { option: o })}
              >
                {o}
              </button>
            ))
          ) : (
            <button
              type="button"
              disabled={busy}
              className={primary}
              style={{ background: APPROVAL_ORANGE }}
              data-testid="approval-approve"
              onClick={() => void decide('approve')}
            >
              승인
            </button>
          )}
          {view.kind === 'edit' && view.proposal && (
            <button
              type="button"
              disabled={busy}
              className={ghost}
              style={{ borderColor: APPROVAL_ORANGE, color: APPROVAL_ORANGE }}
              data-testid="approval-edit"
              onClick={() => setEditing(true)}
            >
              수정해서 승인
            </button>
          )}
          <button
            type="button"
            disabled={busy}
            className={ghost}
            style={{ borderColor: APPROVAL_ORANGE, color: APPROVAL_ORANGE }}
            data-testid="approval-reject"
            onClick={() => void decide('reject')}
          >
            거절
          </button>
          {onOpenRoom && (
            <button type="button" onClick={onOpenRoom} className="ml-auto text-xs text-muted underline-offset-2 hover:underline">
              Room 열기
            </button>
          )}
        </div>
      )}
      {actionable && editing && view.proposal && (
        <EditForm
          proposal={view.proposal}
          busy={busy}
          onCancel={() => setEditing(false)}
          onSubmit={(edited) => void decide('edit', { edited })}
        />
      )}
      {!actionable && status === 'pending' && (
        <p className="mt-2 text-xs text-muted" data-testid="approval-waiting">
          {myVote ? '내 결정을 기록했어요 · ' : ''}승인 대기 · {approverNames}
        </p>
      )}

      {note && (
        <p role={note.kind === 'error' ? 'alert' : 'status'} className={`mt-2 text-xs ${note.kind === 'error' ? 'text-red-300' : 'text-muted'}`}>
          {note.text}
        </p>
      )}
    </li>
  );
}
