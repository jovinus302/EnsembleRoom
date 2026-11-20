import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { PerformanceMonitor } from '@react-three/drei';
import * as THREE from 'three';
import { ourColor, relation, roomLabel, type RoomRef } from '@ensemble/shared';
import { Beach } from './Beach';
import { CameraRig, type FocusUv } from './CameraRig';
import { Postfx } from './Postfx';
import { GlassTube } from './GlassTube';
import { routeCurves, routeTubes } from './routing';
import { LabelLayer, LabelProjector, type LabelEls, type LabelItem } from './LabelLayer';
import { CharacterDirector, RoomCharacters, TripOrbs } from './agents';
import { layoutWorld } from './layout';
import { QUALITY, forcedQualityFromUrl, tierDown, tierUp, usePerf, type QualityTier } from './quality';
import { CapsuleShell } from './capsule/CapsuleShell';
import { GlassBufferProvider } from './capsule/GlassMaterial';
import { Diorama, preloadInteriors } from './interiors';
import { Swarm } from './fx/Swarm';
import { FxScene } from './fx/FxScene';
import { patchSky, useSkyFlag } from './sky';
import { emit as fxEmit, startPointerTracking } from '../fx/fxStore';
import type { CapsuleModel, WorldCanvasProps } from './types';

const FALLBACK_COLOR = '#c9c4bd';

/** 캡슐 모델 파생: 라벨·관계는 shared의 perspective 함수를 그대로 쓴다 */
function buildModels(props: WorldCanvasProps, ids: string[]): Record<string, CapsuleModel> {
  const { viewerId, rooms, users, glassOverrides, ambienceOverrides } = props;
  const byId = new Map(rooms.map((r) => [r.id, r]));
  const nameOf = (id: string) => users[id]?.name ?? id;
  const colorOf = (id: string) => users[id]?.color ?? FALLBACK_COLOR;
  const out: Record<string, CapsuleModel> = {};
  for (const id of ids) {
    const r = byId.get(id);
    if (!r) continue;
    const ref: RoomRef = r;
    const memberColors = r.kind === 'my' && r.ownerId ? [colorOf(r.ownerId)] : r.memberIds.map(colorOf);
    out[id] = {
      roomId: id,
      kind: r.kind,
      ownerId: r.ownerId,
      memberIds: r.memberIds,
      relation: relation(viewerId, ref),
      label: roomLabel(viewerId, ref, nameOf),
      theme: r.theme,
      themeVariant: r.themeVariant,
      memberColors: memberColors.length ? memberColors : [FALLBACK_COLOR],
      color: r.kind === 'our' && memberColors.length > 1 ? ourColor(memberColors) : (memberColors[0] ?? FALLBACK_COLOR),
      glass: glassOverrides?.[id] ?? r.preview.glass,
      viewerColor: colorOf(viewerId),
      ambience: ambienceOverrides?.[id] ?? r.preview.ambience,
    };
  }
  return out;
}

function FpsProbe() {
  const acc = useRef({ t: 0, n: 0 });
  useFrame((_, dt) => {
    const a = acc.current;
    a.t += dt;
    a.n++;
    if (a.t >= 0.5) {
      usePerf.getState().set({ fps: Math.round(a.n / a.t), frameMs: Math.round((a.t / a.n) * 1000 * 10) / 10 });
      a.t = 0;
      a.n = 0;
    }
  });
  return null;
}

function ToneModeSwitch({ postfx }: { postfx: boolean }) {
  const gl = useThree((s) => s.gl);
  useEffect(() => {
    gl.toneMapping = postfx ? THREE.NoToneMapping : THREE.NeutralToneMapping;
    gl.toneMappingExposure = 1;
  }, [gl, postfx]);
  return null;
}

/**
 * 해변 위 유리 캡슐 월드(S15+S16). props만으로 동작한다: 시점(viewerId)과 방 목록, 선택·포커스, 품질.
 * 메신저/Room 화면 통합은 이 컴포넌트를 배경에 깔고 selectedRoomId/focusRoomId를 스토어에 연결하면 된다.
 */
export function WorldCanvas(props: WorldCanvasProps) {
  const { viewerId, rooms, selectedRoomId = null, focusRoomId = null, onSelectRoom, onHoverRoom, renderInterior, characters, paused = false, reducedMotion = false } = props;
  const forced = useMemo(forcedQualityFromUrl, []);
  const fixed: QualityTier | null = props.quality && props.quality !== 'auto' ? props.quality : forced;
  const [autoTier, setAutoTier] = useState<QualityTier>('mid');
  const tier = fixed ?? autoTier;
  const cfg = QUALITY[tier];
  useEffect(() => usePerf.getState().set({ tier }), [tier]);
  // 하늘(HDRI)이 올라오기 전에는 캔버스를 투명하게 두고 올라오면 부드럽게 나타낸다(검은 첫 프레임 방지).
  // HDRI 로딩이 실패해도 영영 안 보이는 일이 없게 8초 뒤에는 보인다.
  const skyReady = useSkyFlag('ready');
  const introActive = useSkyFlag('introActive');
  useEffect(() => {
    const t = window.setTimeout(() => patchSky({ ready: true }), 8000);
    return () => window.clearTimeout(t);
  }, []);

  const layout = useMemo(() => layoutWorld(viewerId, rooms as readonly RoomRef[]), [viewerId, rooms]);
  const models = useMemo(
    () => buildModels(props, layout.order),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [layout, rooms, props.users, props.glassOverrides, props.ambienceOverrides, viewerId],
  );
  useEffect(() => {
    if (!renderInterior && props.placeholderInterior !== false) preloadInteriors(rooms);
  }, [rooms, renderInterior, props.placeholderInterior]);
  const [hovered, setHovered] = useState<string | null>(null);
  const hover = (id: string | null) => {
    setHovered((prev) => {
      if (id && id !== prev) fxEmit('hover', { roomId: id });
      return id;
    });
    onHoverRoom?.(id);
  };
  useEffect(() => startPointerTracking(), []);
  useEffect(() => {
    document.body.style.cursor = hovered ? 'pointer' : '';
    return () => {
      document.body.style.cursor = '';
    };
  }, [hovered]);

  // 투과 유리·PointLight 슬롯: 포커스 > 선택 > 앞줄 순으로 예산만큼
  const { transSet, lightSet } = useMemo(() => {
    const prio: string[] = [];
    for (const id of [focusRoomId, selectedRoomId, ...layout.order]) {
      if (id && models[id] && !prio.includes(id)) prio.push(id);
    }
    const lights = new Set(prio.slice(0, cfg.pointLights));
    const trans = new Set(prio.filter((id) => models[id]?.glass === 'clear').slice(0, cfg.transmissionSlots));
    return { transSet: trans, lightSet: lights };
  }, [layout, models, focusRoomId, selectedRoomId, cfg]);

  // 튜브 경로의 단일 소스: 렌더와 캐릭터 이동(curves)이 같은 route를 쓴다
  const routes = useMemo(() => routeTubes(layout), [layout]);
  const curves = useMemo(() => routeCurves(routes), [routes]);
  const labelEls = useRef<LabelEls>(new Map());
  const labelItems = useMemo<LabelItem[]>(
    () =>
      layout.order.flatMap((id) => {
        const m = models[id];
        const p = layout.placements[id];
        if (!m || !p) return [];
        return [
          {
            id,
            label: m.label,
            color: m.color,
            anchor: [p.x, p.dims.axisHeight + p.dims.radius + 0.5, p.z] as [number, number, number],
            active: hovered === id || selectedRoomId === id,
            attention: m.ambience === 'attention',
            people: m.kind === 'our' ? { kind: 'many' as const, colors: [...m.memberColors] } : { kind: 'one' as const, colors: [m.color] },
            badge: m.glass === 'agent' ? { text: 'Agent 방문 중', color: m.viewerColor } : undefined,
          },
        ];
      }),
    [layout, models, hovered, selectedRoomId],
  );
  // Agent가 일하는 캡슐: 보드 옆 등이 맥동한다
  const busyByRoom = useMemo(() => {
    const out: Record<string, number> = {};
    for (const c of characters?.characters ?? []) {
      if (c.roomId && c.kind !== 'human' && (c.activity === 'drafting' || c.speech?.phase === 'writing')) {
        out[c.roomId] = Math.max(out[c.roomId] ?? 0, Math.min(1, 0.5 + (c.speech?.tokensPerSec ?? 0) / 60));
      }
    }
    return out;
  }, [characters]);
  const focusUv = useRef<FocusUv>({ y: 0.45 });
  const center = useMemo(() => {
    const b = layout.bounds;
    return new THREE.Vector3((b.minX + b.maxX) / 2, 0, (b.minZ + b.maxZ) / 2);
  }, [layout]);
  const extent = useMemo(() => {
    const b = layout.bounds;
    return Math.max(b.maxX - b.minX, b.maxZ - b.minZ) / 2 + Math.hypot(center.x, center.z) + 16;
  }, [layout, center]);

  return (
    <div
      className={props.className}
      style={{ position: 'absolute', inset: 0, ...props.style }}
      data-world-tier={tier}
      data-world-canvas=""
    >
      <div style={{ position: 'absolute', inset: 0, opacity: skyReady ? 1 : 0, transition: 'opacity 0.5s ease-out' }}>
      <Canvas
        key={`msaa${cfg.msaa}`}
        frameloop={paused ? 'never' : 'always'}
        shadows={{ type: THREE.PCFShadowMap }}
        dpr={cfg.dpr}
        camera={{ fov: 30, near: 0.5, far: 3000, position: [0, 14, 70] }}
        gl={{ antialias: true, powerPreference: 'high-performance', toneMapping: THREE.NoToneMapping }}
        onPointerMissed={() => onSelectRoom?.(null)}
      >
        <ToneModeSwitch postfx={cfg.postfx} />
        <FpsProbe />
        {!fixed ? (
          <PerformanceMonitor
            ms={300}
            iterations={6}
            flipflops={3}
            bounds={() => [42, 57]}
            onIncline={() => setAutoTier((t) => tierUp(t))}
            onDecline={() => setAutoTier((t) => tierDown(t))}
          />
        ) : null}
        <LabelProjector items={labelItems} els={labelEls} hidden={!!focusRoomId} />
        <CameraRig layout={layout} focusRoomId={focusRoomId} focusUv={focusUv} reducedMotion={reducedMotion} intro={props.intro} />
        <CharacterDirector input={characters} layout={layout} curves={curves} reducedMotion={reducedMotion} focusRoomId={focusRoomId}>
        <GlassBufferProvider enabled={cfg.transmissionSlots > 0} resolution={cfg.transmissionResolution} msaa={cfg.transmissionMsaa}>
          <Beach quality={cfg} center={center} extent={extent} bounds={layout.bounds} />
          {layout.tubes.map((t) => {
            const a = layout.placements[t.from];
            const b = layout.placements[t.to];
            const ma = models[t.from];
            const mb = models[t.to];
            const route = routes.get(`${t.from}>${t.to}`);
            if (!a || !b || !ma || !mb || !route) return null;
            const touches = !!focusRoomId && (t.from === focusRoomId || t.to === focusRoomId);
            return (
              <GlassTube
                key={`${t.from}>${t.to}`}
                route={route}
                colorA={ma.color}
                colorB={mb.color}
                dim={touches ? 0.18 : focusRoomId ? 0.6 : 1}
              />
            );
          })}
          {layout.order.map((id) => {
            const model = models[id];
            const placement = layout.placements[id];
            if (!model || !placement) return null;
            const ctx = { model, dims: placement.dims, quality: tier };
            const base = renderInterior ? renderInterior(ctx) : props.placeholderInterior === false ? null : <Diorama ctx={ctx} />;
            const interior = characters ? (
              <>
                {base}
                <RoomCharacters ctx={ctx} />
              </>
            ) : (
              base
            );
            return (
              <Fragment key={id}>
                <CapsuleShell
                  model={model}
                  placement={placement}
                  quality={cfg}
                  transmissive={transSet.has(id)}
                  pointLight={lightSet.has(id)}
                  hovered={hovered === id}
                  selected={selectedRoomId === id}
                  onHover={hover}
                  onSelect={(rid) => onSelectRoom?.(rid)}
                  focused={!!focusRoomId}
                  focusTarget={focusRoomId === id}
                  reducedMotion={reducedMotion}
                  agentBusy={busyByRoom[id] ?? 0}
                  useDiorama={!renderInterior && props.placeholderInterior !== false}
                  tierName={tier}
                >
                  {interior}
                </CapsuleShell>
              </Fragment>
            );
          })}
          <TripOrbs />
          {!reducedMotion ? (
            <Swarm
              layout={layout}
              models={models}
              users={props.users}
              viewerId={viewerId}
              curves={curves}
              hoveredId={hovered}
              focusRoomId={focusRoomId}
              characters={characters?.characters}
              replaying={characters?.replaying}
              particles={cfg.particles}
              onCursor={props.onCursor}
            />
          ) : null}
          <FxScene layout={layout} models={models} curves={curves} characters={characters?.characters} viewerColor={props.users[viewerId]?.color ?? '#ff8f7a'} reducedMotion={reducedMotion} />
        </GlassBufferProvider>
        </CharacterDirector>
        {cfg.postfx ? <Postfx quality={cfg} focused={!!focusRoomId} focusUv={focusUv} /> : null}
      </Canvas>
      </div>
      {/* 이름표 칩은 인트로가 끝난 뒤에 나타난다 */}
      <div style={{ position: 'absolute', inset: 0, opacity: skyReady && !introActive ? 1 : 0, transition: 'opacity 0.7s ease-out', pointerEvents: 'none' }}>
        <LabelLayer items={labelItems} els={labelEls} />
      </div>
    </div>
  );
}
