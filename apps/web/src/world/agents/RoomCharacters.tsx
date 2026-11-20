import { createContext, Suspense, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import type { CapsuleInteriorContext } from '../types';
import { ambienceTargets } from '../capsule/InteriorLights';
import { interiorSpec } from '../interiors/layouts';
import { Actor, PAWN_H, type ActorRuntime } from './Actor';
import { doorSpot, planRoom } from './plan';
import type { CharacterInput } from './types';

/** 월드 전체의 "지금 어느 캡슐에 누가 있는가"(Director가 이동 연출을 반영해 만든 값) */
export interface CharacterCtxValue {
  byRoom: Readonly<Record<string, readonly CharacterInput[]>>;
  /** 이동 연출용: 캐릭터가 드나드는 문 쪽(-1/+1) */
  doors: Readonly<Record<string, -1 | 1>>;
  replaying: boolean;
  reducedMotion: boolean;
}
export const CharacterCtx = createContext<CharacterCtxValue | null>(null);
const EMPTY: readonly CharacterInput[] = [];
const LEAVE_MS = 950;

interface Shown {
  char: CharacterInput;
  leaving: boolean;
  leftAt: number;
}

/** 사라진 캐릭터를 퇴장 모션이 끝날 때까지 잠시 더 들고 있는다 */
function useRetained(list: readonly CharacterInput[]): Shown[] {
  const [shown, setShown] = useState<Shown[]>(() => list.map((c) => ({ char: c, leaving: false, leftAt: 0 })));
  const listRef = useRef(list);
  listRef.current = list;
  useEffect(() => {
    setShown((prev) => {
      const now = performance.now();
      const ids = new Set(list.map((c) => c.id));
      const next: Shown[] = list.map((c) => ({ char: c, leaving: false, leftAt: 0 }));
      for (const p of prev) {
        if (ids.has(p.char.id)) continue;
        if (p.leaving) {
          if (now - p.leftAt < LEAVE_MS) next.push(p);
        } else next.push({ char: p.char, leaving: true, leftAt: now });
      }
      return next;
    });
  }, [list]);
  useEffect(() => {
    if (!shown.some((s) => s.leaving)) return;
    const id = window.setTimeout(() => {
      const now = performance.now();
      setShown((prev) => prev.filter((s) => !s.leaving || now - s.leftAt < LEAVE_MS));
    }, LEAVE_MS + 60);
    return () => window.clearTimeout(id);
  }, [shown]);
  return shown;
}

const silGeo = new THREE.CapsuleGeometry(0.14, 0.42, 4, 12);

/**
 * 캡슐 하나 안의 사람·Agent. WorldCanvas가 실내 자식으로 넣는다(캡슐 로컬 좌표: 바닥 윗면 원점).
 * 좌석 배치(interiorSeats), 보드 앞 자리, 문(등장·퇴장), 조명 단계에 따른 밝기를 계획하고 Actor에 넘긴다.
 */
export function RoomCharacters({ ctx }: { ctx: CapsuleInteriorContext }) {
  const cv = useContext(CharacterCtx);
  const roomId = ctx.model.roomId;
  const list = cv?.byRoom[roomId] ?? EMPTY;
  const shown = useRetained(list);
  const spec = useMemo(() => interiorSpec(ctx.model.theme, ctx.model.themeVariant, ctx.dims), [ctx.model.theme, ctx.model.themeVariant, ctx.dims]);
  // 계획은 퇴장 중인 캐릭터도 포함해 계산한다(자리가 갑자기 바뀌지 않게)
  const all = useMemo(() => shown.map((s) => s.char), [shown]);
  const plan = useMemo(
    () =>
      planRoom(all, { kind: ctx.model.kind, ownerId: ownerIdOf(ctx), memberIds: ctx.model.memberIds }, spec, ctx.dims),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [all, spec, ctx.dims, ctx.model.kind],
  );
  const positions = useMemo(() => new Map<string, THREE.Vector3>(), []);
  const light = useRef({ current: 1 });
  const cur = useRef(ctx.model.ambience === 'empty' ? 0 : 1);
  useFrame((_, dt) => {
    const t = ambienceTargets(ctx.model.ambience);
    cur.current = THREE.MathUtils.damp(cur.current, t.level, 4, dt);
    light.current.current = cur.current;
  });
  const rt = useMemo<ActorRuntime>(
    () => ({
      positions,
      plan,
      light: light.current,
      quality: ctx.quality,
      replaying: cv?.replaying ?? false,
      reducedMotion: cv?.reducedMotion ?? false,
      doorFor: (side) => doorSpot(ctx.dims, side),
      roomId,
    }),
    [positions, plan, ctx.quality, ctx.dims, roomId, cv?.replaying, cv?.reducedMotion],
  );

  return (
    <group name="characters">
      <Suspense fallback={null}>
        {plan.emptySeats.map((e) => (
          <mesh key={`sil-${e.userId}`} geometry={silGeo} position={[e.spot.x, PAWN_H * 0.45, e.spot.z - 0.14]} renderOrder={5}>
            <meshBasicMaterial
              color={ctx.model.memberColors[0] ?? '#ffffff'}
              transparent
              opacity={0.22}
              depthWrite={false}
              toneMapped={false}
              blending={THREE.AdditiveBlending}
            />
          </mesh>
        ))}
        {shown.map((s) => (
          <Actor
            key={s.char.id}
            char={s.char}
            rt={rt}
            leaving={s.leaving}
            enterSide={cv?.doors[s.char.id] ?? 1}
            leaveSide={cv?.doors[s.char.id] ?? 1}
          />
        ))}
      </Suspense>
    </group>
  );
}

function ownerIdOf(ctx: CapsuleInteriorContext): string | null {
  // my Room의 소유자: memberColors는 색뿐이라 roomId 규칙 대신 CapsuleModel.relation/label을 쓰지 않고, 모델에 ownerId를 싣는다
  return (ctx.model as { ownerId?: string | null }).ownerId ?? null;
}
