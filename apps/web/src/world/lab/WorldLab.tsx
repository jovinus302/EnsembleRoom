import { useEffect, useMemo, useState } from 'react';
import { AMBIENCE_STAGES, type AgentCueKind, type AmbienceStage, type VisitRef, type WorldRoom } from '@ensemble/shared';
import { LAB_MODES, LAB_STATES, mockCharacters, type LabAgentMode, type LabState } from './mockChars';
import { api } from '../../api/client';
import { WorldCanvas } from '../WorldCanvas';
import { QUALITY_TIERS, usePerf, type QualityTier } from '../quality';
import type { WorldUser } from '../types';
import { DEFAULT_AMBIENCE, MOCK_ROOMS, MOCK_USERS, buildMockRooms } from './mockWorld';
import { emit, setRemoteCursor, setFxSuppressed, type FxKind, type FxPayload } from '../../fx/fxStore';
import { FxOverlay } from '../../stage/FxOverlay';

/**
 * /lab/world: S15·S16 개발용 화면. mock 월드(기본) 또는 ?real=1(로그인된 세션의 /api/world).
 * 쿼리: viewer=u_alice|u_bob|u_mom|u_dana, focus=<roomId>, select=<roomId>, q=high|mid|low, ui=0(패널 숨김),
 *       visit=<roomId>(그 방문이 수락돼 활성), amb=<roomId>:<stage>,...
 */
export function WorldLab() {
  const params = useMemo(() => new URLSearchParams(location.search), []);
  const [viewerId, setViewerId] = useState(params.get('viewer') ?? 'u_alice');
  const [focusId, setFocusId] = useState<string | null>(params.get('focus'));
  const [selectedId, setSelectedId] = useState<string | null>(params.get('select') ?? params.get('focus'));
  const [visitIds, setVisitIds] = useState<string[]>(params.get('visit')?.split(',').filter(Boolean) ?? []);
  const [quality, setQuality] = useState<QualityTier | 'auto'>('auto');
  const [ambience, setAmbience] = useState<Record<string, AmbienceStage>>(() => {
    const out = { ...DEFAULT_AMBIENCE };
    for (const pair of params.get('amb')?.split(',') ?? []) {
      const [id, st] = pair.split(':');
      if (id && st && (AMBIENCE_STAGES as readonly string[]).includes(st)) out[id] = st as AmbienceStage;
    }
    return out;
  });
  const [labState, setLabState] = useState<LabState>((params.get('state') as LabState) ?? 'idle');
  const [labMode, setLabMode] = useState<LabAgentMode>((params.get('mode') as LabAgentMode) ?? 'accompanied');
  const [cue, setCue] = useState<{ kind: AgentCueKind; seq: number } | null>(null);
  const [chars, setChars] = useState(params.get('chars') !== '0');
  const [real, setReal] = useState<{ me: string; users: Record<string, WorldUser>; rooms: WorldRoom[] } | null>(null);
  const showUi = params.get('ui') !== '0';
  const [replaying, setReplaying] = useState(false);
  const colorOf = (u: string) => MOCK_USERS[u]?.color ?? '#fff';
  // 장면 버튼: 선택(없으면 기본) 캡슐 기준으로 fxStore에 사건을 넣는다. 서버 없이 연출만 본다
  const scene = (kind: FxKind): FxPayload => {
    const room = (selectedId && rooms.find((r) => r.id === selectedId)) || rooms.find((r) => r.id === 'our_work')!;
    const me = `h:${viewerId}`;
    const my = `my_${viewerId.replace('u_', '')}`;
    const other = my === 'my_bob' ? 'my_alice' : 'my_bob';
    const colors = room.kind === 'our' ? room.memberIds.map(colorOf) : [colorOf(viewerId), colorOf('u_bob')];
    const agent = room.kind === 'our' ? `ra_${room.id}` : `ag_${room.ownerId ?? viewerId}`;
    const base: FxPayload = { roomId: room.id, actorId: agent, colors, color: colorOf(viewerId), mine: true, involvesMe: true };
    switch (kind) {
      case 'visit_request': return { ...base, fromRoomId: my, toRoomId: other, roomId: other, actorId: me };
      case 'visit_accept': case 'visit_end': return { ...base, roomId: other, toRoomId: other };
      case 'leave': return { ...base, actorId: `h:${room.memberIds[0] ?? viewerId}`, targetId: agent, color: colorOf(room.memberIds[0] ?? viewerId) };
      case 'rejoin': return { ...base, actorId: `h:${room.memberIds[0] ?? viewerId}`, count: 4, color: colorOf(room.memberIds[0] ?? viewerId) };
      case 'agent_depart': return { ...base, fromRoomId: my, toRoomId: other, roomId: my, actorId: `ag_${viewerId}` };
      case 'agent_arrive': return { ...base, fromRoomId: my, toRoomId: other, roomId: other, actorId: `ag_${viewerId}` };
      case 'message': case 'send_local': return { ...base, actorId: me };
      case 'approval_resolved': return { ...base, outcome: 'approved' };
      case 'approval_requested': return { ...base, text: '토요일 해변 카페로 확정할까요?' };
      default: return base;
    }
  };
  useEffect(() => {
    setFxSuppressed(replaying);
  }, [replaying]);
  useEffect(() => {
    // ?fx=agreement,approval_requested@3000 : 지정 시각(기본 2500ms)에 자동 재생
    const list = params.get('fx')?.split(',').filter(Boolean) ?? [];
    const timers = list.map((item, i) => {
      const [k, at] = item.split('@');
      return setTimeout(() => emit(k as FxKind, scene(k as FxKind)), Number(at ?? 2500 + i * 700));
    });
    return () => timers.forEach(clearTimeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    // ?remote=1: 상대(Bob) 커서를 흉내 낸다(원 궤도)
    if (params.get('remote') !== '1') return;
    const idx = Object.keys(buildMockRooms(viewerId, [], DEFAULT_AMBIENCE).reduce((a, r) => ({ ...a, [r.id]: 1 }), {} as Record<string, number>)).sort().indexOf('our_work');
    const t = setInterval(() => {
      const a = performance.now() / 700;
      setRemoteCursor({ userId: 'u_bob', x: idx * 100 + 50 + Math.cos(a) * 5, y: 0.5, z: Math.sin(a) * 4, roomId: null });
    }, 50);
    return () => clearInterval(t);
  }, [params, viewerId]);
  const perf = usePerf();

  useEffect(() => {
    if (params.get('real') !== '1') return;
    api
      .world()
      .then((w) => {
        const users: Record<string, WorldUser> = {};
        for (const u of [...w.users, w.me]) users[u.id] = { id: u.id, name: u.name, color: u.color };
        setReal({ me: w.me.id, users, rooms: w.rooms });
        setViewerId(w.me.id);
      })
      .catch(() => setReal(null));
  }, [params]);

  const visits = useMemo<VisitRef[]>(
    () =>
      visitIds.map((hostRoomId) => ({ hostRoomId, visitorKind: 'human', visitorUserId: viewerId, status: 'active' })),
    [visitIds, viewerId],
  );
  const mockRooms = useMemo(() => buildMockRooms(viewerId, visits, ambience), [viewerId, visits, ambience]);
  const rooms = real ? real.rooms : mockRooms;
  const users = real ? real.users : MOCK_USERS;
  const selectedRoom = rooms.find((r) => r.id === selectedId);
  const characters = useMemo(
    () =>
      chars && !real
        ? mockCharacters(rooms, users, ambience, {
            viewerId,
            state: labState,
            mode: labMode,
            cue,
            modeUserId: params.get('mu') ?? 'u_alice',
            destRoomId: params.get('dest') ?? 'my_bob',
            speech: params.get('say') ?? '토요일로 확정하면 어떨까요? 장소는 해변 카페로.',
          })
        : undefined,
    [chars, real, rooms, users, ambience, viewerId, labState, labMode, cue, params],
  );
  const canToggleVisit = !real && selectedRoom && selectedRoom.kind === 'my' && selectedRoom.ownerId !== viewerId;

  const btn = (active: boolean) =>
    `rounded px-2 py-1 text-xs ${active ? 'bg-[#ffb066] text-black' : 'bg-white/10 text-white hover:bg-white/20'}`;

  return (
    <div className="fixed inset-0 overflow-hidden bg-black">
      <WorldCanvas
        viewerId={viewerId}
        rooms={rooms}
        users={users}
        selectedRoomId={selectedId}
        focusRoomId={focusId}
        onSelectRoom={(id) => {
          setSelectedId(id);
          setFocusId(id);
        }}
        quality={quality}
        ambienceOverrides={real ? undefined : ambience}
        characters={characters}
        intro={params.get('intro') === '1'}
      />
      <FxOverlay />
      {showUi ? (
        <div
          className="absolute left-3 top-3 flex max-w-[360px] flex-col gap-2 rounded-lg bg-black/55 p-3 text-xs text-white backdrop-blur"
          data-testid="lab-panel"
        >
          <div className="font-semibold">World Lab (S15 · S18)</div>
          {!real && (
            <div className="flex flex-wrap items-center gap-1">
              <span className="w-12 opacity-70">시점</span>
              {Object.values(MOCK_USERS).map((u) => (
                <button key={u.id} data-testid={`viewer-${u.id}`} className={btn(viewerId === u.id)} onClick={() => setViewerId(u.id)}>
                  {u.name}
                </button>
              ))}
            </div>
          )}
          <div className="flex flex-wrap items-center gap-1">
            <span className="w-12 opacity-70">품질</span>
            {(['auto', ...QUALITY_TIERS] as const).map((q) => (
              <button key={q} data-testid={`q-${q}`} className={btn(quality === q)} onClick={() => setQuality(q)}>
                {q}
              </button>
            ))}
            <span className="ml-1 opacity-70" data-testid="hud">
              {perf.tier} · {perf.fps}fps · {perf.frameMs}ms
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-1">
            <span className="w-12 opacity-70">카메라</span>
            <button data-testid="focus-none" className={btn(!focusId)} onClick={() => setFocusId(null)}>
              조망
            </button>
            {rooms
              .filter((r) => r.kind !== 'dm')
              .map((r) => (
                <button
                  key={r.id}
                  data-testid={`focus-${r.id}`}
                  className={btn(focusId === r.id)}
                  onClick={() => {
                    setFocusId(r.id);
                    setSelectedId(r.id);
                  }}
                >
                  {r.id.replace('my_', '').replace('our_', '*')}
                </button>
              ))}
          </div>
          {!real && (
            <>
              <div className="flex flex-wrap items-center gap-1">
                <span className="w-12 opacity-70">캐릭터</span>
                <button data-testid="chars-toggle" className={btn(chars)} onClick={() => setChars((v) => !v)}>
                  {chars ? '표시' : '숨김'}
                </button>
                {LAB_STATES.map((st) => (
                  <button key={st} data-testid={`cs-${st}`} className={btn(labState === st)} onClick={() => setLabState(st)}>
                    {st}
                  </button>
                ))}
              </div>
              <div className="flex flex-wrap items-center gap-1">
                <span className="w-12 opacity-70">모드</span>
                {LAB_MODES.map((m) => (
                  <button key={m} data-testid={`cm-${m}`} className={btn(labMode === m)} onClick={() => setLabMode(m)}>
                    {m}
                  </button>
                ))}
              </div>
              <div className="flex flex-wrap items-center gap-1">
                <span className="w-12 opacity-70">큐</span>
                {(['nod', 'jump', 'agreement', 'scatter', 'hold_card', 'flow_to_owner'] as AgentCueKind[]).map((k) => (
                  <button key={k} data-testid={`cue-${k}`} className={btn(false)} onClick={() => setCue({ kind: k, seq: (cue?.seq ?? 0) + 1 })}>
                    {k}
                  </button>
                ))}
              </div>
            </>
          )}
          {!real && selectedRoom && (
            <>
              <div className="flex flex-wrap items-center gap-1">
                <span className="w-12 opacity-70">조명</span>
                {AMBIENCE_STAGES.map((s) => (
                  <button
                    key={s}
                    data-testid={`amb-${s}`}
                    className={btn(ambience[selectedRoom.id] === s)}
                    onClick={() => setAmbience((a) => ({ ...a, [selectedRoom.id]: s }))}
                  >
                    {s}
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-1">
                <span className="w-12 opacity-70">유리</span>
                <span data-testid="glass-state">{selectedRoom.preview.glass}</span>
                {canToggleVisit && (
                  <button
                    data-testid="toggle-visit"
                    className={btn(visitIds.includes(selectedRoom.id))}
                    onClick={() =>
                      setVisitIds((v) => (v.includes(selectedRoom.id) ? v.filter((x) => x !== selectedRoom.id) : [...v, selectedRoom.id]))
                    }
                  >
                    방문 수락 토글
                  </button>
                )}
              </div>
            </>
          )}
          <div className="flex flex-wrap items-center gap-1" data-testid="fx-panel">
            <span className="w-12 opacity-70">연출</span>
            {(['send_local', 'message', 'agent_called', 'approval_requested', 'approval_resolved', 'agreement', 'memory', 'visit_request', 'visit_accept', 'visit_end', 'leave', 'rejoin', 'agent_depart', 'agent_arrive', 'agent_paused'] as FxKind[]).map((k) => (
              <button key={k} data-testid={`fx-${k}`} className={btn(false)} onClick={() => emit(k, scene(k))}>
                {k}
              </button>
            ))}
            <button data-testid="fx-replay" className={btn(replaying)} onClick={() => setReplaying((v) => !v)}>
              재생 억제 {replaying ? 'ON' : 'OFF'}
            </button>
          </div>
          <div className="opacity-60">캡슐 클릭: 포커스, 빈 곳 클릭: 조망. 방 수 {MOCK_ROOMS.length}</div>
        </div>
      ) : null}
    </div>
  );
}
