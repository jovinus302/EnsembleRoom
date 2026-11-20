import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { onFx, type FxEvent } from '../../fx/fxStore';
import type { WorldLayout } from '../layout';
import type { CapsuleModel } from '../types';
import type { CharacterInput } from '../agents/types';
import { getCharacterWorldPosition } from '../agents/registry';
import { glowTexture } from '../capsule/glow';
import { totalLength } from '../capsule/dims';
import { cursorWorld } from './cursorWorld';
import { cameraNudge } from './cameraNudge';
import { capsuleCenter, clamp01, easeInOut } from './geo';

/**
 * 3D 즉시 피드백 (S19a): 투사체(메시지·호출), 파문/충격 링, 방문 수락 와이프, 승인 결정체, 지면 소유 표식.
 * 모두 fxStore.onFx 하나로 구동된다. 캡슐 사이를 오가는 연출은 튜브 곡선을 따른다.
 */

interface Effect {
  /** false를 돌려주면 끝 */
  update: (now: number) => boolean;
  dispose: () => void;
}

const RING_GEO = new THREE.RingGeometry(0.86, 1, 64);

export interface FxSceneProps {
  layout: WorldLayout;
  models: Record<string, CapsuleModel>;
  curves: ReadonlyMap<string, THREE.Curve<THREE.Vector3>>;
  characters?: readonly CharacterInput[];
  viewerColor: string;
  reducedMotion: boolean;
  /** Room 안(포커스)에서는 캡슐 위 결정체가 화면 위로 삐져나오므로 그리지 않는다 */
  focusRoomId?: string | null;
}

export function FxScene(props: FxSceneProps) {
  const group = useRef<THREE.Group>(null);
  const effects = useRef<Effect[]>([]);
  const P = useRef(props);
  P.current = props;

  useFrame((_, dt) => {
    const now = performance.now();
    effects.current = effects.current.filter((e) => {
      const alive = e.update(now);
      if (!alive) e.dispose();
      return alive;
    });
    // 카메라 미세 이동 감쇠
    const n = cameraNudge;
    if (now > n.until) n.want.set(0, 0, 0);
    n.cur.lerp(n.want, 1 - Math.exp(-dt * 3));
  });

  useEffect(() => {
    const g = group.current;
    if (!g) return;
    const add = (e: Effect | null) => {
      if (e) effects.current.push(e);
    };
    const glowMat = (color: THREE.ColorRepresentation, opacity = 1) =>
      new THREE.SpriteMaterial({ map: glowTexture(), color, transparent: true, opacity, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending, toneMapped: false });

    /** 평평한(지면) 또는 임의 방향의 확산 링 */
    const ring = (at: THREE.Vector3, color: THREE.ColorRepresentation, r0: number, r1: number, dur: number, normal?: THREE.Vector3, delay = 0, strength = 1): Effect => {
      const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending, toneMapped: false });
      const mesh = new THREE.Mesh(RING_GEO, mat);
      mesh.renderOrder = 40;
      mesh.position.copy(at);
      if (normal) mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal.clone().normalize());
      else mesh.rotation.x = -Math.PI / 2;
      mesh.visible = false;
      g.add(mesh);
      const t0 = performance.now() + delay * 1000;
      return {
        update: (now) => {
          const t = (now - t0) / (dur * 1000);
          if (t < 0) return true;
          if (t >= 1) return false;
          mesh.visible = true;
          const e = 1 - Math.pow(1 - t, 3);
          mesh.scale.setScalar(r0 + (r1 - r0) * e);
          mat.opacity = Math.min(1, strength) * (1 - t) * Math.min(1, t * 8);
          return true;
        },
        dispose: () => {
          g.remove(mesh);
          mat.dispose();
        },
      };
    };

    /** 점이 경로를 따라 날아가는 빛 투사체(꼬리 포함) */
    const projectile = (pathAt: (u: number, out: THREE.Vector3) => void, color: THREE.ColorRepresentation, dur: number, onEnd?: () => void, size = 1.0): Effect => {
      const N = 7;
      const sprites = Array.from({ length: N }, (_, i) => {
        const s = new THREE.Sprite(glowMat(color, 1 - i / N));
        s.renderOrder = 41;
        s.scale.setScalar(size * (1 - i * 0.1));
        s.visible = false;
        g.add(s);
        return s;
      });
      const t0 = performance.now();
      const v = new THREE.Vector3();
      let ended = false;
      return {
        update: (now) => {
          const t = (now - t0) / (dur * 1000);
          if (t >= 1.12) return false;
          sprites.forEach((s, i) => {
            const u = clamp01(easeInOut(clamp01(t)) - i * 0.035);
            pathAt(u, v);
            s.position.copy(v);
            s.visible = t > 0 && t < 1.1;
            (s.material as THREE.SpriteMaterial).opacity = (1 - i / N) * (t > 1 ? 1 - (t - 1) / 0.12 : 1);
          });
          if (t >= 1 && !ended) {
            ended = true;
            onEnd?.();
          }
          return true;
        },
        dispose: () => {
          for (const s of sprites) {
            g.remove(s);
            (s.material as THREE.SpriteMaterial).dispose();
          }
        },
      };
    };

    /** 방문 수락/종료 와이프: 캡슐 정면 유리를 가로질러 빛 띠가 지나간다 */
    const wipe = (roomId: string, color: THREE.ColorRepresentation, dir: 1 | -1, dur: number): Effect | null => {
      const p = P.current.layout.placements[roomId];
      if (!p) return null;
      const w = totalLength(p.dims);
      const h = p.dims.radius * 2;
      const mat = new THREE.ShaderMaterial({
        uniforms: { uT: { value: 0 }, uColor: { value: new THREE.Color(color) }, uDir: { value: dir } },
        vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
        fragmentShader: `varying vec2 vUv; uniform float uT; uniform vec3 uColor; uniform float uDir;
          void main(){
            float x = uDir > 0.0 ? vUv.x : 1.0 - vUv.x;
            float c = uT * 1.5 - 0.25;
            float band = smoothstep(0.22, 0.0, abs(x - c));
            float trail = smoothstep(0.0, 0.5, c - x) * smoothstep(1.0, 0.0, (c - x) * 2.2) * 0.35;
            float edge = smoothstep(0.5, 0.0, abs(vUv.y - 0.5)) * 0.6 + 0.4;
            float a = (band + trail) * edge * (1.0 - smoothstep(0.7, 1.0, uT));
            gl_FragColor = vec4(uColor * 1.6, a);
            #include <tonemapping_fragment>
            #include <colorspace_fragment>
          }`,
        transparent: true,
        depthWrite: false,
        depthTest: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
      mesh.renderOrder = 39;
      mesh.position.set(p.x, p.dims.axisHeight, p.z);
      mesh.rotation.y = p.rotY;
      mesh.translateZ(p.dims.radius * 0.96);
      g.add(mesh);
      const t0 = performance.now();
      return {
        update: (now) => {
          const t = (now - t0) / (dur * 1000);
          mat.uniforms.uT!.value = clamp01(t);
          return t < 1;
        },
        dispose: () => {
          g.remove(mesh);
          mesh.geometry.dispose();
          mat.dispose();
        },
      };
    };

    // 사람은 접속 중이면 `h:<uid>`, 자리 비움이면 `ha:<uid>:<roomId>`로 등록된다: 못 찾으면 후자로 대체 조회
    const charPos = (id: string | null | undefined, out: THREE.Vector3, roomId?: string | null) => {
      if (!id) return false;
      if (getCharacterWorldPosition(id, out, true)) return true;
      return !!roomId && id.startsWith('h:') && !!getCharacterWorldPosition(`ha:${id.slice(2)}:${roomId}`, out, true);
    };
    const capPos = (roomId: string | null | undefined, lift = 0.5): THREE.Vector3 | null => {
      const p = roomId ? P.current.layout.placements[roomId] : undefined;
      return p ? capsuleCenter(p, new THREE.Vector3(), lift - p.dims.axisHeight + p.dims.floorHeight + 0.4) : null;
    };
    /** 튜브가 캡슐 유리에 닿는 지점과 방향(파문 위치) */
    const portOf = (roomId: string, hint?: string | null): { at: THREE.Vector3; n: THREE.Vector3 } | null => {
      const curves = P.current.curves;
      let key: string | null = null;
      for (const k of curves.keys()) {
        const [a, b] = k.split('>');
        if (a === roomId || b === roomId) {
          if (!key || (hint && (a === hint || b === hint))) key = k;
        }
      }
      if (!key) return null;
      const [a] = key.split('>');
      const c = curves.get(key)!;
      const atStart = a === roomId;
      const at = c.getPointAt(atStart ? 0 : 1);
      const tan = c.getTangentAt(atStart ? 0 : 1).multiplyScalar(atStart ? -1 : 1);
      return { at, n: tan };
    };
    const colorOfChar = (id: string | null | undefined) => P.current.characters?.find((c) => c.id === id)?.color ?? '#ffffff';
    const nudgeTo = (roomId: string | null | undefined, ev: FxEvent) => {
      if (!(ev.mine || ev.involvesMe)) return;
      const p = roomId ? P.current.layout.placements[roomId] : undefined;
      if (!p || P.current.reducedMotion) return;
      cameraNudge.want.set(THREE.MathUtils.clamp(p.x * 0.05, -0.9, 0.9), 0.15, 0);
      cameraNudge.until = performance.now() + 1700;
    };

    const arcPath = (a: THREE.Vector3, b: THREE.Vector3, lift: number) => {
      const mid = a.clone().add(b).multiplyScalar(0.5);
      mid.y += lift + a.distanceTo(b) * 0.12;
      const curve = new THREE.QuadraticBezierCurve3(a.clone(), mid, b.clone());
      return (u: number, out: THREE.Vector3) => curve.getPoint(u, out);
    };

    const off = onFx((ev) => {
      const L = P.current.layout;
      const pl = ev.roomId ? L.placements[ev.roomId] : undefined;
      const model = ev.roomId ? P.current.models[ev.roomId] : undefined;
      const rcol = ev.color ?? (ev.actorId ? colorOfChar(ev.actorId) : P.current.viewerColor);
      switch (ev.kind) {
        case 'send_local':
        case 'message': {
          const a = new THREE.Vector3();
          const b = new THREE.Vector3();
          const hasA = charPos(ev.actorId, a, ev.roomId);
          let hasB = charPos(ev.targetId, b, ev.roomId);
          if (!hasB && ev.roomId) {
            // 수신자 지정이 없으면 같은 Room의 다른 인물에게(Agent 우선), 없으면 캡슐 한가운데로
            const others = (P.current.characters ?? []).filter((c) => c.roomId === ev.roomId && c.id !== ev.actorId);
            const pick = others.find((c) => c.kind !== 'human') ?? others[0];
            hasB = !!pick && charPos(pick.id, b);
          }
          if (!hasB) {
            const c = capPos(ev.roomId, 1.5);
            if (c) {
              b.copy(c);
              hasB = true;
            }
          }
          if (!hasB) return;
          if (!hasA) {
            if (ev.roomId && !ev.actorId) {
              // 구독 밖 Room의 새 소식: 하늘 쪽에서 캡슐로 떨어지는 빛 + 링
              add(ring(b.clone().setY(0.2), rcol, 0.5, 4.5, 0.9, undefined, 0, 0.9));
              const from = b.clone().add(new THREE.Vector3(0, 7, 0));
              add(projectile(arcPath(from, b, 0), rcol, 0.7, undefined, 1.0));
              return;
            }
            a.copy(b).add(new THREE.Vector3(-3, 1.2, 1));
          }
          const col = ev.color ?? (ev.mine ? P.current.viewerColor : rcol);
          add(
            projectile(arcPath(a, b, 1.4), col, ev.kind === 'send_local' ? 0.55 : 0.7, () => add(ring(b.clone().setY(Math.max(0.2, b.y - 0.9)), col, 0.3, 1.8, 0.7)), 1.1),
          );
          add(ring(a.clone().setY(Math.max(0.2, a.y - 0.9)), col, 0.2, 1.2, 0.5));
          break;
        }
        case 'agent_called': {
          const b = new THREE.Vector3();
          if (charPos(ev.actorId, b, ev.roomId)) {
            add(ring(b.clone().setY(b.y - 0.8), rcol, 0.3, 2.2, 0.8));
            add(ring(b.clone().setY(b.y - 0.8), '#ffffff', 0.2, 1.4, 0.6, undefined, 0.1, 0.7));
          }
          break;
        }
        case 'approval_requested': {
          const c = capPos(ev.roomId, 1);
          if (c && pl) {
            const base = new THREE.Vector3(pl.x, 0.15, pl.z);
            for (let i = 0; i < 3; i++) add(ring(base, '#ff8a3d', pl.dims.radius * 0.8, pl.dims.radius * 3.2, 1.1, undefined, i * 0.28));
            nudgeTo(ev.roomId, ev);
          }
          break;
        }
        case 'approval_resolved': {
          const c = capPos(ev.roomId, 1);
          if (c && pl) {
            const col = ev.outcome === 'rejected' ? '#8d97a8' : ev.outcome === 'edited' ? '#ffb066' : '#ffd36a';
            add(ring(new THREE.Vector3(pl.x, 0.15, pl.z), col, pl.dims.radius, pl.dims.radius * 3.4, 0.9));
            add(ring(new THREE.Vector3(pl.x, 0.15, pl.z), '#ffffff', pl.dims.radius * 0.8, pl.dims.radius * 2.2, 0.7, undefined, 0.08, 0.6));
            nudgeTo(ev.roomId, ev);
          }
          break;
        }
        case 'agreement': {
          if (!pl) return;
          const cols = ev.colors && ev.colors.length ? ev.colors : [P.current.viewerColor];
          const base = new THREE.Vector3(pl.x, 0.15, pl.z);
          const R = pl.dims.radius;
          // 양쪽 색 링이 모이고(0~0.8s) 우리 색으로 터진다(0.9s~)
          cols.slice(0, 3).forEach((c, i) => add(ring(base, c, R * 3.4, R * 1.0, 0.8, undefined, i * 0.06, 0.9)));
          const finalCol = model?.color ?? cols[0]!;
          for (let i = 0; i < 3; i++) add(ring(base, finalCol, R * 0.9, R * (3.2 + i * 0.5), 1.0, undefined, 0.85 + i * 0.12));
          add(ring(capsuleCenter(pl, new THREE.Vector3()), '#ffffff', R * 0.6, R * 2.4, 0.7, new THREE.Vector3(0, 0, 1), 0.9, 0.7));
          nudgeTo(ev.roomId, ev);
          break;
        }
        case 'visit_request': {
          const a = capPos(ev.fromRoomId, 0.8);
          if (a) add(ring(new THREE.Vector3(a.x, 0.2, a.z), rcol, 0.6, 3.5, 0.8));
          break;
        }
        case 'visit_accept': {
          if (ev.roomId) {
            add(wipe(ev.roomId, '#bfe6ff', 1, 1.1));
            if (pl) add(ring(new THREE.Vector3(pl.x, 0.15, pl.z), '#bfe6ff', pl.dims.radius, pl.dims.radius * 3, 1.0));
          }
          break;
        }
        case 'visit_end': {
          if (ev.roomId) add(wipe(ev.roomId, '#e8f3ff', -1, 1.0));
          break;
        }
        case 'agent_depart':
        case 'agent_arrive':
        case 'agent_return': {
          // 유리를 통과하는 지점의 파문(체크리스트 10): 튜브가 유리에 닿는 자리에 링 세 겹
          const room = ev.kind === 'agent_depart' ? ev.fromRoomId ?? ev.roomId : ev.roomId;
          const hint = ev.kind === 'agent_depart' ? ev.toRoomId : ev.fromRoomId;
          const port = room ? portOf(room, hint) : null;
          const col = ev.color ?? colorOfChar(ev.actorId);
          if (port) {
            for (let i = 0; i < 3; i++) add(ring(port.at, i === 0 ? '#ffffff' : col, 0.25, 2.1 + i * 0.5, 0.9, port.n, i * 0.14, 0.9));
          } else if (pl) {
            add(ring(new THREE.Vector3(pl.x, 0.15, pl.z), col, pl.dims.radius, pl.dims.radius * 2.6, 0.9));
          }
          break;
        }
        case 'leave': {
          if (pl) {
            const c = ev.color ?? '#ffffff';
            add(ring(new THREE.Vector3(pl.x, 0.15, pl.z), c, pl.dims.radius, pl.dims.radius * 2.6, 1.0));
          }
          break;
        }
        case 'rejoin': {
          if (pl) {
            const base = new THREE.Vector3(pl.x, 0.15, pl.z);
            add(ring(base, '#ffffff', pl.dims.radius * 2.6, pl.dims.radius, 0.9, undefined, 0, 0.8));
            add(ring(base, ev.color ?? '#ffffff', pl.dims.radius * 3, pl.dims.radius * 1.1, 0.9, undefined, 0.15));
            nudgeTo(ev.roomId, ev);
          }
          break;
        }
        case 'memory': {
          if (pl) add(ring(new THREE.Vector3(pl.x, 0.15, pl.z), '#ffe08a', pl.dims.radius * 0.8, pl.dims.radius * 2.2, 0.9, undefined, 0, 0.8));
          break;
        }
        case 'agent_paused':
        case 'error': {
          if (pl) add(ring(new THREE.Vector3(pl.x, 0.15, pl.z), '#8d97a8', pl.dims.radius * 1.2, pl.dims.radius * 0.5, 0.9, undefined, 0, 0.8));
          break;
        }
        case 'hover': {
          if (pl && model) add(ring(new THREE.Vector3(pl.x, 0.12, pl.z), model.color, totalLength(pl.dims) * 0.28, totalLength(pl.dims) * 0.62, 0.55, undefined, 0, 0.7 * ev.gain));
          break;
        }
        case 'click': {
          if (cursorWorld.valid) {
            const col = cursorWorld.hoverRoom ? P.current.models[cursorWorld.hoverRoom]?.color ?? P.current.viewerColor : P.current.viewerColor;
            add(ring(cursorWorld.point.clone().setY(0.12), col, 0.3, 3.0, 0.6, undefined, 0, 0.9 * ev.gain));
          }
          break;
        }
        default:
          break;
      }
    });
    return () => {
      off();

      for (const e of effects.current) e.dispose();
      effects.current = [];
    };
  }, []);

  const attention = useMemo(
    () => props.layout.order.filter((id) => props.models[id]?.ambience === 'attention' && id !== props.focusRoomId),
    [props.layout, props.models, props.focusRoomId],
  );

  return (
    <>
      <group ref={group} />
      {Object.entries(props.layout.placements).map(([id, p]) => {
        const m = props.models[id];
        return m ? <GroundMark key={id} placement={p} model={m} /> : null;
      })}
      {attention.map((id) => {
        const p = props.layout.placements[id];
        return p ? <ApprovalCrystal key={id} placement={p} reducedMotion={props.reducedMotion} /> : null;
      })}
    </>
  );
}

/* ---------------- 지면 소유 표식 ---------------- */

const MARK_VERT = 'varying vec2 vP; void main(){ vP = position.xy; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }';
const MARK_FRAG = /* glsl */ `
varying vec2 vP;
uniform vec2 uHalf; uniform float uR; uniform vec3 uCols[4]; uniform int uN; uniform float uTime; uniform float uBoost;
float sdStadium(vec2 p){ float seg = max(uHalf.x - uHalf.y, 0.0); vec2 q = vec2(max(abs(p.x) - seg, 0.0), p.y); return length(q) - uHalf.y; }
void main(){
  float d = sdStadium(vP);
  float ringW = 0.13;
  float ring = smoothstep(ringW, 0.0, abs(d - 0.55));
  float glow = smoothstep(2.4, 0.2, d) * step(0.0, d) * 0.22;
  float tx = clamp(vP.x / (uHalf.x * 2.0) + 0.5, 0.0, 1.0) * float(uN - 1);
  int i0 = int(floor(tx));
  vec3 c0 = uCols[i0]; vec3 c1 = uCols[min(i0 + 1, uN - 1)];
  vec3 col = mix(c0, c1, fract(tx));
  // 우리 캡슐: 구성원 색이 테두리를 따라 흐른다
  float ang = atan(vP.y, vP.x);
  float flow = uN > 1 ? 0.75 + 0.25 * sin(ang * 2.0 - uTime * 1.2) : 1.0;
  float a = (ring * 0.9 * flow + glow) * uBoost;
  gl_FragColor = vec4(col * 1.35, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

function GroundMark({ placement: p, model }: { placement: WorldLayout['placements'][string]; model: CapsuleModel }) {
  const mat = useMemo(() => {
    const cols = (model.kind === 'our' ? model.memberColors : [model.color]).slice(0, 4);
    const arr = [0, 1, 2, 3].map((i) => new THREE.Color(cols[Math.min(i, cols.length - 1)]));
    return new THREE.ShaderMaterial({
      uniforms: {
        uHalf: { value: new THREE.Vector2(p.dims.floorHalfLength + 0.9, p.dims.floorHalfDepth + 0.9) },
        uR: { value: 0 },
        uCols: { value: arr },
        uN: { value: Math.max(cols.length, 1) },
        uTime: { value: 0 },
        uBoost: { value: 1 },
      },
      vertexShader: MARK_VERT,
      fragmentShader: MARK_FRAG,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      blending: THREE.NormalBlending,
    });
  }, [model.kind, model.color, model.memberColors, p.dims]);
  useEffect(() => () => mat.dispose(), [mat]);
  useFrame((s) => {
    mat.uniforms.uTime!.value = s.clock.elapsedTime;
  });
  const w = (p.dims.floorHalfLength + 3.6) * 2;
  const d = (p.dims.floorHalfDepth + 3.6) * 2;
  return (
    <mesh position={[p.x, 0.06, p.z]} rotation={[-Math.PI / 2, 0, p.rotY]} renderOrder={1} material={mat}>
      <planeGeometry args={[w, d]} />
    </mesh>
  );
}

/* ---------------- 승인 결정체 ---------------- */

/** 승인 대기 캡슐 위에 떠서 맥동하는 오렌지 결정(계획 8.5: 오렌지로 응결). 오렌지는 승인 전용 색이다 */
function ApprovalCrystal({ placement: p, reducedMotion }: { placement: WorldLayout['placements'][string]; reducedMotion: boolean }) {
  const mesh = useRef<THREE.Mesh>(null);
  const glow = useRef<THREE.Sprite>(null);
  const born = useRef(performance.now());
  const mat = useMemo(() => new THREE.MeshBasicMaterial({ color: '#ff9a4d', toneMapped: false, transparent: true, opacity: 0.95 }), []);
  const gmat = useMemo(
    () => new THREE.SpriteMaterial({ map: glowTexture(), color: '#ff8a3d', transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false, opacity: 0.8 }),
    [],
  );
  useEffect(
    () => () => {
      mat.dispose();
      gmat.dispose();
    },
    [mat, gmat],
  );
  useFrame((s) => {
    const m = mesh.current;
    const g = glow.current;
    if (!m || !g) return;
    const t = s.clock.elapsedTime;
    const pop = Math.min(1, (performance.now() - born.current) / 450);
    const pulse = reducedMotion ? 1 : 1 + 0.18 * Math.sin(t * 5.5);
    const sc = (1 - Math.pow(1 - pop, 3)) * 0.55 * pulse;
    m.scale.setScalar(sc);
    m.rotation.y = reducedMotion ? 0.5 : t * 1.6;
    m.position.y = p.dims.axisHeight + p.dims.radius + 3.4 + (reducedMotion ? 0 : Math.sin(t * 2.2) * 0.18);
    g.position.copy(m.position);
    g.scale.setScalar(sc * 4.2);
    gmat.opacity = 0.55 + 0.3 * Math.sin(t * 5.5);
  });
  return (
    <group position={[p.x, 0, p.z]}>
      <mesh ref={mesh} material={mat} renderOrder={42}>
        <octahedronGeometry args={[0.95, 0]} />
      </mesh>
      <sprite ref={glow} material={gmat} renderOrder={41} />
    </group>
  );
}
