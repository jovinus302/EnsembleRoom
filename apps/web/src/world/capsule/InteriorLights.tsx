import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { AMBIENCE_INTENSITY, PALETTE, type AmbienceStage } from '@ensemble/shared';
import { glowTexture } from './glow';
import type { CapsuleDims } from './dims';

/**
 * 조명 단계 → 목표 조도·보조광 (계획 8.3 표).
 *  occupied: 따뜻하고 밝음(전구 전부 100%) / agentOnly: 책상 스탠드(첫 등)만 Agent 색으로 은은하게 /
 *  empty: 거의 꺼짐, 차가운 푸른빛 / attention: occupied 수준 + 유리 테두리의 주황 맥동(실내는 타지 않게).
 *  `shade`는 실내 소품 전체의 밝기 배율, `cool`은 푸른 톤 정도.
 */
export function ambienceTargets(stage: AmbienceStage) {
  switch (stage) {
    case 'occupied':
      return { level: AMBIENCE_INTENSITY.occupied, agent: 0, orange: 0, lamp0: 1, others: 1, shade: 1, cool: 0 };
    case 'agentOnly':
      return { level: AMBIENCE_INTENSITY.agentOnly, agent: 1, orange: 0, lamp0: 1, others: 0.06, shade: 0.5, cool: 0.35 };
    case 'empty':
      return { level: AMBIENCE_INTENSITY.empty, agent: 0, orange: 0, lamp0: 0, others: 0, shade: 0.2, cool: 1 };
    case 'attention':
      return { level: AMBIENCE_INTENSITY.occupied, agent: 0, orange: 1, lamp0: 1, others: 1, shade: 0.92, cool: 0 };
  }
}

const WARM = new THREE.Color('#ffb066'); // 약 2700K
const AGENT = new THREE.Color(PALETTE.agentMintLight);
const ORANGE = new THREE.Color(PALETTE.approvalOrange);

/** 전구 위치: 내부 좌표계(바닥 윗면 원점). 가장 가까운(앞쪽 첫) 등이 Agent 색을 받는다 */
export function lampPositions(d: CapsuleDims): THREE.Vector3[] {
  const x = d.length / 2 + d.floorHalfDepth * 0.35;
  const z = -d.floorHalfDepth * 0.45;
  const y = d.proportion === 'plump' ? 1.7 : 1.35;
  const pts = [new THREE.Vector3(-x, y, z), new THREE.Vector3(x, y, z)];
  if (d.proportion === 'plump') pts.push(new THREE.Vector3(0, y + 0.45, z * 0.4));
  return pts;
}

/**
 * 실내 조명 단계 표현 (`roomAmbience` → 조도). 전구는 emissive + 글로우 스프라이트, `pointLight`가 true인 캡슐만
 * 실제 PointLight를 쓴다(월드 예산). 값은 프레임마다 부드럽게 따라간다.
 * `agentBusy`는 Agent가 drafting 중일 때 토큰 속도에 맞춰 미세하게 맥동시키는 입력(0~1, S18/S19에서 연결).
 */
export function InteriorLights({
  stage,
  dims,
  pointLight,
  agentBusy = 0,
  focus = 0,
  reducedMotion = false,
}: {
  stage: AmbienceStage;
  dims: CapsuleDims;
  pointLight: boolean;
  agentBusy?: number;
  /** 0~1: 카메라가 이 캡슐 안을 보고 있으면 글로우를 줄여 실내가 하얗게 타지 않게 한다 */
  focus?: number;
  reducedMotion?: boolean;
}) {
  const lamps = useMemo(() => lampPositions(dims), [dims]);
  const bulbs = useRef<(THREE.Mesh | null)[]>([]);
  const glows = useRef<(THREE.Sprite | null)[]>([]);
  const light = useRef<THREE.PointLight>(null);
  const orangeGlow = useRef<THREE.Sprite>(null);
  const cur = useRef({ level: stage === 'empty' ? 0 : 1, agent: 0, orange: 0, lamp0: 1, others: 1 });
  const col = useMemo(() => new THREE.Color(), []);

  useFrame((state, dt) => {
    const t = ambienceTargets(stage);
    const c = cur.current;
    c.level = THREE.MathUtils.damp(c.level, t.level, 4, dt);
    c.agent = THREE.MathUtils.damp(c.agent, t.agent, 4, dt);
    c.orange = THREE.MathUtils.damp(c.orange, t.orange, 4, dt);
    c.lamp0 = THREE.MathUtils.damp(c.lamp0, t.lamp0, 4, dt);
    c.others = THREE.MathUtils.damp(c.others, t.others, 4, dt);
    const pulse = 1 + (reducedMotion ? 0 : Math.sin(state.clock.elapsedTime * 9) * 0.1 * agentBusy);
    const glowK = 1 - 0.8 * focus;
    lamps.forEach((_, i) => {
      col.copy(WARM);
      if (i === 0) col.lerp(AGENT, 0.6 * c.agent);
      const lvl = (i === 0 ? c.lamp0 * pulse : c.others) * (c.level > 0.01 || i === 0 ? 1 : 0.6);
      const b = bulbs.current[i];
      if (b) {
        (b.material as THREE.MeshBasicMaterial).color.copy(col).multiplyScalar(0.12 + lvl * 3.0);
      }
      const g = glows.current[i];
      if (g) {
        (g.material as THREE.SpriteMaterial).color.copy(col);
        (g.material as THREE.SpriteMaterial).opacity = lvl * 0.75 * glowK;
      }
    });
    if (light.current) {
      col.copy(WARM).lerp(AGENT, 0.35 * c.agent);
      light.current.color.copy(col);
      light.current.intensity = c.level * 30 * pulse * (1 - 0.5 * focus);
    }
    if (orangeGlow.current) {
      const m = orangeGlow.current.material as THREE.SpriteMaterial;
      m.opacity = c.orange * (0.05 + 0.05 * (reducedMotion ? 0.5 : Math.sin(state.clock.elapsedTime * 3.2))) * glowK;
    }
  });

  const cy = dims.ceiling * 0.78;
  const pool = useRef<THREE.Mesh>(null);
  useFrame(() => {
    if (pool.current) (pool.current.material as THREE.MeshBasicMaterial).opacity = (cur.current.level * 0.5 + (cur.current.lamp0 > 0.5 ? 0.12 : 0)) * (1 - 0.6 * focus);
  });
  return (
    <group>
      {/* 안의 불빛이 유리를 지나 모래 위에 번지는 빛 웅덩이 */}
      <mesh ref={pool} position={[0, -dims.floorHeight + 0.07, dims.floorHalfDepth * 0.5]} rotation-x={-Math.PI / 2} renderOrder={2}>
        <planeGeometry args={[dims.length + dims.radius * 4.5, dims.radius * 6]} />
        <meshBasicMaterial
          map={glowTexture()}
          color={WARM}
          transparent
          opacity={0}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
          toneMapped={false}
        />
      </mesh>
      {lamps.map((p, i) => (
        <group key={i} position={p}>
          <mesh ref={(m) => void (bulbs.current[i] = m)}>
            <sphereGeometry args={[0.13, 16, 12]} />
            <meshBasicMaterial toneMapped={false} />
          </mesh>
          <sprite ref={(m) => void (glows.current[i] = m)} scale={[4.6, 4.6, 1]} renderOrder={4}>
            <spriteMaterial
              map={glowTexture()}
              transparent
              depthWrite={false}
              blending={THREE.AdditiveBlending}
              toneMapped={false}
            />
          </sprite>
        </group>
      ))}
      {pointLight ? (
        <pointLight ref={light} position={[0, cy, 0]} distance={dims.radius * 4.5} decay={1.6} color="#ffb066" intensity={0} />
      ) : null}
      {/* 승인 대기: 단계 조명에 오렌지 보조광 */}
      <sprite ref={orangeGlow} position={[0, cy * 0.9, dims.floorHalfDepth * 0.2]} scale={[dims.length + 3, dims.radius * 2.2, 1]} renderOrder={4}>
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
    </group>
  );
}
