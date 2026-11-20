import { useEffect, useMemo, useState } from 'react';
import { relation, THEMES } from '@ensemble/shared';
import { api, ApiError } from '../api/client';
import { closeRoom, markSeen, openRoom, type SnapshotResult } from '../api/ws';
import { MemoryPanel } from '../messenger/MemoryPanel';
import { AMBIENCE_LABEL, KIND_LABEL, titleOf } from '../messenger/labels';
import { navigate } from '../router';
import { btn } from '../ui/tg';
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
        <h1 className="tg-title">{title}</h1>
        <p className="text-aux text-muted">
          {access === 'forbidden' ? '이 Room은 유리가 서리 낀 상태예요. 방문이 수락되면 들어올 수 있어요.' : 'Room을 불러오지 못했어요.'}
        </p>
        <button type="button" className={btn('primary')} onClick={() => navigate('/')}>
          메신저로 돌아가기
        </button>
      </main>
    );
  }

  const kindLine = `${KIND_LABEL[room.kind]} · ${THEMES[room.theme].label}${room.themeVariant ? ` · ${room.themeVariant}` : ''}`;
  // 입장 모션은 패널 자신에게만 건다(조상에 opacity/transform 애니메이션이 있으면 패널 blur가 꺼진다)
  const delay = (ms: number) => ({ animationDelay: `${ms}ms` });

  return (
    <div className="pointer-events-none relative h-full min-h-[640px] min-w-[1100px]" data-testid="room-view" data-room-id={roomId} data-relation={rel}>
      <header
        className="tg-room-hdr tg-panel tg-enter-t pointer-events-auto absolute left-4 right-4 top-4 flex h-16 items-center gap-3 !rounded-full px-3"
        style={delay(0)}
      >
        <button type="button" data-testid="room-back" className={btn('ghost')} onClick={() => navigate('/')}>
          ← 메신저
        </button>
        <span aria-hidden="true" className="h-7 w-px shrink-0 bg-[var(--border)]" />
        <div className="flex min-w-0 flex-col gap-0.5">
          <h1 className="tg-title truncate">{title}</h1>
          <span className="tg-mono truncate">{kindLine}</span>
        </div>
        <span data-testid="ambience-chip" className={`tg-chip shrink-0 ${model.ambience.attention ? 'warn' : ''}`}>
          {AMBIENCE_LABEL[model.ambience.stage]}
        </span>
        {pendingCount > 0 && (
          <span className="tg-pill-amber shrink-0" data-testid="room-pending-count">
            <i />
            승인 대기 {pendingCount}
          </span>
        )}
        {peers.length > 0 && (
          <span className="tg-aux min-w-0 truncate" data-testid="presence">
            접속 중 · {peers.join(', ')}
          </span>
        )}
        {model.replaying && (
          <span data-testid="replay-badge" className="tg-chip warn shrink-0">
            과거 재생 중
          </span>
        )}

        <div className="ml-auto flex shrink-0 items-center gap-2">
          <GuideButton id="room" withLabel />
        </div>
        <div className="flex shrink-0 items-center gap-2" data-testid="room-actions">
          {rel === 'yours' && !myActiveVisit && (
            <button type="button" data-testid="room-send-agent" disabled={busy} className={btn('soft')} onClick={() => setSheet('agent')}>
              Agent 보내기
            </button>
          )}
          {rel === 'yours' && myActiveVisit && (
            <button type="button" disabled={busy} className={btn('ghost')} onClick={() => void run(() => api.endVisit(myActiveVisit.visitId))}>
              방문 종료
            </button>
          )}
          {isMember && !left && (
            <button type="button" data-testid="room-leave" disabled={busy || model.replaying} className={btn('cta')} onClick={() => setSheet('leave')}>
              Leave
            </button>
          )}
          {isMember && left && (
            <button type="button" data-testid="room-rejoin" disabled={busy} className={btn('primary')} onClick={() => void run(() => rejoinAndShowDigest(roomId))}>
              Rejoin
            </button>
          )}
        </div>
      </header>

      {/* 가운데 위쪽: 3D 위에 떠 있는 흐름 pill · 안내 */}
      <div className="pointer-events-none absolute left-[528px] right-[432px] top-24 z-10 flex flex-col items-center gap-2">
        <InteractionStrip events={model.events} agentIds={agentIds} nameOf={nameOf} />
        {me?.digestPending && !left && (
          <div role="status" data-testid="digest-banner" className="tg-notice tg-float amber pointer-events-auto !h-auto min-h-7 max-w-full py-1">
            돌아와서 확인하지 않은 요약이 있어요.
            <button type="button" className={`${btn('ghost')} !h-6 !px-3`} onClick={() => useDigestUi.getState().open(roomId)}>
              다이제스트 보기
            </button>
          </div>
        )}
        {left && (
          <div role="status" data-testid="left-banner" className="tg-notice tg-float amber pointer-events-auto !h-auto min-h-7 max-w-full py-1">
            Leave 중이에요
            {me?.mandate ? ` · ${myAgent?.name ?? '내 Agent'}가 위임 범위 안에서 대신 참여해요: “${me.mandate.text}”` : ' · 대리 참여 없이 자리를 비웠어요'}
          </div>
        )}
        {error && (
          <p role="alert" className="tg-notice tg-float pointer-events-auto !h-auto min-h-7 max-w-full py-1" style={{ color: 'var(--destructive-ink)' }}>
            {error}
          </p>
        )}
      </div>

      <aside
        aria-label="참여자와 승인"
        className="tg-panel tg-enter-l pointer-events-auto absolute bottom-4 left-4 top-24 flex w-[320px] flex-col gap-3.5 overflow-y-auto p-4"
        style={delay(120)}
      >
        <AgentStatusList model={model} />
        <ApprovalPanel model={model} />
        {/* 방문자는 그 Room의 기억을 볼 수 없다(서버 403): 구성원일 때만 연다 */}
        {isMember && (
          <details className="px-1">
            <summary className="cursor-pointer text-body font-semibold">내 기억</summary>
            <div className="mt-2">
              <MemoryPanel roomId={roomId} />
            </div>
          </details>
        )}
      </aside>

      {/* 가운데: 위는 3D가 비쳐 보이는 투명 무대(RoomStage 슬롯). 슬롯 사각형이 곧 3D 캔버스 크기다 */}
      <div className="pointer-events-none absolute bottom-[268px] left-[352px] right-[432px] top-24 flex flex-col">
        <RoomStage model={model} />
      </div>

      <section
        aria-label="보드"
        className="tg-panel tg-enter-b pointer-events-auto absolute bottom-[72px] left-[352px] right-[432px] flex h-[184px] flex-col overflow-hidden"
        style={delay(360)}
      >
        <BoardPanel model={model} />
      </section>

      <TimelineScrubber
        events={model.allEvents}
        replaySeq={replaySeq}
        onChange={setReplaySeq}
        nameOf={nameOf}
        className="tg-enter-b absolute bottom-4 left-[352px] right-[432px]"
      />

      <aside
        aria-label="활동"
        className="tg-panel tg-enter-r pointer-events-auto absolute bottom-4 right-4 top-24 flex w-[400px] flex-col p-4"
        style={delay(240)}
      >
        <ActivityFeed model={model} leftReason={left ? 'Leave 중이에요 · Rejoin하면 쓸 수 있어요' : undefined} />
      </aside>

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
