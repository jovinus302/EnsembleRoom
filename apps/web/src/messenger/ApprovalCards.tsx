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
import { ChannelBadge, ThreadLinkChip } from './InteractionChips';
import { btn } from '../ui/tg';

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
  /** Agent가 연 승인(A2H). threadSeq가 있으면 A2A 대화에서 나온 승인이다. */
  a2h?: { threadSeq: number | null };
  /** 이벤트 seq (data-seq 스크롤 앵커) */
  seq?: number;
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
    seq: event.seq,
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
      className="full prop"
      onSubmit={(e) => {
        e.preventDefault();
        const edited: EditProposal = { ...(proposal.cardId ? { cardId: proposal.cardId } : {}) };
        if (title.trim()) edited.title = title.trim();
        if (body.trim()) edited.body = body.trim();
        onSubmit(edited);
      }}
    >
      <label className="text-label text-muted">
        제목
        <input
          data-testid="approval-edit-title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className="mt-0.5 w-full rounded-md border border-line bg-bg px-2 py-1 text-aux text-fg"
        />
      </label>
      <label className="text-label text-muted">
        내용
        <textarea
          data-testid="approval-edit-body"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={3}
          className="mt-0.5 w-full resize-none rounded-md border border-line bg-bg px-2 py-1 text-aux text-fg"
        />
      </label>
      <div className="acts">
        <button type="submit" disabled={busy} data-testid="approval-edit-submit" className={btn('primary')}>
          수정해서 승인
        </button>
        <button type="button" onClick={onCancel} className={btn('ghost')}>
          취소
        </button>
      </div>
    </form>
  );
}

function ProposalBox({ label, p }: { label: string; p: EditProposal }) {
  return (
    <div className="full prop" data-testid="approval-proposal">
      <span className="tg-mono">{label}</span>
      {p.title && <span className="font-semibold">{p.title}</span>}
      {p.body && <span className="whitespace-pre-wrap break-words">{p.body}</span>}
    </div>
  );
}

/**
 * 승인 카드 (Tide Glass `tg-appr`). 앰버 단일색(pending) → 아쿠아(approved) / 흐림(rejected).
 * - 결정형(options): 선택지 버튼. 수정안(proposal): 승인 / 수정해서 승인 / 거절. takeout·visit: 승인 / 거절.
 * - 결정은 POST /api/approvals/:id/vote. 오류 코드별 문구로 안내한다.
 * - compact는 한 줄 행(요약 + 승인 버튼). 제안·투표·수정 폼처럼 긴 내용은 아래 줄(.full)로 내려간다.
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
  const pending = status === 'pending';
  const rejected = status === 'rejected';
  const kindText = view.a2h ? 'A2H' : APPROVAL_KIND_LABEL[view.kind];
  const stateText = pending ? '승인 대기' : OUTCOME_LABEL[status];
  const monoStyle = pending ? { color: 'var(--amber-ink)' } : { color: rejected ? 'var(--destructive-ink)' : 'var(--fg)' };
  const outcomeText = pending
    ? ''
    : `${OUTCOME_LABEL[status]}${status === 'approved' && view.resolvedOption ? ` · ${view.resolvedOption}` : ''}`;
  const outcomeChip = !pending && (
    <span data-testid="approval-outcome" className={`tg-chip ${rejected ? 'err' : 'badge-ok'}`} title={outcomeText}>
      {outcomeText}
    </span>
  );
  // compact 행에는 버튼이 한 줄에 들어갈 때만 인라인으로 둔다
  const simpleActs = !view.options && !(view.kind === 'edit' && view.proposal);
  const strike = rejected ? { textDecoration: 'line-through', textDecorationColor: 'var(--destructive)' } : undefined;

  const actions = (
    <>
      {view.options ? (
        view.options.map((o) => (
          <button
            key={o}
            type="button"
            disabled={busy}
            className={btn('primary')}
            data-testid="approval-option"
            onClick={() => void decide('approve', { option: o })}
          >
            {o}
          </button>
        ))
      ) : (
        <button type="button" disabled={busy} className={btn('primary')} data-testid="approval-approve" onClick={() => void decide('approve')}>
          승인
        </button>
      )}
      {view.kind === 'edit' && view.proposal && (
        <button type="button" disabled={busy} className={btn('soft')} data-testid="approval-edit" onClick={() => setEditing(true)}>
          수정해서 승인
        </button>
      )}
      <button type="button" disabled={busy} className={btn('dghost')} data-testid="approval-reject" onClick={() => void decide('reject')}>
        거절
      </button>
      {onOpenRoom && (
        <button type="button" onClick={onOpenRoom} className={`${btn('ghost')} ml-auto`}>
          Room 열기
        </button>
      )}
    </>
  );

  return (
    <li
      data-testid="approval-card"
      data-status={status}
      data-kind={view.kind}
      data-seq={view.seq}
      data-actionable={actionable ? 'true' : 'false'}
      className={`tg-card tg-appr anim-card ${status}${pending ? ' live' : ''}${compact ? ' compact' : ' max-w-[560px] self-center'} my-1 w-full`}
    >
      {compact ? (
        <>
          <span className="tg-mono" style={monoStyle}>
            {kindText}
          </span>
          <span className="sum" title={view.summary} style={strike}>
            {view.summary}
          </span>
          {outcomeChip}
          {actionable && !editing && simpleActs && <span className="acts">{actions}</span>}
          {actionable && !editing && !simpleActs && <div className="full acts">{actions}</div>}
          {view.publicRationale && <p className="full text-aux text-muted">이유 · {view.publicRationale}</p>}
        </>
      ) : (
        <>
          <div className="hd">
            <span className="tg-mono" style={monoStyle}>
              {kindText} · {stateText}
            </span>
            {pending ? (
              <span className="tg-mono">{view.ts ? fmtTime(view.ts) : ''}</span>
            ) : (
              <span className="inline-flex items-center gap-2">
                <svg className="chk" width="22" height="18" viewBox="0 0 18 18" aria-hidden="true" style={rejected ? { display: 'none' } : undefined}>
                <path d="M3 9l4 4 8-9" fill="none" stroke="var(--primary)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
                {outcomeChip}
              </span>
            )}
          </div>
          <div className="route" data-testid={view.a2h ? 'a2h-header' : undefined}>
            {view.a2h && <ChannelBadge channel="a2h" />}
            <span>{view.requesterName}</span>
            <em>→</em>
            <span data-testid={view.a2h ? 'a2h-approvers' : undefined}>{approverNames}</span>
            {view.a2h && <em>· 승인 요청</em>}
            {view.roomTitle && <em>· {view.roomTitle}</em>}
            {view.a2h && view.a2h.threadSeq !== null && <ThreadLinkChip label="A2A 대화에서" threadSeq={view.a2h.threadSeq} />}
          </div>
          <p className="sum whitespace-pre-wrap break-words" style={strike ? { ...strike, opacity: 0.8 } : undefined}>
            {view.summary}
          </p>
          {view.publicRationale && <p className="text-aux text-muted">이유 · {view.publicRationale}</p>}
        </>
      )}

      {view.proposal && (
        <div className="extra full">
          <div>
            <ProposalBox
              label={view.proposal.cardId ? `카드 수정안 · ${view.proposal.cardId.slice(0, 8)}` : '새 카드 제안'}
              p={view.proposal}
            />
          </div>
        </div>
      )}
      {view.applied && !pending && <ProposalBox label="보드에 반영된 내용" p={view.applied} />}

      {votes.length > 0 && (
        <ul className="full flex flex-wrap gap-1.5" data-testid="approval-votes">
          {votes.map(([uid, d]) => {
            const det = view.voteDetail?.[uid];
            return (
              <li key={uid} className="tg-chip warn !normal-case !tracking-normal">
                {nameOf(uid)} · {VOTE_LABEL[d]}
                {det?.option ? ` (${det.option})` : ''}
              </li>
            );
          })}
        </ul>
      )}

      {!compact && actionable && !editing && <div className="acts">{actions}</div>}
      {actionable && editing && view.proposal && (
        <EditForm
          proposal={view.proposal}
          busy={busy}
          onCancel={() => setEditing(false)}
          onSubmit={(edited) => void decide('edit', { edited })}
        />
      )}
      {!actionable && pending && (
        <p className="full text-aux text-muted" data-testid="approval-waiting">
          {myVote ? '내 결정을 기록했어요 · ' : ''}승인 대기 · {approverNames}
        </p>
      )}
      {!compact && !pending && view.ts && (
        <p className="text-aux text-muted">
          {view.requesterName} 요청 · {fmtTime(view.ts)}
        </p>
      )}

      {note && (
        <p role={note.kind === 'error' ? 'alert' : 'status'} className={`full text-aux ${note.kind === 'error' ? 'text-danger' : 'text-muted'}`}>
          {note.text}
        </p>
      )}
    </li>
  );
}
