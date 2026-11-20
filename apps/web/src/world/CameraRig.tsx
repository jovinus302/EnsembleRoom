import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import type { WorldLayout } from './layout';
import { footprintHalf, totalLength } from './capsule/dims';
import { SUN_DIRECTION, patchSky, skyState } from './sky';
import { cameraNudge } from './fx/cameraNudge';
import { ORBIT_MAX_ELEV_DEG, ORBIT_MAX_YAW_DEG, ORBIT_MAX_ZOOM, ORBIT_MIN_ELEV_DEG, ORBIT_MIN_ZOOM, useOrbit } from './cameraOrbit';

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

const OVERVIEW_PITCH = THREE.MathUtils.degToRad(25);
/** 포커스 기울기: 너무 낮으면 탁자 둘레에 선 호가 한 줄로 겹쳐 보인다 */
const FOCUS_PITCH = THREE.MathUtils.degToRad(19);
const MIN_ELEV = THREE.MathUtils.degToRad(ORBIT_MIN_ELEV_DEG);
const MAX_ELEV = THREE.MathUtils.degToRad(ORBIT_MAX_ELEV_DEG);

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
    const fp = footprintHalf(p.dims);
    const hl = Math.max(totalLength(p.dims) / 2, fp.hl);
    const hd = Math.max(p.dims.radius, fp.hd);
    const top = p.dims.axisHeight + p.dims.radius;
    for (const sx of [-1, 1])
      for (const sz of [-1, 1])
        for (const y of [0, top]) pts.push(new THREE.Vector3(p.x + sx * hl, y, p.z + sz * hd));
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
  const width = Math.max(totalLength(p.dims), 2 * footprintHalf(p.dims).hl) + 2.2;
  const dist = Math.max(fitDistance(width, aspect, fov), p.dims.radius * 5);
  const target = new THREE.Vector3(p.x, p.dims.floorHeight + p.dims.radius * 0.75 - (p.dims.proportion === 'plump' ? p.dims.radius / 3 : 0), p.z);
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
/** 가상 전체 화면(viewRect)의 높이. setViewOffset 때문에 화면 픽셀당 월드 길이는 canvas가 아니라 이 높이 기준이다 */
export function virtualHeight(camera: THREE.Camera, fallback: number): number {
  const c = camera as THREE.PerspectiveCamera;
  return c.view?.enabled ? c.view.fullHeight : fallback;
}

export interface ViewRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export function CameraRig({
  layout,
  viewRect,
  focusRoomId,
  focusUv,
  reducedMotion = false,
  intro = false,
}: {
  reducedMotion?: boolean;
  /** 첫 진입 인트로: 석양(태양 쪽 지평선)을 보다가 조망 구도로 내려온다 */
  intro?: boolean;
  layout: WorldLayout;
  /** 포커스 영역. 캔버스(전체 화면) 안에서 대상이 이 사각형 중앙에 오도록 투영을 옮긴다 */
  viewRect?: ViewRect | null;
  focusRoomId: string | null;
  focusUv: React.RefObject<FocusUv>;
}) {
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;
  const size = useThree((s) => s.size);
  const vr = viewRect && viewRect.width > 0 && viewRect.height > 0 ? viewRect : null;
  const aspect = vr ? vr.width / vr.height : size.width / Math.max(size.height, 1);
  // R3F는 camera.manual이면 리사이즈 때 aspect를 건드리지 않는다. 포커스 영역 기준 aspect + view offset은 여기서만 관리한다
  const applyView = (cam: THREE.PerspectiveCamera) => {
    const v = cam.view;
    if (vr) {
      const ox = -vr.left;
      const oy = -vr.top;
      if (cam.aspect === aspect && v?.enabled && v.fullWidth === vr.width && v.fullHeight === vr.height && v.offsetX === ox && v.offsetY === oy && v.width === size.width && v.height === size.height) return;
      cam.aspect = aspect;
      cam.setViewOffset(vr.width, vr.height, ox, oy, size.width, size.height);
    } else {
      if (cam.aspect === aspect && !v?.enabled) return;
      cam.aspect = aspect;
      cam.clearViewOffset();
    }
    cam.updateProjectionMatrix();
  };
  const applyViewRef = useRef(applyView);
  applyViewRef.current = applyView;
  useLayoutEffect(() => applyView(camera));
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

  // 사용자 조절: 드래그=회전·기울기, 휠=줌, 더블클릭/칩=초기화. 캔버스 위에서만 받으므로 2D UI 위 입력은 영향이 없다
  const orbit = useRef({ yaw: 0, pitch: 0, zoom: 1, tYaw: 0, tPitch: 0, tZoom: 1, baseElev: OVERVIEW_PITCH });
  const orb = useRef(new THREE.Vector3());
  const gl = useThree((s) => s.gl);
  const introRunning = () => introRef.current !== null;
  const resetOrbit = () => {
    const o = orbit.current;
    o.tYaw = o.tPitch = 0;
    o.tZoom = 1;
    if (reducedMotion) {
      o.yaw = o.pitch = 0;
      o.zoom = 1;
    }
    useOrbit.setState({ dirty: false });
  };
  const markDirty = () => {
    const o = orbit.current;
    const d = Math.abs(o.tYaw) > 0.01 || Math.abs(o.tPitch) > 0.01 || Math.abs(o.tZoom - 1) > 0.01;
    if (useOrbit.getState().dirty !== d) useOrbit.setState({ dirty: d });
  };
  // 포커스 대상이 바뀌면 오프셋을 버린다: 대상마다 자연스러운 구도가 달라서 이전 각도를 끌고 가면 어색하다
  useEffect(() => {
    resetOrbit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusRoomId]);
  useEffect(() => useOrbit.subscribe((s, p) => { if (s.resetSeq !== p.resetSeq) resetOrbit(); }), [reducedMotion]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const el = gl.domElement;
    const wrap = el.parentElement;
    if (!wrap) return;
    el.style.touchAction = 'none';
    let drag: { id: number; x: number; y: number; moved: boolean } | null = null;
    let justDragged = false;
    const DRAG_PX = 4;
    const down = (e: PointerEvent) => {
      if (!e.isPrimary || (e.pointerType === 'mouse' && e.button !== 0) || introRunning()) return;
      drag = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: false };
    };
    const move = (e: PointerEvent) => {
      if (!drag || e.pointerId !== drag.id) return;
      const o = orbit.current;
      if (!drag.moved) {
        if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < DRAG_PX) return;
        drag.moved = true;
        el.style.cursor = 'grabbing';
        drag.x = e.clientX;
        drag.y = e.clientY;
        return;
      }
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      drag.x = e.clientX;
      drag.y = e.clientY;
      const yawMax = THREE.MathUtils.degToRad(ORBIT_MAX_YAW_DEG);
      o.tYaw = THREE.MathUtils.clamp(o.tYaw - dx * 0.0055, -yawMax, yawMax);
      // 아래로 끌면 카메라가 올라간다(장면을 잡아 돌리는 느낌)
      o.tPitch = THREE.MathUtils.clamp(o.tPitch + dy * 0.004, MIN_ELEV - o.baseElev, MAX_ELEV - o.baseElev);
      if (reducedMotion) {
        o.yaw = o.tYaw;
        o.pitch = o.tPitch;
      }
      markDirty();
    };
    const up = (e: PointerEvent) => {
      if (!drag || e.pointerId !== drag.id) return;
      if (drag.moved) {
        justDragged = true;
        window.setTimeout(() => (justDragged = false), 0);
      }
      drag = null;
      el.style.cursor = '';
    };
    const click = (e: MouseEvent) => {
      if (justDragged) {
        justDragged = false;
        e.stopPropagation();
      }
    };
    const wheel = (e: WheelEvent) => {
      if (introRunning()) return;
      e.preventDefault();
      const o = orbit.current;
      o.tZoom = THREE.MathUtils.clamp(o.tZoom * Math.exp(e.deltaY * 0.0012), ORBIT_MIN_ZOOM, ORBIT_MAX_ZOOM);
      if (reducedMotion) o.zoom = o.tZoom;
      markDirty();
    };
    const dbl = () => {
      if (!introRunning()) resetOrbit();
    };
    el.addEventListener('pointerdown', down);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    el.addEventListener('wheel', wheel, { passive: false });
    el.addEventListener('dblclick', dbl);
    // R3F는 부모 div에서 click을 받는다: 캡처 단계에서 끊어 드래그 끝의 click이 선택·포커스로 번지지 않게 한다
    wrap.addEventListener('click', click, true);
    return () => {
      el.removeEventListener('pointerdown', down);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      el.removeEventListener('wheel', wheel);
      el.removeEventListener('dblclick', dbl);
      wrap.removeEventListener('click', click, true);
      el.style.cursor = '';
    };
  }, [gl, reducedMotion]); // eslint-disable-line react-hooks/exhaustive-deps

  useFrame((state, dt) => {
    applyViewRef.current(camera);
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
    // 사용자 오프셋(회전·기울기·줌)을 감쇠된 포즈 위에 얹는다
    const o = orbit.current;
    const ok = reducedMotion ? 1 : 1 - Math.exp(-10 * dt);
    o.yaw += (o.tYaw - o.yaw) * ok;
    o.pitch += (o.tPitch - o.pitch) * ok;
    o.zoom += (o.tZoom - o.zoom) * ok;
    const v = orb.current.copy(c.position).sub(c.target);
    const r0 = Math.max(v.length(), 0.001);
    const elev0 = Math.asin(THREE.MathUtils.clamp(v.y / r0, -1, 1));
    o.baseElev = elev0;
    const az = Math.atan2(v.x, v.z) + o.yaw;
    const elev = THREE.MathUtils.clamp(elev0 + o.pitch, MIN_ELEV, MAX_ELEV);
    const r = r0 * o.zoom;
    const ce = Math.cos(elev);
    v.set(Math.sin(az) * ce * r, Math.sin(elev) * r, Math.cos(az) * ce * r);
    const px = reducedMotion ? 0 : state.pointer.x * 0.9;
    const py = reducedMotion ? 0 : state.pointer.y * 0.35;
    camera.position.set(c.target.x + v.x + px + cameraNudge.cur.x, c.target.y + v.y + py + cameraNudge.cur.y, c.target.z + v.z + cameraNudge.cur.z);
    camera.lookAt(c.target);
    // 틸트시프트 초점 띠: 대상(포커스 캡슐 또는 조망의 중심 캡슐)의 화면 y
    tmp.current.copy(c.target).project(camera);
    if (focusUv.current) focusUv.current.y = THREE.MathUtils.clamp(tmp.current.y * 0.5 + 0.5, 0.15, 0.85);
  }, -2);
  return null;
}
