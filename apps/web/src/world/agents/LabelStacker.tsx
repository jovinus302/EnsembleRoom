import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';

/**
 * 포커스 방의 이름표(+말풍선) 겹침 회피. 각 Actor가 등록한 라벨 그룹을 매 프레임 화면에 투영해 서로 겹치면
 * 화면 위쪽(카메라 up)으로 밀어 올리고, 밀린 라벨에는 캐릭터 머리로 이어지는 가는 리더선을 그린다.
 * 화면 공간에서 계산하므로 카메라 회전·줌에서도 유지된다. reducedMotion이면 보간 없이 바로 옮긴다.
 */
export interface LabelEntry {
  /** 이름표와 말풍선을 담는 그룹(부모 = Actor 루트). position.y의 기준값은 baseY */
  group: THREE.Group;
  line: THREE.Line;
  baseY: number;
  /** 머리 위 리더선이 닿을 높이(루트 로컬) */
  headY: number;
  /** 이름표 월드 크기 (NameTag가 알려 준다) */
  w: number;
  h: number;
  /** 말풍선이 떠 있는 동안 그 영역(월드 크기)을 차지한다. 없으면 null */
  bubble: { w: number; h: number; y: number } | null;
  /** 지금 적용 중인 위쪽 이동량(월드) */
  cur: number;
  leaving: boolean;
}

const GAP_PX = 10;
const SIDE_PX = 4; // 가로로 이만큼 떨어져 있지 않으면 겹친 것으로 본다
const MAX_PUSH_ITER = 10;
const MAX_PUSH_H = 3; // 이름표 높이의 몇 배까지 밀어 올릴지
const EDGE_PX = 6;
const wp = new THREE.Vector3();
const ndc = new THREE.Vector3();
const up = new THREE.Vector3();
const a = new THREE.Vector3();
const b = new THREE.Vector3();

interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export function LabelStacker({ labels, reducedMotion }: { labels: Map<string, LabelEntry>; reducedMotion: boolean }) {
  const size = useThree((s) => s.size);
  useFrame((state, dt) => {
    const cam = state.camera as THREE.PerspectiveCamera;
    if (!cam.isPerspectiveCamera || labels.size === 0) return;
    up.setFromMatrixColumn(cam.matrixWorld, 1).normalize();
    const rows: { e: LabelEntry; cx: number; cy: number; wpp: number; pw: number; ph: number; top: number; target: number }[] = [];
    for (const e of labels.values()) {
      if (!e.group.parent) continue;
      wp.set(0, e.baseY, 0);
      e.group.parent.localToWorld(wp);
      const dist = wp.distanceTo(cam.position);
      ndc.copy(wp).project(cam);
      if (ndc.z > 1) {
        e.group.position.y = e.baseY;
        e.line.visible = false;
        continue;
      }
      const wpp = (2 * dist * Math.tan(THREE.MathUtils.degToRad(cam.fov / 2))) / size.height;
      const bw = e.bubble ? Math.max(e.w, e.bubble.w) : e.w;
      // 라벨 영역: 이름표 아래쪽부터 (말풍선이 있으면) 말풍선 위쪽까지
      const below = e.h / 2;
      const above = e.bubble ? e.bubble.y + e.bubble.h : e.h / 2;
      rows.push({
        e,
        cx: (ndc.x * 0.5 + 0.5) * size.width,
        cy: (-ndc.y * 0.5 + 0.5) * size.height,
        wpp,
        pw: bw / wpp,
        ph: (below + above) / wpp,
        top: above / wpp,
        target: 0,
      });
    }
    // 화면 아래(가까운 쪽)부터 자리를 잡는다: 앞줄 라벨이 제자리를 지키고 뒷줄이 위로 비켜 간다
    // 말풍선(alert 포함)이 있는 라벨이 먼저 자리를 잡고, 이름표가 비켜 간다
    rows.sort((p, q) => Number(!!q.e.bubble) - Number(!!p.e.bubble) || q.cy - p.cy);
    const placed: Rect[] = [];
    for (const r of rows) {
      let shift = 0; // px, 위로
      const maxShift = ((r.e.bubble ? r.e.h + r.e.bubble.h + r.e.bubble.y : r.e.h) / r.wpp) * MAX_PUSH_H;
      for (let it = 0; it < MAX_PUSH_ITER; it++) {
        const x0 = r.cx - r.pw / 2;
        const x1 = r.cx + r.pw / 2;
        const y1 = r.cy - shift + (r.ph - r.top); // 화면 아래쪽 가장자리(이름표 하단)
        const y0 = r.cy - shift - r.top;
        let hit: Rect | null = null;
        for (const p of placed) {
          if (x0 < p.x1 + SIDE_PX && x1 > p.x0 - SIDE_PX && y0 < p.y1 && y1 > p.y0) {
            if (!hit || p.y0 < hit.y0) hit = p;
          }
        }
        if (!hit) break;
        shift += y1 - (hit.y0 - GAP_PX); // 내 아래 가장자리를 겹친 라벨의 위쪽 가장자리 위로
        if (shift > maxShift) {
          shift = maxShift; // 너무 멀리 띄우지 않는다
          break;
        }
      }
      // 화면 위쪽 경계 밖이면 아래로 당겨 뷰 안에 둔다
      const topEdge = r.cy - shift - r.top;
      if (topEdge < EDGE_PX) shift -= EDGE_PX - topEdge;
      placed.push({ x0: r.cx - r.pw / 2, x1: r.cx + r.pw / 2, y0: r.cy - shift - r.top, y1: r.cy - shift + (r.ph - r.top) });
      r.target = shift * r.wpp;
    }
    for (const r of rows) {
      const e = r.e;
      e.cur = reducedMotion ? r.target : THREE.MathUtils.damp(e.cur, r.target, 10, Math.min(dt, 0.05));
      // 월드 위쪽 이동량을 부모 로컬 좌표 변화로 바꾼다(부모가 회전해도 맞다)
      wp.set(0, e.baseY, 0);
      e.group.parent!.localToWorld(wp);
      a.copy(wp).addScaledVector(up, e.cur);
      e.group.parent!.worldToLocal(a);
      e.group.position.set(a.x, a.y, a.z);
      // 리더선: 많이 밀렸을 때만 머리 -> 라벨 아래쪽
      const show = e.cur > 0.12 && !e.leaving;
      e.line.visible = show;
      if (show) {
        b.set(0, e.headY, 0);
        const pos = e.line.geometry.getAttribute('position') as THREE.BufferAttribute;
        pos.setXYZ(0, b.x, b.y, b.z);
        pos.setXYZ(1, a.x, a.y - e.h / 2, a.z);
        pos.needsUpdate = true;
      }
    }
  });
  return null;
}
