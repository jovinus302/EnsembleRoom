import { useEffect } from 'react';
import { THEMES, ringGradientStops, type AmbienceStage } from '@ensemble/shared';
import { AgentAvatar, Avatar } from '../messenger/Avatar';
import { AMBIENCE_LABEL, colorOf, titleOf } from '../messenger/labels';
import { APPROVAL_ORANGE } from '../messenger/visits';
import { useStage, useWorldActive } from '../stage/stageStore';
import type { RoomModel } from './useRoomModel';

/**
 * 3D 통합: 앱 루트의 `WorldCanvas`(stage/WorldHost)가 이 슬롯(`data-room-stage-slot`)의 DOM 사각형에 맞춰져
 * 포커스된 캡슐을 보여 준다. 슬롯은 투명하고 pointer-events가 없어 뒤의 캔버스가 그대로 보인다.
 * 2D 캡슐 일러스트는 WebGL2 미지원·오류·"2D" 품질 선택일 때만 폴백으로 그린다.
 * 2D와 3D는 둘 다 `RoomModel`(useRoomModel)만 읽는다: 조명 단계(`ambience`), Agent 상태(`agents[].state`), 보드, 방문, `replaySeq`.
 * 타임라인 재생 중에는 재생 시점의 조명 단계를 3D에 ambienceOverrides로 전달한다.
 */
export function RoomStage({ model }: { model: RoomModel }) {
  const { room, users, meId, ambience } = model;
  const color = colorOf(room, meId, users);
  const stage: AmbienceStage = ambience.stage;
  const memberColors = room.memberIds.map((id) => users[id]?.color).filter((c): c is string => !!c);
  const ring = room.kind === 'our' ? ringGradientStops(memberColors.length ? memberColors : [color]) : [color];
  // 조명: 사람 있음 = 따뜻한 100%, Agent만 = 40%(Agent 색), 비어 있음 = 꺼짐, 승인 대기 = 오렌지 보조광
  const glow = ambience.base === 'occupied' ? '#ffd9a0' : ambience.base === 'agentOnly' ? color : 'var(--stage-idle)';
  const lit = ambience.base === 'empty' ? 0.12 : ambience.base === 'agentOnly' ? 0.4 : 0.85;
  const alpha = `${Math.round(lit * 100)}%`;
  const present = model.state.presentUserIds;
  const worldActive = useWorldActive();
  const replayStage = model.replaying ? stage : null;
  const roomId = model.roomId;
  useEffect(() => {
    if (!replayStage) return;
    useStage.getState().setAmbienceOverrides({ [roomId]: replayStage });
    return () => useStage.getState().setAmbienceOverrides({});
  }, [roomId, replayStage]);
  useEffect(() => {
    useStage.getState().setFocusModel(model);
    return () => {
      if (useStage.getState().focusModel?.roomId === model.roomId) useStage.getState().setFocusModel(null);
    };
  }, [model]);
  const agentsHere = model.agents.filter((a) => a.state.location === model.roomId || a.state.mode === 'representing' || a.visiting);

  return (
    <div
      data-room-stage-slot=""
      data-world-active={worldActive ? 'true' : 'false'}
      ref={(el) => {
        useStage.getState().setSlotEl(el);
        return () => useStage.getState().setSlotEl(null);
      }}
      data-testid="room-stage"
      data-ambience={stage}
      data-replaying={model.replaying ? 'true' : 'false'}
      className="pointer-events-none relative flex min-h-[250px] flex-1 items-center justify-center"
      style={worldActive ? undefined : { background: 'radial-gradient(ellipse at 50% 100%, var(--stage-a), var(--stage-b) 70%)' }}
    >
      {/* --- 폴백 일러스트 (WebGL2 불가·오류·2D 선택일 때만) --- */}
      {!worldActive && (
      <div
        data-testid="stage-capsule"
        className="relative h-[112px] w-[420px] rounded-full p-[3px]"
        style={{
          background: `linear-gradient(90deg, ${ring.join(',')})`,
          boxShadow: ambience.attention ? `0 0 22px ${APPROVAL_ORANGE}aa` : `0 0 18px ${color}33`,
        }}
      >
        <div
          className="relative flex h-full w-full items-end justify-center gap-3 overflow-hidden rounded-full pb-3"
          style={{ background: `radial-gradient(ellipse at 50% 60%, color-mix(in srgb, ${glow} ${alpha}, transparent), transparent 72%), var(--thumb-bg)` }}
        >
          {ambience.attention && (
            <span aria-hidden="true" className="absolute inset-0 rounded-full" style={{ background: `radial-gradient(ellipse at 50% 100%, ${APPROVAL_ORANGE}33, transparent 70%)` }} />
          )}
          <span aria-hidden="true" className="absolute left-1/3 top-0 h-full w-px bg-black/10" />
          <span aria-hidden="true" className="absolute left-2/3 top-0 h-full w-px bg-black/10" />
          {present.map((id) => (
            <span
              key={id}
              data-testid="stage-person"
              title={users[id]?.name}
              className="relative z-10 mb-1"
            >
              <Avatar name={users[id]?.name ?? '?'} color={users[id]?.color ?? '#a0aec4'} size={28} />
            </span>
          ))}
          {agentsHere.map((a) => (
            <span
              key={a.agentId}
              data-testid="stage-agent"
              className="relative z-10"
              style={{ opacity: a.state.mode === 'traveling' ? 0.4 : 1 }}
              title={`${a.name} · ${a.state.activity}`}
            >
              <AgentAvatar variant={a.variant} color={a.color} size={34} name={a.name} room={a.kind === 'room_agent'} ownerName={a.ownerId ? users[a.ownerId]?.name : null} />
            </span>
          ))}
        </div>
      </div>
      )}
      <div className="absolute left-5 top-3 flex flex-col rounded-md bg-glass px-2.5 py-1.5 text-xs shadow-[var(--shadow-card)] backdrop-blur-sm">
        <span className="text-sm font-semibold">{titleOf(room, meId, users)}</span>
        <span className="text-muted">
          {THEMES[room.theme].label}
          {room.themeVariant ? ` · ${room.themeVariant}` : ''} · 조명 {AMBIENCE_LABEL[stage] ?? stage}
        </span>
      </div>
    </div>
  );
}
