import { useEffect, useMemo, useRef, type ReactNode } from 'react';
import { useFrame, type ThreeEvent } from '@react-three/fiber';
import * as THREE from 'three';
import { GLASS_TRANSITION_SECONDS, PALETTE, themeSeats } from '@ensemble/shared';
import type { CapsuleModel } from '../types';
import type { Placement } from '../layout';
import type { QualityConfig, QualityTier } from '../quality';
import { applyFrost, createShellMaterial, frostOf, TransmissiveGlass } from './GlassMaterial';
import { InteriorLights } from './InteriorLights';
import { RoomSign } from './RoomSign';
import { memberDots, paintGradient, pillGeometry, seamRing, stadiumBand, stadiumRing, stadiumSlab, stripeColorAt } from './geometry';
import { glowTexture } from './glow';
import { interiorLampPoints } from '../interiors/build';
import { interiorSpec } from '../interiors/layouts';
import { SHADOW } from '../scenePalette';

const ORANGE = new THREE.Color(PALETTE.approvalOrange);
const WHITE_C = new THREE.Color('#ffffff');

let shadowTex: THREE.CanvasTexture | null = null;
/** 캡슐 접지 그림자(앰비언트 오클루전): 둥근 사각형 모양의 부드러운 어두운 번짐 */
function contactShadowTexture(): THREE.CanvasTexture {
  if (shadowTex) return shadowTex;
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 128;
  const g = c.getContext('2d')!;
  g.fillStyle = '#000';
  g.fillRect(0, 0, 256, 128);
  g.filter = 'blur(14px)';
  g.fillStyle = '#fff';
  g.beginPath();
  g.roundRect(46, 34, 164, 60, 30);
  g.fill();
  shadowTex = new THREE.CanvasTexture(c);
  return shadowTex;
}

export interface CapsuleShellProps {
  model: CapsuleModel;
  placement: Placement;
  quality: QualityConfig;
  /** 투과(굴절) 유리 슬롯을 받았는가 */
  transmissive: boolean;
  /** 실제 PointLight 슬롯을 받았는가 */
  pointLight: boolean;
  hovered: boolean;
  selected: boolean;
  onHover: (roomId: string | null) => void;
  onSelect: (roomId: string) => void;
  /** 내부 좌표계(바닥 윗면 원점)에 들어갈 자식 */
  children?: ReactNode;
  agentBusy?: number;
  /** 카메라가 이 캡슐에 접근해 있는가(간판이 크게 읽히므로 DOM 라벨은 숨긴다) */
  focused?: boolean;
  /** 이 캡슐이 카메라 포커스 대상인가(가까이서 보이므로 글로우·블룸을 낮춘다) */
  focusTarget?: boolean;
  reducedMotion?: boolean;
  useDiorama?: boolean;
  tierName?: QualityTier;
}

/**
 * 캡슐 하나 = Room 하나 (계획 8.3). 알약형 유리 셸, 세로 이음매 링 2개, 원목 받침(소유자 색 띠), 간판,
 * 실내 조명, 선택 후광. 호버하면 살짝 들리고 림이 밝아진다.
 */
export function CapsuleShell({
  model,
  placement,
  quality,
  transmissive,
  pointLight,
  hovered,
  selected,
  onHover,
  onSelect,
  children,
  agentBusy,
  focused = false,
  focusTarget = false,
  reducedMotion = false,
  useDiorama = false,
  tierName = 'mid',
}: CapsuleShellProps) {
  const d = placement.dims;
  const stops = model.memberColors;
  const our = d.proportion === 'plump';
  const tint = useMemo(() => new THREE.Color(model.color), [model.color]);

  const geos = useMemo(() => {
    const pill = pillGeometry(d);
    const shadowPill = pillGeometry(d, 0.985);
    const inner = pillGeometry(d, 0.968);
    const bl = d.baseHalfLength;
    const bd = d.baseHalfDepth;
    const contact = new THREE.PlaneGeometry((2 * (bl + 0.12)) / 0.66, (2 * (bd + 0.12)) / 0.47);
    contact.rotateX(-Math.PI / 2);
    const slab = stadiumSlab(bl + 0.12, bd + 0.12, -0.26, 0);
    let band: THREE.BufferGeometry;
    if (our) {
      band = stadiumBand(bl + 0.06, bd + 0.06, -0.48, -0.26, stripeColorAt(stops, bl + 0.06));
    } else {
      band = stadiumSlab(bl + 0.06, bd + 0.06, -0.48, -0.26);
      paintGradient(band, stops, (x) => (x / (bl + 0.06) + 1) / 2);
    }
    const base = stadiumSlab(bl, bd, -d.floorHeight, -0.48);
    const dots = our ? memberDots(stops, d) : null;
    const ring = seamRing(d.radius + 0.025, stops);
    const attnRing = new THREE.TorusGeometry(d.radius + 0.13, 0.05, 10, 72);
    attnRing.rotateY(Math.PI / 2);
    const halo = stadiumRing(bl + 0.4, bd + 0.4, 0.55);
    return { pill, shadowPill, inner, contact, slab, band, base, ring, halo, attnRing, dots };
  }, [d, stops, our]);
  useEffect(
    () => () => {
      Object.values(geos).forEach((g) => g?.dispose());
    },
    [geos],
  );

  const frontMat = useMemo(() => createShellMaterial(THREE.FrontSide), []);
  const backMat = useMemo(() => createShellMaterial(THREE.BackSide), []);
  const innerMat = useMemo(() => createShellMaterial(THREE.BackSide), []);
  const contactMat = useMemo(
    () => new THREE.MeshBasicMaterial({ alphaMap: contactShadowTexture(), color: SHADOW, transparent: true, opacity: 0.4, depthWrite: false }),
    [],
  );
  const haloMat = useMemo(
    () =>
      new THREE.MeshBasicMaterial({
        color: tint,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        toneMapped: false,
      }),
    [tint],
  );
  const attnMat = useMemo(
    () =>
      new THREE.MeshBasicMaterial({
        color: new THREE.Color(PALETTE.approvalOrange).multiplyScalar(2.6),
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        toneMapped: false,
      }),
    [],
  );
  const ringMat = useMemo(() => new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false }), []);

  const hoverRef = useRef(0);
  const frostRef = useRef(frostOf(model.glass));
  const wipeFrom = useRef({ target: frostOf(model.glass), from: frostOf(model.glass) });
  const agentRef = useRef(model.glass === 'agent' ? 1 : 0);
  const viewerTint = useMemo(() => new THREE.Color(model.viewerColor), [model.viewerColor]);
  const lift = useRef<THREE.Group>(null);
  const transRef = useRef<THREE.Group>(null);
  const attnSprite = useRef<THREE.Sprite>(null);
  const ringGlow = useRef(1);
  const focusRef = useRef(0);

  useFrame((state, dt) => {
    const target = frostOf(model.glass);
    if (target !== wipeFrom.current.target) wipeFrom.current = { target, from: frostRef.current };
    const step = dt / (GLASS_TRANSITION_SECONDS * (reducedMotion ? 0.3 : 1));
    const fr = frostRef.current;
    frostRef.current = fr < target ? Math.min(target, fr + step) : Math.max(target, fr - step);
    const eased = THREE.MathUtils.smoothstep(frostRef.current, 0, 1);
    // agent 시야: 뷰어 색 림 빛(천천히 숨 쉰다)
    agentRef.current = THREE.MathUtils.damp(agentRef.current, model.glass === 'agent' ? 1 : 0, 4, dt);
    const ag = agentRef.current;
    hoverRef.current = THREE.MathUtils.damp(hoverRef.current, hovered ? 1 : 0, 9, dt);
    const h = hoverRef.current;
    applyFrost(frontMat, eased, tint, h, false, transmissive);
    applyFrost(backMat, eased, tint, h, true, transmissive);
    applyFrost(innerMat, eased, tint, h, true, transmissive);
    innerMat.opacity *= 0.55;
    innerMat.shell.rimStrength.value *= 0.6;
    if (ag > 0.003) {
      const breathe = reducedMotion ? 0.8 : 0.75 + 0.25 * Math.sin(state.clock.elapsedTime * 2.1);
      for (const m of [frontMat, backMat, innerMat]) {
        m.shell.rimColor.value.copy(viewerTint).lerp(WHITE_C, 0.08);
        m.shell.rimStrength.value *= 1 + 6 * ag * breathe;
      }
    }
    {
      // 전환 중에만 캡슐 길이 방향으로 밝은 띠가 지나간다(왼쪽→오른쪽). 사람 방문(→0)·agent 시야(→0.4)·서리(→1) 모두 같은 와이프
      const fz = frostRef.current;
      const { from } = wipeFrom.current;
      const span = Math.abs(target - from);
      const moving = span > 0.001 && Math.abs(fz - target) > 0.001;
      const p = span > 0.001 ? THREE.MathUtils.clamp(Math.abs(fz - from) / span, 0, 1) : 1;
      const amp = moving && !reducedMotion ? Math.sin(Math.PI * p) : 0;
      for (const m of [frontMat, backMat, innerMat]) m.shell.wipe.value.set(THREE.MathUtils.lerp(-0.1, 1.1, p), amp, d.length / 2 + d.radius);
    }
    if (transRef.current) transRef.current.visible = transmissive && eased < 0.96;
    if (model.ambience === 'attention') {
      const ka = reducedMotion ? 0.8 : 0.55 + 0.45 * Math.sin(state.clock.elapsedTime * 3.2);
      for (const m of [frontMat, backMat, innerMat]) {
        m.shell.rimColor.value.lerp(ORANGE, 0.85);
        m.shell.rimStrength.value *= 1 + 2.2 * ka;
      }
    }

    if (lift.current) {
      lift.current.position.y = h * 0.28 + (selected ? 0.1 : 0);
      lift.current.scale.setScalar(1 + h * 0.012);
    }
    const t = state.clock.elapsedTime;
    const attention = model.ambience === 'attention';
    const k = attention ? (reducedMotion ? 0.8 : 0.55 + 0.45 * Math.sin(t * 3.2)) : 0;
    focusRef.current = THREE.MathUtils.damp(focusRef.current, focusTarget ? 1 : 0, 5, dt);
    const fk = focusRef.current;
    // 링: 평소엔 소유자 색, 호버/선택 시 밝게, 승인 대기 시 오렌지가 번쩍인다
    ringGlow.current = THREE.MathUtils.damp(ringGlow.current, 1.15 + h * 1.1 + (selected ? 0.5 : 0), 8, dt);
    ringMat.color.setScalar(ringGlow.current * (1 + k * 1.2));
    if (attention) ringMat.color.lerp(ORANGE, k * 0.55);
    attnMat.opacity = attention ? 0.3 + 0.7 * k : 0;
    if (attnSprite.current) {
      (attnSprite.current.material as THREE.SpriteMaterial).opacity = attention ? (0.06 + 0.1 * k) * (1 - 0.9 * fk) : 0;
    }
    // agent 시야: 모래 위 후광이 뷰어 색으로 숨 쉰다(사람 방문 clear에는 없다)
    haloMat.color.copy(tint).lerp(viewerTint, ag);
    const agentHalo = ag * (reducedMotion ? 0.6 : 0.5 + 0.15 * Math.sin(t * 2.1));
    haloMat.opacity = THREE.MathUtils.damp(haloMat.opacity, Math.max(selected ? 0.75 + 0.2 * Math.sin(t * 2.4) : h * 0.5, agentHalo), 8, dt);
  });

  // 포커스된 캡슐의 유리 앞면은 안쪽 소품(보드 도구 등)의 클릭·호버를 가로채지 않는다(소품이 stopPropagation으로 직접 처리)
  const over = (e: ThreeEvent<PointerEvent>) => {
    if (!focusTarget) e.stopPropagation();
    onHover(model.roomId);
  };
  const out = () => onHover(null);
  const click = (e: ThreeEvent<MouseEvent>) => {
    if (!focusTarget) e.stopPropagation();
    onSelect(model.roomId);
  };

  const seats = themeSeats(model.theme, model.themeVariant);
  const lamps = useMemo(
    () => (useDiorama ? interiorLampPoints(interiorSpec(model.theme, model.themeVariant, d), tierName) : undefined),
    [useDiorama, model.theme, model.themeVariant, d, tierName],
  );

  return (
    <group position={[placement.x, 0, placement.z]} rotation={[0, placement.rotY, 0]}>
      {/* 접지 그림자: 모래와 받침 사이를 붙여 준다 */}
      <mesh geometry={geos.contact} material={contactMat} position={[0, 0.045, 0.1]} renderOrder={1} />
      {/* 선택·호버 후광: 모래 위 */}
      <mesh geometry={geos.halo} position={[0, 0.04, 0]} material={haloMat} renderOrder={1} />
      <group ref={lift}>
        {/* 그림자용 보이지 않는 알약: 유리가 모래에 옅은 그림자를 드리운다 */}
        <mesh geometry={geos.shadowPill} position={[0, d.axisHeight, 0]} castShadow>
          <meshBasicMaterial colorWrite={false} depthWrite={false} />
        </mesh>

        {/* 유리 셸 */}
        <group position={[0, d.axisHeight, 0]}>
          <mesh geometry={geos.pill} material={backMat} renderOrder={4} />
          <mesh geometry={geos.inner} material={innerMat} renderOrder={4} />
          <group ref={transRef} visible={transmissive}>
            {transmissive ? (
              <TransmissiveGlass geometry={geos.pill} samples={quality.transmissionSamples} tint={tint} />
            ) : null}
          </group>
          <mesh
            geometry={geos.pill}
            material={frontMat}
            renderOrder={11}
            onPointerOver={over}
            onPointerOut={out}
            onClick={click}
          />
          {[-1, 1].map((s) => (
            <mesh key={s} geometry={geos.ring} material={ringMat} position={[(s * d.length) / 2, 0, 0]} />
          ))}
          {/* 승인 대기: 이음매 바깥의 오렌지 반짝임 고리 */}
          {[-1, 1].map((s) => (
            <mesh key={`a${s}`} geometry={geos.attnRing} material={attnMat} position={[(s * d.length) / 2, 0, 0]} renderOrder={12} />
          ))}
        </group>

        {/* 바닥 윗면이 원점인 내부 좌표계 */}
        <group position={[0, d.floorHeight, 0]}>
          <mesh geometry={geos.base} castShadow receiveShadow>
            <meshStandardMaterial color="#7a4b2c" roughness={0.65} />
          </mesh>
          <mesh geometry={geos.band} castShadow>
            <meshStandardMaterial vertexColors roughness={0.35} metalness={0.15} />
          </mesh>
          {geos.dots ? (
            <mesh geometry={geos.dots}>
              <meshBasicMaterial vertexColors toneMapped={false} />
            </mesh>
          ) : null}
          <mesh geometry={geos.slab} receiveShadow castShadow>
            <meshStandardMaterial color="#e2c597" roughness={0.6} />
          </mesh>
          {/* 간판: 포커스일 때만(조망에서는 DOM 칩 하나만 이름을 보여 준다) */}
          {focused ? <RoomSign label={model.label} color={model.color} colors={our ? stops : undefined} dims={d} hover={0} /> : null}
          <InteriorLights
            stage={model.ambience}
            dims={d}
            pointLight={pointLight && quality.pointLights > 0}
            agentBusy={agentBusy}
            focus={focusTarget ? 1 : 0}
            reducedMotion={reducedMotion}
          />
          {/* 승인 대기: 유리 테두리 오렌지 반짝임 */}
          <sprite
            ref={attnSprite}
            position={[0, d.ceiling * 0.5, 0]}
            scale={[d.length + d.radius * 3.4, d.radius * 3.4, 1]}
            renderOrder={12}
          >
            <spriteMaterial
              map={glowTexture()}
              color={ORANGE}
              transparent
              opacity={0}
              depthWrite={false}
              blending={THREE.AdditiveBlending}
              toneMapped={false}
            />
          </sprite>
          {children}
          <group userData={{ seats }} />
        </group>
      </group>
    </group>
  );
}
