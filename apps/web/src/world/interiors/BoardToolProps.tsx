import { useEffect, useMemo, useRef, useState } from 'react';
import { useFrame, useThree, type ThreeEvent } from '@react-three/fiber';
import * as THREE from 'three';
import { BOARD_TOOL_LABEL, type BoardToolKind } from '@ensemble/shared';
import { useBoardToolScene, type BoardToolProp } from '../boardToolScene';
import { useBoardToolUi } from '../../store/boardToolStore';
import { WorldText } from '../text';
import type { V3 } from './layouts';

const EMPTY: BoardToolProp[] = [];
const EMPTY_IDS: string[] = [];
const MAX_SLOTS = 4;
const DROP_SEC = 0.45;

function usePrefersReducedMotion(): boolean {
  const [r, setR] = useState(() => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches);
  useEffect(() => {
    if (typeof matchMedia === 'undefined') return;
    const mq = matchMedia('(prefers-reduced-motion: reduce)');
    const on = () => setR(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return r;
}

// ------------------------------------------------------------------ 소품 모양 (primitive만)

interface Mats {
  wood: THREE.MeshStandardMaterial;
  woodDark: THREE.MeshStandardMaterial;
  paper: THREE.MeshStandardMaterial;
  coin: THREE.MeshStandardMaterial;
  coinDim: THREE.MeshStandardMaterial;
  map: THREE.MeshStandardMaterial;
  route: THREE.MeshStandardMaterial;
  bag: THREE.MeshStandardMaterial;
  bagTrim: THREE.MeshStandardMaterial;
  token: THREE.MeshStandardMaterial;
  clip: THREE.MeshStandardMaterial;
  check: THREE.MeshStandardMaterial;
}

function mk(color: string, rough = 0.7, metal = 0): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal });
  m.emissive.set(color);
  m.emissiveIntensity = 0.12;
  return m;
}

function useMats(): Mats {
  const mats = useMemo<Mats>(
    () => ({
      wood: mk('#d8b07a'),
      woodDark: mk('#a98550'),
      paper: mk('#fff6e4', 0.9),
      coin: mk('#d4b66a', 0.35, 0.6),
      coinDim: mk('#b0953f', 0.35, 0.6),
      map: mk('#bfe3b4', 0.9),
      route: mk('#e2574c', 0.6),
      bag: mk('#6fb3c0', 0.6),
      bagTrim: mk('#4f8e9b', 0.6),
      token: mk('#ff7a8a', 0.5),
      clip: mk('#aeb6c4', 0.35, 0.7),
      check: mk('#7cc17a', 0.5),
    }),
    [],
  );
  useEffect(() => () => Object.values(mats).forEach((m) => m.dispose()), [mats]);
  return mats;
}

function Ladder({ ran, m }: { ran: boolean; m: Mats }) {
  // 탁자 위에 눕혀 놓은 사다리 미니어처: 레일 2 + 가로대 4. 실행됐다면 한 가로대에 말(토큰)이 올라간다.
  const rungs = [-0.12, -0.04, 0.04, 0.12];
  return (
    <group>
      {[-0.07, 0.07].map((x) => (
        <mesh key={x} material={m.wood} position={[x, 0.016, 0]} castShadow>
          <boxGeometry args={[0.022, 0.022, 0.3]} />
        </mesh>
      ))}
      {rungs.map((z) => (
        <mesh key={z} material={m.woodDark} position={[0, 0.016, z]} castShadow>
          <boxGeometry args={[0.15, 0.014, 0.014]} />
        </mesh>
      ))}
      {ran ? (
        <mesh material={m.token} position={[0.07, 0.05, 0.12]} castShadow>
          <sphereGeometry args={[0.025, 12, 8]} />
        </mesh>
      ) : null}
    </group>
  );
}

function Settlement({ m }: { m: Mats }) {
  // 동전 스택 + 세워진 영수증
  return (
    <group>
      {[0, 1, 2, 3].map((i) => (
        <mesh key={i} material={i % 2 ? m.coinDim : m.coin} position={[-0.06, 0.008 + i * 0.016, 0.02]} castShadow>
          <cylinderGeometry args={[0.05, 0.05, 0.014, 18]} />
        </mesh>
      ))}
      <mesh material={m.coin} position={[0.0, 0.007, 0.1]} rotation={[0, 0.4, 0]} castShadow>
        <cylinderGeometry args={[0.045, 0.045, 0.012, 18]} />
      </mesh>
      <group position={[0.09, 0.0, -0.02]} rotation={[0, -0.35, 0]}>
        <mesh material={m.paper} position={[0, 0.095, 0]} rotation={[-0.12, 0, 0]} castShadow>
          <boxGeometry args={[0.11, 0.19, 0.008]} />
        </mesh>
        {[0, 1, 2].map((i) => (
          <mesh key={i} material={m.woodDark} position={[0, 0.14 - i * 0.04, 0.007]} rotation={[-0.12, 0, 0]}>
            <boxGeometry args={[0.07, 0.008, 0.002]} />
          </mesh>
        ))}
      </group>
    </group>
  );
}

function Trip({ m }: { m: Mats }) {
  // 펼친 지도(경로 점) + 여행 가방
  return (
    <group>
      <mesh material={m.map} position={[-0.04, 0.006, 0]} rotation={[0, 0.2, 0]} castShadow>
        <boxGeometry args={[0.2, 0.01, 0.15]} />
      </mesh>
      {[-0.07, -0.02, 0.03, 0.08].map((x, i) => (
        <mesh key={x} material={m.route} position={[x - 0.04, 0.0125, i % 2 ? 0.03 : -0.025]}>
          <cylinderGeometry args={[0.012, 0.012, 0.004, 10]} />
        </mesh>
      ))}
      <group position={[0.1, 0, 0.07]} rotation={[0, -0.4, 0]}>
        <mesh material={m.bag} position={[0, 0.055, 0]} castShadow>
          <boxGeometry args={[0.09, 0.11, 0.05]} />
        </mesh>
        <mesh material={m.bagTrim} position={[0, 0.125, 0]}>
          <boxGeometry args={[0.05, 0.02, 0.012]} />
        </mesh>
        <mesh material={m.bagTrim} position={[0, 0.055, 0.026]}>
          <boxGeometry args={[0.095, 0.012, 0.006]} />
        </mesh>
      </group>
    </group>
  );
}

function Custom({ m }: { m: Mats }) {
  // 비스듬히 세워 둔 클립보드: 나무 판 + 종이 + 체크 칸 3줄(하나는 체크됨) + 위쪽 클립
  return (
    <group position={[0, 0, 0.02]} rotation={[0, -0.25, 0]}>
      <mesh material={m.woodDark} position={[0, 0.115, 0]} rotation={[-0.2, 0, 0]} castShadow>
        <boxGeometry args={[0.15, 0.21, 0.012]} />
      </mesh>
      <group position={[0, 0.115, 0.008]} rotation={[-0.2, 0, 0]}>
        <mesh material={m.paper} position={[0, -0.005, 0]}>
          <boxGeometry args={[0.125, 0.175, 0.004]} />
        </mesh>
        {[0.05, 0.005, -0.04].map((y, i) => (
          <group key={y} position={[0, y, 0.004]}>
            <mesh material={i === 0 ? m.check : m.wood}>
              <boxGeometry args={[0.02, 0.02, 0.004]} />
            </mesh>
            <mesh material={m.woodDark} position={[0.04, 0, 0]}>
              <boxGeometry args={[0.06, 0.008, 0.003]} />
            </mesh>
          </group>
        ))}
      </group>
      <mesh material={m.clip} position={[0, 0.222, 0.012]} rotation={[-0.2, 0, 0]} castShadow>
        <boxGeometry args={[0.06, 0.028, 0.014]} />
      </mesh>
      {/* 뒤에서 받치는 다리 */}
      <mesh material={m.woodDark} position={[0, 0.06, -0.05]} rotation={[0.5, 0, 0]}>
        <boxGeometry args={[0.012, 0.13, 0.008]} />
      </mesh>
    </group>
  );
}

function Shape({ kind, ran, m }: { kind: BoardToolKind; ran: boolean; m: Mats }) {
  if (kind === 'ladder') return <Ladder ran={ran} m={m} />;
  if (kind === 'settlement') return <Settlement m={m} />;
  if (kind === 'custom') return <Custom m={m} />;
  return <Trip m={m} />;
}

// ------------------------------------------------------------------ 한 소품(등장 애니메이션 + 클릭 + 호버)

function PropItem({ tool, slot, scale, m, animate, reduced }: { tool: BoardToolProp; slot: V3; scale: number; m: Mats; animate: boolean; reduced: boolean }) {
  const gl = useThree((s) => s.gl);
  const ref = useRef<THREE.Group>(null);
  const t0 = useRef(animate && !reduced ? 0 : DROP_SEC);
  const [hover, setHover] = useState(false);
  useFrame((_, dt) => {
    const g = ref.current;
    if (!g) return;
    if (t0.current < DROP_SEC) t0.current = Math.min(DROP_SEC, t0.current + dt);
    const k = t0.current / DROP_SEC;
    // 작게 튀어 오르며 내려앉기: 위에서 떨어져 한 번 튕긴다
    const bounce = k >= 1 ? 0 : (1 - k) * (1 - k) * 0.28 + Math.abs(Math.sin(k * Math.PI * 2.2)) * 0.05 * (1 - k);
    const s = scale * (k >= 1 ? 1 : 0.55 + 0.45 * Math.min(1, k * 1.6));
    const hs = hover && !reduced ? 1.1 : 1;
    g.position.y = slot[1] + bounce;
    g.scale.setScalar(s * hs);
  });
  useEffect(
    () => () => {
      gl.domElement.style.cursor = '';
    },
    [gl],
  );
  const open = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    useBoardToolUi.getState().open(tool.id);
  };
  return (
    <group
      ref={ref}
      position={[slot[0], slot[1], slot[2]]}
      name={`board-tool-${tool.id}`}
      userData={{ boardToolId: tool.id, kind: tool.kind }}
      onClick={open}
      onPointerOver={(e) => {
        e.stopPropagation();
        setHover(true);
        gl.domElement.style.cursor = 'pointer';
      }}
      onPointerOut={() => {
        setHover(false);
        gl.domElement.style.cursor = '';
      }}
    >
      <Shape kind={tool.kind} ran={tool.ran} m={m} />
      {/* 클릭 판정을 넉넉하게 하는 보이지 않는 상자 */}
      <mesh position={[0, 0.07, 0]} visible={false}>
        <boxGeometry args={[0.32, 0.16, 0.34]} />
      </mesh>
      {hover ? (
        <WorldText position={[0, 0.27, 0]} fontSize={0.075} color="#ffffff" outlineWidth={0.008} outlineColor="#1a1a1a" anchorY="bottom" maxWidth={1.2} renderOrder={20}>
          {`${BOARD_TOOL_LABEL[tool.kind]} · ${tool.title}`}
        </WorldText>
      ) : null}
    </group>
  );
}

/**
 * 탁자 위 보드 도구 소품. 데이터는 포커스된 Room에서만 채워진다(useBoardToolScene).
 * 클릭은 stopPropagation 후 2D 시트를 연다. 카메라 드래그 직후의 click은 CameraRig가 캡처 단계에서 끊는다.
 */
export function BoardToolProps({ roomId, slots, scale }: { roomId: string; slots: readonly V3[]; scale: number }) {
  const list = useBoardToolScene((s) => s.byRoom[roomId] ?? EMPTY);
  const reduced = usePrefersReducedMotion();
  const m = useMats();
  const freshIds = useBoardToolScene((s) => s.fresh[roomId] ?? EMPTY_IDS);
  const shown = list.slice(0, Math.min(MAX_SLOTS, slots.length));
  if (shown.length === 0) return null;
  return (
    <group name="board-tools">
      {shown.map((t, i) => (
        <PropItem key={t.id} tool={t} slot={slots[i]!} scale={scale} m={m} animate={freshIds.includes(t.id)} reduced={reduced} />
      ))}
    </group>
  );
}
