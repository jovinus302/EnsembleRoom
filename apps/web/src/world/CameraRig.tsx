import { useEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import type { WorldLayout } from './layout';
import { totalLength } from './capsule/dims';
import { SUN_DIRECTION, patchSky, skyState } from './sky';
import { cameraNudge } from './fx/cameraNudge';

export const INTRO_MS = 3000;
/** 하늘이 올라온 뒤 석양 구도를 이만큼 보여 주고 내려오기 시작한다 */
const INTRO_HOLD_MS = 1500;
/** 하늘이 올라온 뒤(캔버스 페이드 인이 끝나는 만큼) 기다렸다가 시작 시각을 잡는다 */
const INTRO_FADE_MS = 500;
const INTRO_DIST = 54;
const INTRO_CAM_Y = 2.6;
const INTRO_PITCH_DEG = 4.6;

export interface CameraPose {
  position: THREE.Vector3;
  target: THREE.Vector3;
}

/** 대상이 화면에서 차지하는 비율: 카메라 거리를 가로폭(월드 단위)에 맞춘다 */
function fitDistance(width: number, aspect: number, fovDeg: number): number {
  const vHalf = THREE.MathUtils.degToRad(fovDeg) / 2;
  const hHalf = Math.atan(Math.tan(vHalf) * aspect);
  return width / 2 / Math.tan(hHalf);
}

const OVERVIEW_PITCH = THREE.MathUtils.degToRad(19);
const FOCUS_PITCH = THREE.MathUtils.degToRad(14);

export function overviewPose(layout: WorldLayout, aspect: number, fov: number): CameraPose {
  const { minX, maxX, minZ, maxZ } = layout.bounds;
  const cx = (minX + maxX) / 2;
  const cz = (minZ + maxZ) / 2;
  const target = new THREE.Vector3(cx, 2.4, cz + 3);
  const at = (dist: number) =>
    new THREE.Vector3(cx, target.y + Math.sin(OVERVIEW_PITCH) * dist, target.z + Math.cos(OVERVIEW_PITCH) * dist);
  // 모든 캡슐(바닥 모서리와 꼭대기)이 화면 안에 들어오는 가장 가까운 거리를 찾는다. 위쪽은 하늘 자리로 남긴다
  const cam = new THREE.PerspectiveCamera(fov, aspect, 0.5, 3000);
  const pts: THREE.Vector3[] = [];
  for (const p of Object.values(layout.placements)) {
    const hl = totalLength(p.dims) / 2;
    const top = p.dims.axisHeight + p.dims.radius;
    for (const sx of [-1, 1])
      for (const sz of [-1, 1])
        for (const y of [0, top]) pts.push(new THREE.Vector3(p.x + sx * hl, y, p.z + sz * p.dims.radius));
  }
  let dist = 36;
  for (; dist < 240; dist += 2) {
    cam.position.copy(at(dist));
    cam.lookAt(target);
    cam.updateMatrixWorld();
    cam.updateProjectionMatrix();
    const ok = pts.every((q) => {
      const n = q.clone().project(cam);
      return Math.abs(n.x) < 0.94 && n.y > -0.9 && n.y < 0.7;
    });
    if (ok) break;
  }
  return { position: at(dist), target };
}

export function focusPose(layout: WorldLayout, roomId: string, aspect: number, fov: number): CameraPose | null {
  const p = layout.placements[roomId];
  if (!p) return null;
  const width = totalLength(p.dims) + 3.5;
  const dist = Math.max(fitDistance(width, aspect, fov), p.dims.radius * 5);
  const target = new THREE.Vector3(p.x, p.dims.floorHeight + p.dims.radius * 0.75, p.z);
  // 캡슐의 앞면 방향(rotY)에서 살짝 비껴 서서 입체감을 준다
  const az = p.rotY + 0.34;
  const position = new THREE.Vector3(
    target.x + Math.sin(az) * Math.cos(FOCUS_PITCH) * dist,
    target.y + Math.sin(FOCUS_PITCH) * dist,
    target.z + Math.cos(az) * Math.cos(FOCUS_PITCH) * dist,
  );
  return { position, target };
}

/** 틸트시프트가 따라갈 화면 좌표(0..1, 아래가 0). Postfx가 읽는다 */
export interface FocusUv {
  y: number;
}

/**
 * 월드 조망 ↔ 캡슐 포커스 카메라. 목표 포즈로 부드럽게 따라가고(감쇠), 포인터에 맞춰 아주 약하게 시차를 준다.
 * fov가 좁은 망원 구도라 멀리서 접사처럼 보인다(미니어처 느낌).
 */
export function CameraRig({
  layout,
  focusRoomId,
  focusUv,
  reducedMotion = false,
  intro = false,
}: {
  reducedMotion?: boolean;
  /** 첫 진입 인트로: 석양(태양 쪽 지평선)을 보다가 조망 구도로 내려온다 */
  intro?: boolean;
  layout: WorldLayout;
  focusRoomId: string | null;
  focusUv: React.RefObject<FocusUv>;
}) {
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;
  const size = useThree((s) => s.size);
  const aspect = size.width / Math.max(size.height, 1);
  const pose = useMemo(
    () => (focusRoomId ? focusPose(layout, focusRoomId, aspect, camera.fov) : null) ?? overviewPose(layout, aspect, camera.fov),
    [layout, focusRoomId, aspect, camera.fov],
  );
  const cur = useRef<CameraPose | null>(null);
  const tmp = useRef(new THREE.Vector3());
  const introRef = useRef<{ t0: number | null; from: CameraPose } | null>(null);
  const introDone = useRef(false);

  useEffect(() => {
    // 첫 마운트는 즉시 배치(또는 인트로 시작 포즈), 이후엔 감쇠 이동
    if (!cur.current) {
      cur.current = { position: pose.position.clone(), target: pose.target.clone() };
      if (intro && !reducedMotion && !focusRoomId && !introDone.current) {
        // 시작: 모래 바로 위 낮은 시점. 태양이 낮게 걸린 지평선 쪽에 캡슐 무리를 실루엣으로 세운다(역광, 바다 반사 띠가 앞에 깔린다)
        const dir = new THREE.Vector3(SUN_DIRECTION.x, 0, SUN_DIRECTION.z).normalize();
        const cx = pose.target.x;
        const cz = pose.target.z - 3;
        const pos = new THREE.Vector3(cx - dir.x * INTRO_DIST, INTRO_CAM_Y, cz - dir.z * INTRO_DIST);
        const look = pos.clone().addScaledVector(dir, 140);
        look.y = pos.y + 140 * Math.tan(THREE.MathUtils.degToRad(INTRO_PITCH_DEG));
        introRef.current = { t0: skyState.ready ? performance.now() + INTRO_FADE_MS : null, from: { position: pos, target: look } };
        patchSky({ introActive: true });
        const cancel = () => {
          introRef.current = null;
          patchSky({ introActive: false });
          window.removeEventListener('pointerdown', cancel);
        };
        window.addEventListener('pointerdown', cancel);
      }
      introDone.current = true;
      const start = introRef.current?.from ?? pose;
      camera.position.copy(start.position);
      camera.lookAt(start.target);
    }
  }, [pose, camera, intro, reducedMotion, focusRoomId]);

  useFrame((state, dt) => {
    const c = cur.current;
    if (!c) return;
    const it = introRef.current;
    if (it) {
      if (focusRoomId) {
        introRef.current = null;
        patchSky({ introActive: false });
      } else {
        // 하늘·바다가 올라오기 전에는 시작 구도에서 기다린다(안 보이는 동안 인트로가 끝나 버리지 않게)
        if (it.t0 === null && skyState.ready) it.t0 = performance.now() + INTRO_FADE_MS;
        const k = it.t0 === null ? 0 : Math.max(0, Math.min(1, (performance.now() - it.t0 - INTRO_HOLD_MS) / INTRO_MS));
        const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
        c.position.lerpVectors(it.from.position, pose.position, e);
        c.target.lerpVectors(it.from.target, pose.target, e);
        camera.position.copy(c.position);
        camera.lookAt(c.target);
        tmp.current.copy(pose.target).project(camera);
        if (focusUv.current) focusUv.current.y = THREE.MathUtils.clamp(tmp.current.y * 0.5 + 0.5, 0.15, 0.85);
        if (k >= 1) {
          introRef.current = null;
          patchSky({ introActive: false });
        }
        return;
      }
    }
    const lam = reducedMotion ? 14 : 3.2;
    c.position.x = THREE.MathUtils.damp(c.position.x, pose.position.x, lam, dt);
    c.position.y = THREE.MathUtils.damp(c.position.y, pose.position.y, lam, dt);
    c.position.z = THREE.MathUtils.damp(c.position.z, pose.position.z, lam, dt);
    c.target.x = THREE.MathUtils.damp(c.target.x, pose.target.x, lam, dt);
    c.target.y = THREE.MathUtils.damp(c.target.y, pose.target.y, lam, dt);
    c.target.z = THREE.MathUtils.damp(c.target.z, pose.target.z, lam, dt);
    const px = reducedMotion ? 0 : state.pointer.x * 0.9;
    const py = reducedMotion ? 0 : state.pointer.y * 0.35;
    camera.position.set(c.position.x + px + cameraNudge.cur.x, c.position.y + py + cameraNudge.cur.y, c.position.z + cameraNudge.cur.z);
    camera.lookAt(c.target);
    // 틸트시프트 초점 띠: 대상(포커스 캡슐 또는 조망의 중심 캡슐)의 화면 y
    tmp.current.copy(c.target).project(camera);
    if (focusUv.current) focusUv.current.y = THREE.MathUtils.clamp(tmp.current.y * 0.5 + 0.5, 0.15, 0.85);
  }, -2);
  return null;
}
