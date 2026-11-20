import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { INTERACTION_COLORS } from '@ensemble/shared';
import { AGENT_H, PAWN_H, type ActorRuntime } from './Actor';
import type { CharacterInput, CharacterLink } from './types';

/**
 * 포커스 방에서 상호작용 중인 두 캐릭터를 잇는 연결선(A2A 보라 점선 그라데이션, A2H 주황 실선) + 흐르는 펄스.
 * 머리 위를 지나는 2차 베지어를 카메라를 향한 리본으로 그린다(1px 선은 거의 안 보인다).
 * 투명도는 useFrame에서 계산하므로 시간이 지나도 리렌더가 필요 없다(pending이면 유지, 아니면 window 동안 감쇠).
 * 포인터 이벤트를 가로채지 않도록 raycast를 끈다.
 */

const SEGS = 24;
const WINDOW_MS = 8000;
// Actor와 맞춘다: 머리 높이 = (PAWN_H | AGENT_H) x CHAR_SCALE(1.3) x KIND_K (사람 1.14, Room Agent 0.8, Agent 0.7). 사람 ~1.21, Agent ~0.78, Room Agent ~0.89
const CHAR_SCALE = 1.3;
const HEAD_H = { human: PAWN_H * CHAR_SCALE * 1.14, room_agent: AGENT_H * CHAR_SCALE * 0.8, agent: AGENT_H * CHAR_SCALE * 0.7 } as const;
const noRaycast = () => undefined;

const VERT = /* glsl */ `
  attribute vec2 aUv;
  varying vec2 vUv;
  void main() {
    vUv = aUv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const FRAG = /* glsl */ `
  uniform vec3 uColA;
  uniform vec3 uColB;
  uniform vec3 uChan;
  uniform float uOpacity;
  uniform float uDash;
  uniform float uLen;
  uniform float uTime;
  uniform float uPulse;
  uniform float uReverse;
  varying vec2 vUv;
  void main() {
    float u = vUv.x;
    float ay = abs(vUv.y);
    float body = 1.0 - smoothstep(0.5, 0.62, ay);
    float rim = 1.0 - smoothstep(0.9, 1.0, ay);
    vec3 col = mix(mix(uColA, uColB, u), uChan, 0.75);
    // 어두운 외곽선 + 밝은 몸통: 유리·노을 배경 위에서도 읽힌다
    vec3 c = mix(vec3(0.07, 0.04, 0.16), col, body);
    float mask = 1.0;
    if (uDash > 0.5) {
      float d = fract(u * uLen * 4.0 - uTime * 0.6);
      mask = mix(0.3, 1.0, smoothstep(0.0, 0.08, d) * (1.0 - smoothstep(0.52, 0.6, d)));
    }
    float glow = 0.0;
    if (uPulse > 0.5) {
      for (int i = 0; i < 2; i++) {
        float p = fract(uTime * 0.45 + float(i) * 0.5);
        p = mix(p, 1.0 - p, uReverse);
        float x = (u - p) * 7.0;
        glow += exp(-x * x);
      }
    }
    glow = clamp(glow, 0.0, 1.0);
    c = mix(c, vec3(1.0), glow * body * 0.8);
    float a = rim * mask;
    a = clamp(a + glow * rim * 0.3, 0.0, 1.0);
    gl_FragColor = vec4(c, a * uOpacity);
  }
`;

function headOf(c: CharacterInput): number {
  return c.kind === 'human' ? HEAD_H.human : c.kind === 'room_agent' ? HEAD_H.room_agent : HEAD_H.agent;
}

interface BeamProps {
  from: CharacterInput;
  to: CharacterInput;
  link: CharacterLink;
  rt: ActorRuntime;
}

function Beam({ from, to, link, rt }: BeamProps) {
  const mesh = useRef<THREE.Mesh>(null);
  const geo = useMemo(() => {
    const g = new THREE.BufferGeometry();
    const n = (SEGS + 1) * 2;
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    const uv = new Float32Array(n * 2);
    const idx: number[] = [];
    for (let i = 0; i <= SEGS; i++) {
      uv.set([i / SEGS, -1], i * 4);
      uv.set([i / SEGS, 1], i * 4 + 2);
      if (i < SEGS) idx.push(i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 1, i * 2 + 3, i * 2 + 2);
    }
    g.setAttribute('aUv', new THREE.BufferAttribute(uv, 2));
    g.setIndex(idx);
    return g;
  }, []);
  const mat = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: VERT,
        fragmentShader: FRAG,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        toneMapped: false,
        uniforms: {
          uColA: { value: new THREE.Color() },
          uColB: { value: new THREE.Color() },
          uChan: { value: new THREE.Color() },
          uOpacity: { value: 0 },
          uDash: { value: 0 },
          uLen: { value: 1 },
          uTime: { value: 0 },
          uPulse: { value: 0 },
          uReverse: { value: 0 },
        },
      }),
    [],
  );
  const a = useRef(new THREE.Vector3());
  const b = useRef(new THREE.Vector3());
  const c = useRef(new THREE.Vector3());
  const p = useRef(new THREE.Vector3());
  const tan = useRef(new THREE.Vector3());
  const side = useRef(new THREE.Vector3());
  const cam = useRef(new THREE.Vector3());
  const fromHead = headOf(from);
  const toHead = headOf(to);
  const isA2A = link.channel === 'a2a';
  // 조망(light) 캡슐의 진행 표시는 low 티어에서도 펄스를 유지한다(멀리서 이 한 가지가 "진행 중"을 알려 준다)
  const pulseOn = (rt.quality !== 'low' || from.detail === 'light') && !rt.reducedMotion;
  const colA = isA2A ? from.color : INTERACTION_COLORS.a2h;
  const colB = isA2A ? to.color : INTERACTION_COLORS.a2h;

  useFrame(({ camera, clock }) => {
    const m = mesh.current;
    if (!m) return;
    const pa = rt.positions.get(from.id);
    const pb = rt.positions.get(to.id);
    // 시간 감쇠: pending은 유지, 아니면 window 동안 서서히 사라진다(재생 중에는 감쇠 없음)
    const age = Date.now() - link.at;
    const fade = rt.replaying || link.pending ? 1 : Math.max(0, 1 - age / WINDOW_MS);
    const opacity = (link.pending || rt.replaying ? 1 : fade) * (0.55 + 0.45 * rt.light.current);
    if (!pa || !pb || opacity <= 0.01) {
      m.visible = false;
      return;
    }
    m.visible = true;
    a.current.set(pa.x, fromHead * 0.92, pa.z);
    b.current.set(pb.x, toHead * 0.92, pb.z);
    const dist = a.current.distanceTo(b.current);
    // 머리 위를 지나는 2차 베지어: 제어점을 두 점의 중점 위로 띄운다
    c.current.copy(a.current).add(b.current).multiplyScalar(0.5);
    c.current.y = Math.max(fromHead, toHead) + 0.7 + dist * 0.25;
    m.parent?.worldToLocal(cam.current.copy(camera.position));
    const pos = geo.getAttribute('position') as THREE.BufferAttribute;
    // 조망(light)에서는 멀리서도 보이도록 리본을 넓힌다
    const hw = from.detail === 'light' ? 0.4 : 0.13;
    for (let i = 0; i <= SEGS; i++) {
      const t = i / SEGS;
      const it = 1 - t;
      // B(t) = (1-t)^2 A + 2(1-t)t C + t^2 B , B'(t) = 2(1-t)(C-A) + 2t(B-C)
      p.current.set(0, 0, 0).addScaledVector(a.current, it * it).addScaledVector(c.current, 2 * it * t).addScaledVector(b.current, t * t);
      tan.current.set(0, 0, 0).addScaledVector(c.current, 2 * it).addScaledVector(a.current, -2 * it).addScaledVector(b.current, 2 * t).addScaledVector(c.current, -2 * t);
      side.current.copy(cam.current).sub(p.current).cross(tan.current).normalize().multiplyScalar(hw);
      pos.setXYZ(i * 2, p.current.x - side.current.x, p.current.y - side.current.y, p.current.z - side.current.z);
      pos.setXYZ(i * 2 + 1, p.current.x + side.current.x, p.current.y + side.current.y, p.current.z + side.current.z);
    }
    pos.needsUpdate = true;
    const u = mat.uniforms;
    (u.uColA!.value as THREE.Color).set(colA);
    (u.uColB!.value as THREE.Color).set(colB);
    (u.uChan!.value as THREE.Color).set(isA2A ? INTERACTION_COLORS.a2a : INTERACTION_COLORS.a2h);
    u.uOpacity!.value = opacity;
    u.uDash!.value = isA2A ? 1 : 0;
    u.uLen!.value = dist;
    u.uTime!.value = rt.reducedMotion ? 0 : clock.elapsedTime;
    u.uPulse!.value = pulseOn ? 1 : 0;
    u.uReverse!.value = link.reverse ? 1 : 0;
  });

  return <mesh ref={mesh} geometry={geo} material={mat} frustumCulled={false} renderOrder={40} raycast={noRaycast} visible={false} />;
}

/** RoomCharacters가 캡슐 로컬 좌표(characters 그룹) 안에 마운트한다 */
export function InteractionBeams({ chars, rt }: { chars: readonly CharacterInput[]; rt: ActorRuntime }) {
  const beams = useMemo(() => {
    const byId = new Map(chars.map((c) => [c.id, c] as const));
    const out: { key: string; from: CharacterInput; to: CharacterInput; link: CharacterLink }[] = [];
    for (const c of chars) {
      if (!c.links) continue;
      for (const l of c.links) {
        const to = byId.get(l.toCharId);
        if (to) out.push({ key: `${c.id}>${l.toCharId}:${l.channel}:${l.seq}`, from: c, to, link: l });
      }
    }
    return out;
  }, [chars]);
  if (beams.length === 0) return null;
  return (
    <group name="interaction-beams">
      {beams.map((b) => (
        <Beam key={b.key} from={b.from} to={b.to} link={b.link} rt={rt} />
      ))}
    </group>
  );
}
