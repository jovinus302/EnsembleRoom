import { useEffect, useMemo, useState } from 'react';
import { relation, THEMES } from '@ensemble/shared';
import { api, ApiError } from '../api/client';
import { closeRoom, markSeen, openRoom, type SnapshotResult } from '../api/ws';
import { MemoryPanel } from '../messenger/MemoryPanel';
import { AMBIENCE_LABEL, KIND_LABEL, titleOf } from '../messenger/labels';
import { APPROVAL_ORANGE } from '../messenger/visits';
import { navigate } from '../router';
import { useDigestUi } from '../store/digestStore';
import { useWorld } from '../store/worldStore';
import { ActivityFeed } from './ActivityFeed';
import { AgentStatusList } from './AgentStatusList';
import { ApprovalPanel } from './ApprovalPanel';
import { InteractionStrip } from './InteractionStrip';
import { BoardPanel } from './BoardPanel';
import { LeaveSheet } from './LeaveSheet';
import { RoomStage } from './RoomStage';
import { SendAgentSheet } from './SendAgentSheet';
import { GuideButton, TourHost } from '../onboarding/Tour';
import { TimelineScrubber } from './TimelineScrubber';
import { rejoinAndShowDigest } from './actions';
import { useRoomModel } from './useRoomModel';
import { APPROVAL_INK } from '../theme';

const btn = 'rounded-md border border-line px-3 py-1.5 text-sm hover:bg-raised disabled:opacity-50';

/** Room 화면 (/room/:id). 메신저의 [들어가기]로 온다. 구조와 3D 자리는 RoomStage 주석 참고. */
export function RoomView({ roomId }: { roomId: string }) {
  const [access, setAccess] = useState<SnapshotResult | 'loading'>('loading');
  const [replaySeq, setReplaySeq] = useState<number | null>(null);
  const [sheet, setSheet] = useState<'leave' | 'agent' | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const worldLoaded = useWorld((s) => s.loaded);
  const model = useRoomModel(roomId, replaySeq);

  useEffect(() => {
    setAccess('loading');
    setReplaySeq(null);
    let alive = true;
    void openRoom(roomId).then((r) => alive && setAccess(r));
    useWorld.getState().select(roomId);
    return () => {
      alive = false;
      closeRoom(roomId);
    };
  }, [roomId]);

  // 보고 있는 Room은 읽음 처리한다(라이브일 때만)
  const lastSeq = model?.lastSeq ?? 0;
  const loaded = model?.loaded ?? false;
  useEffect(() => {
    if (loaded && lastSeq > 0 && replaySeq === null) void markSeen(roomId, lastSeq);
  }, [roomId, loaded, lastSeq, replaySeq]);

  const nameOf = useMemo(
    () => (id: string | null | undefined) => {
      if (!id || !model) return '누군가';
      return model.users[id]?.name ?? model.resolveAgent(id).name;
    },
    [model],
  );

  const agentIds = useMemo(() => (model ? model.agents.map((a) => a.agentId) : []), [model]);

  if (!worldLoaded || !model) {
    return <main className="flex h-full items-center justify-center text-muted">불러오는 중…</main>;
  }
  const { room, meId, users, state } = model;
  const rel = relation(meId, room);
  const title = titleOf(room, meId, users);
  const me = state.members[meId];
  const isMember = room.kind === 'our' || (room.kind === 'my' && room.ownerId === meId);
  const left = isMember && !!me && !me.present;
  const myAgent = model.agents.find((a) => a.ownerId === meId && !a.visiting);
  const myActiveVisit = Object.values(state.visits).find((v) => v.visitorUserId === meId && v.visitorKind === 'human' && v.status === 'active');
  const peers = model.presence.filter((id) => id !== meId && !(left && id === meId)).map((id) => users[id]?.name ?? id);
  const pendingCount = Object.values(state.approvals).filter((a) => a.status === 'pending').length;

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

  if (access === 'forbidden' || (access === 'error' && !model.loaded)) {
    return (
      <main className="flex h-full flex-col items-center justify-center gap-3">
        <h1 className="text-lg font-semibold">{title}</h1>
        <p className="text-sm text-muted">
          {access === 'forbidden' ? '이 Room은 유리가 서리 낀 상태예요. 방문이 수락되면 들어올 수 있어요.' : 'Room을 불러오지 못했어요.'}
        </p>
        <button type="button" className={btn} onClick={() => navigate('/')}>
          메신저로 돌아가기
        </button>
      </main>
    );
  }

  return (
    <div className="pointer-events-none flex h-full min-w-[1100px] flex-col" data-testid="room-view" data-room-id={roomId} data-relation={rel}>
      <header className="pointer-events-auto flex flex-wrap items-center gap-3 border-b border-line bg-panel px-5 py-2.5 backdrop-blur-md">
        <button type="button" data-testid="room-back" className={btn} onClick={() => navigate('/')}>
          ← 메신저
        </button>
        <h1 className="truncate text-base font-semibold">{title}</h1>
        <span className="rounded border border-line px-1.5 py-0.5 text-[11px] text-muted">{KIND_LABEL[room.kind]}</span>
        <span className="text-xs text-muted">
          {THEMES[room.theme].label}
          {room.themeVariant ? ` · ${room.themeVariant}` : ''}
        </span>
        <span
          data-testid="ambience-chip"
          className="rounded-full border px-2 py-0.5 text-[11px]"
          style={{ borderColor: model.ambience.attention ? APPROVAL_ORANGE : 'var(--line)', color: model.ambience.attention ? APPROVAL_INK : 'var(--muted)' }}
        >
          {AMBIENCE_LABEL[model.ambience.stage]}
        </span>
        {pendingCount > 0 && (
          <span className="rounded-full bg-[#ff9f43] px-2 text-[11px] font-semibold leading-5 text-[var(--on-accent)]" data-testid="room-pending-count">
            승인 대기 {pendingCount}
          </span>
        )}
        {peers.length > 0 && <span className="text-xs text-muted" data-testid="presence">접속 중 · {peers.join(', ')}</span>}
        {model.replaying && (
          <span data-testid="replay-badge" className="rounded-full bg-[#ffd9a0] px-2.5 py-0.5 text-[11px] font-semibold text-[#3a2c00]">
            과거 재생 중
          </span>
        )}

        <div className="ml-auto flex items-center gap-2">
          <GuideButton id="room" withLabel />
        </div>
        <div className="flex items-center gap-2" data-testid="room-actions">
          {isMember && !left && (
            <button type="button" data-testid="room-leave" disabled={busy || model.replaying} className={btn} onClick={() => setSheet('leave')}>
              Leave
            </button>
          )}
          {isMember && left && (
            <button
              type="button"
              data-testid="room-rejoin"
              disabled={busy}
              className={btn}
              style={{ borderColor: 'var(--focus)' }}
              onClick={() => void run(() => rejoinAndShowDigest(roomId))}
            >
              Rejoin
            </button>
          )}
          {rel === 'yours' && !myActiveVisit && (
            <button type="button" data-testid="room-send-agent" disabled={busy} className={btn} onClick={() => setSheet('agent')}>
              Agent 보내기
            </button>
          )}
          {rel === 'yours' && myActiveVisit && (
            <button type="button" disabled={busy} className={btn} onClick={() => void run(() => api.endVisit(myActiveVisit.visitId))}>
              방문 종료
            </button>
          )}
        </div>
      </header>

      <InteractionStrip events={model.events} agentIds={agentIds} nameOf={nameOf} />

      {me?.digestPending && !left && (
        <div role="status" data-testid="digest-banner" className="pointer-events-auto flex items-center gap-3 border-b border-line bg-[#1b2640] px-5 py-2 text-sm">
          돌아와서 확인하지 않은 요약이 있어요.
          <button type="button" className={btn} onClick={() => useDigestUi.getState().open(roomId)}>
            다이제스트 보기
          </button>
        </div>
      )}
      {left && (
        <div role="status" data-testid="left-banner" className="pointer-events-auto border-b border-line bg-[#1b2640] px-5 py-2 text-sm">
          Leave 중이에요
          {me?.mandate ? ` · ${myAgent?.name ?? '내 Agent'}가 위임 범위 안에서 대신 참여해요: “${me.mandate.text}”` : ' · 대리 참여 없이 자리를 비웠어요'}
        </div>
      )}
      {error && (
        <p role="alert" className="pointer-events-auto border-b border-line bg-panel px-5 py-2 text-xs text-danger">
          {error}
        </p>
      )}

      <div className="pointer-events-none flex min-h-0 flex-1">
        <aside aria-label="참여자와 승인" className="pointer-events-auto flex w-[310px] shrink-0 flex-col overflow-y-auto border-r border-line bg-panel backdrop-blur-md">
          <AgentStatusList model={model} />
          <div className="border-t border-line">
            <ApprovalPanel model={model} />
          </div>
          {/* 방문자는 그 Room의 기억을 볼 수 없다(서버 403): 구성원일 때만 연다 */}
          {isMember && (
            <details className="border-t border-line px-4 py-3">
              <summary className="cursor-pointer text-sm font-semibold">내 기억</summary>
              <div className="mt-2">
                <MemoryPanel roomId={roomId} />
              </div>
            </details>
          )}
        </aside>

        {/* 가운데: 위는 3D가 비쳐 보이는 투명 무대(RoomStage 슬롯), 아래는 보드 패널이 3D 아래쪽에 겹친다 */}
        <main className="pointer-events-none flex min-w-0 flex-1 flex-col">
          <RoomStage model={model} />
          <div className="pointer-events-auto flex max-h-[36%] min-h-[170px] shrink-0 flex-col border-t border-line bg-panel backdrop-blur-md">
            <BoardPanel model={model} />
          </div>
        </main>

        <aside aria-label="활동" className="pointer-events-auto flex w-[420px] shrink-0 flex-col border-l border-line bg-panel backdrop-blur-md">
          <ActivityFeed
            model={model}
            leftReason={left ? 'Leave 중이에요 · Rejoin하면 쓸 수 있어요' : undefined}
          />
        </aside>
      </div>

      <div className="pointer-events-auto">
        <TimelineScrubber events={model.allEvents} replaySeq={replaySeq} onChange={setReplaySeq} nameOf={nameOf} />
      </div>

      <TourHost id="room" ready={model.loaded && access !== 'loading'} />
      {sheet === 'leave' && <LeaveSheet roomId={roomId} agentName={myAgent?.name ?? '내 Agent'} onClose={() => setSheet(null)} onLeft={() => navigate('/')} />}
      {sheet === 'agent' && (
        <SendAgentSheet
          hostRoomId={roomId}
          hostName={users[room.ownerId ?? '']?.name ?? '상대'}
          agentName="내 Agent"
          onClose={() => setSheet(null)}
        />
      )}
    </div>
  );
}
