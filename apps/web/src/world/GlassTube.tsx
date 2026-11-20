import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { applyFrost, createShellMaterial } from './capsule/GlassMaterial';
import { TUBE_R, TUBE_Y, type TubePort, type TubeRoute } from './routing';

export { TUBE_R, TUBE_Y } from './routing';
const R = TUBE_R;
const TUBE_RADIAL = 16;
const STRIP_RADIAL = 6;

const lookMatrix = (tangent: THREE.Vector3) => new THREE.Matrix4().lookAt(new THREE.Vector3(), tangent, new THREE.Vector3(0, 1, 0));

function paint(g: THREE.BufferGeometry, color: THREE.Color) {
  const n = g.getAttribute('position').count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    arr[i * 3] = color.r;
    arr[i * 3 + 1] = color.g;
    arr[i * 3 + 2] = color.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
}

/** 포트의 접합부 부품: 칼라(소유 캡슐 색 링판), 슬리브(금속 통), 립 링. 로컬 +z = 법선 */
function junction(port: TubePort, color: THREE.Color) {
  const m = lookMatrix(port.normal);
  const place = (g: THREE.BufferGeometry, offset: number) => {
    g.applyMatrix4(m);
    g.translate(port.pos.x + port.normal.x * offset, port.pos.y, port.pos.z + port.normal.z * offset);
    return g;
  };
  const collar = new THREE.CylinderGeometry(R + 0.17, R + 0.17, 0.1, 28);
  collar.rotateX(Math.PI / 2);
  place(collar, 0.05);
  paint(collar, color.clone().multiplyScalar(1.4));
  const sleeve = new THREE.CylinderGeometry(R + 0.06, R + 0.06, 0.42, 28, 1, true);
  sleeve.rotateX(Math.PI / 2);
  place(sleeve, 0.21);
  const lip = new THREE.TorusGeometry(R + 0.06, 0.045, 8, 32);
  place(lip, 0.42);
  paint(lip, new THREE.Color('#fff1d6'));
  return { collar, sleeve, lip };
}

/**
 * 유리 튜브 통로 (계획 8.3). 두 캡슐 받침(트레이) 옆면의 포트에서 곧게 나와 모래 위를 낮게 지나 상대 포트로 이어진다.
 * 경로는 routing.ts의 route만 쓴다(교차는 아치). 포트마다 칼라 + 슬리브 + 립 링으로 접합부를 마감한다.
 * 안쪽 바닥 띠가 출발 쪽 색에서 도착 쪽 색으로 그라데이션된다. 튜브는 항상 맑은 가짜 유리다(투과 슬롯을 쓰지 않는다).
 * draw call: back, strip, front, metal, glow = 5개.
 */
export function GlassTube({
  route,
  colorA,
  colorB,
  dim = 1,
}: {
  route: TubeRoute;
  colorA: string;
  colorB: string;
  /** 0~1: 포커스 중 시야를 가리지 않도록 흐리게 (1=기본) */
  dim?: number;
}) {
  const built = useMemo(() => {
    const { curve, segments } = route;
    const outer = new THREE.TubeGeometry(curve, segments, R, TUBE_RADIAL, false);
    // 안쪽 바닥 띠: 같은 곡선을 아래로 내린 얇은 튜브(출발 색 -> 도착 색). 아치를 따라간다
    const stripPts = curve.getSpacedPoints(segments).map((p) => new THREE.Vector3(p.x, p.y - (TUBE_Y - 0.2), p.z));
    const strip = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(stripPts), segments, 0.17, STRIP_RADIAL, false);
    const vcount = strip.getAttribute('position').count;
    const cA = new THREE.Color(colorA);
    const cB = new THREE.Color(colorB);
    const arr = new Float32Array(vcount * 3);
    const perRing = STRIP_RADIAL + 1;
    const tmp = new THREE.Color();
    for (let i = 0; i < vcount; i++) {
      const t = Math.min(Math.floor(i / perRing) / segments, 1);
      tmp.copy(cA).lerp(cB, t);
      arr[i * 3] = tmp.r;
      arr[i * 3 + 1] = tmp.g;
      arr[i * 3 + 2] = tmp.b;
    }
    strip.setAttribute('color', new THREE.BufferAttribute(arr, 3));
    const ja = junction(route.portA, cA);
    const jb = junction(route.portB, cB);
    const metal = mergeGeometries([ja.sleeve, jb.sleeve])!;
    const glow = mergeGeometries([ja.collar, ja.lip, jb.collar, jb.lip])!;
    for (const g of [ja.sleeve, jb.sleeve, ja.collar, ja.lip, jb.collar, jb.lip]) g.dispose();
    return { outer, strip, metal, glow };
  }, [route, colorA, colorB]);

  const front = useMemo(() => createShellMaterial(THREE.FrontSide), []);
  const back = useMemo(() => createShellMaterial(THREE.BackSide), []);
  const tint = useMemo(() => new THREE.Color(colorA).lerp(new THREE.Color(colorB), 0.5), [colorA, colorB]);
  const stripMat = useMemo(
    () => new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false, color: new THREE.Color(1.7, 1.7, 1.7), transparent: true }),
    [],
  );
  const metalMat = useMemo(() => new THREE.MeshStandardMaterial({ color: '#c28a56', roughness: 0.5, metalness: 0.2, side: THREE.DoubleSide }), []);
  const glowMat = useMemo(() => new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false }), []);
  const cur = useRef(dim);
  useFrame((_, dt) => {
    cur.current = THREE.MathUtils.damp(cur.current, dim, 6, dt);
    const k = cur.current;
    applyFrost(front, 0, tint, 0, false, false);
    applyFrost(back, 0, tint, 0, true, false);
    front.opacity = 0.12 * k;
    back.opacity = 0.1 * k;
    front.shell.rimStrength.value = 1.4 * k;
    back.shell.rimStrength.value *= k;
    stripMat.opacity = 0.25 + 0.75 * k;
  });
  useEffect(
    () => () => {
      built.outer.dispose();
      built.strip.dispose();
      built.metal.dispose();
      built.glow.dispose();
    },
    [built],
  );

  return (
    <group>
      <mesh geometry={built.outer} material={back} renderOrder={4} />
      <mesh geometry={built.strip} material={stripMat} renderOrder={3} />
      <mesh geometry={built.outer} material={front} renderOrder={11} />
      <mesh geometry={built.metal} material={metalMat} />
      <mesh geometry={built.glow} material={glowMat} />
    </group>
  );
}
