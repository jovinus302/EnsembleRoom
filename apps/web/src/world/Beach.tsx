import { Suspense, useEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { Environment, useTexture } from '@react-three/drei';
import * as THREE from 'three';
import type { QualityConfig } from './quality';
import { FOG_COLOR, SUN_DIRECTION, SUN_VISUAL_DIRECTION, patchSky } from './sky';
import { HAZE, SAND, SEA_FAR, SEA_MID, SEA_SHORE, SKY_LOW, SKY_MID, SKY_TOP } from './scenePalette';

export const SHORE_Z = -46;
/** 바다 수면 높이. 모래는 물가에서 이 아래로 내려간다 */
const SEA_Y = -0.25;

export interface WorldBounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

// ------------------------------------------------------------------ 하늘: 절차적 그라디언트(scenePalette 색)
// 하늘 돔, 환경 캡처(유리 반사), 바다 반사가 모두 skyColor() 하나를 호출한다.

const SKY_GLSL = /* glsl */ `
  uniform vec3 skyTop;
  uniform vec3 skyMid;
  uniform vec3 skyLow;
  uniform vec3 skyHaze;
  uniform float skyGain;
  vec3 skyColor(vec3 d) {
    d = normalize(d);
    float e = d.y;
    vec3 c = mix(skyHaze, skyLow, smoothstep(0.0, 0.06, e));
    c = mix(c, skyMid, smoothstep(0.04, 0.32, e));
    c = mix(c, skyTop, smoothstep(0.30, 0.95, e));
    return c * skyGain;
  }
`;

function skyUniforms(gain: number) {
  return {
    skyTop: { value: new THREE.Color(SKY_TOP) },
    skyMid: { value: new THREE.Color(SKY_MID) },
    skyLow: { value: new THREE.Color(SKY_LOW) },
    skyHaze: { value: new THREE.Color(HAZE) },
    skyGain: { value: gain },
  };
}

function useSkyMaterial(gain = 1, sunGlow = false) {
  return useMemo(
    () =>
      new THREE.ShaderMaterial({
        side: THREE.BackSide,
        depthWrite: false,
        depthTest: false,
        fog: false,
        uniforms: {
          ...skyUniforms(gain),
          sunVis: { value: SUN_VISUAL_DIRECTION },
          sunGlow: { value: sunGlow ? 1 : 0 },
        },
        vertexShader: /* glsl */ `
          varying vec3 vDir;
          void main() {
            vDir = position;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }`,
        fragmentShader: /* glsl */ `
          varying vec3 vDir;
          uniform vec3 sunVis;
          uniform float sunGlow;
          ${SKY_GLSL}
          void main() {
            vec3 col = skyColor(vDir);
            if (sunGlow > 0.5) {
              // 태양 원반 + 흰색 후광
              float cs = max(dot(normalize(vDir), sunVis), 0.0);
              col += vec3(1.0, 0.98, 0.94) * (pow(cs, 800.0) * 4.0 + pow(cs, 40.0) * 0.35 + pow(cs, 6.0) * 0.12);
            }
            gl_FragColor = vec4(col, 1.0);
            #include <tonemapping_fragment>
            #include <colorspace_fragment>
          }`,
      }),
    [gain, sunGlow],
  );
}

/** 카메라를 따라다니는 하늘 구 (배경) */
function SkyBackdrop() {
  const mat = useSkyMaterial(1, true);
  const ref = useRef<THREE.Mesh>(null);
  useFrame(({ camera }) => ref.current?.position.copy(camera.position));
  return (
    <mesh ref={ref} material={mat} renderOrder={-100} frustumCulled={false}>
      <sphereGeometry args={[1500, 48, 32]} />
    </mesh>
  );
}

/** 환경광(큐브맵 캡처)용 하늘: 태양 원반 없이 그라디언트만 */
function SkyForEnv() {
  const mat = useSkyMaterial(1);
  return (
    <mesh material={mat}>
      <sphereGeometry args={[50, 32, 20]} />
    </mesh>
  );
}

// ------------------------------------------------------------------ 노이즈 (CPU, 모래 둔덕용)

function hash2(x: number, y: number) {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
}
function vnoise(x: number, y: number) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  return (
    hash2(xi, yi) * (1 - u) * (1 - v) + hash2(xi + 1, yi) * u * (1 - v) + hash2(xi, yi + 1) * (1 - u) * v + hash2(xi + 1, yi + 1) * u * v
  );
}
function fbm(x: number, y: number) {
  return vnoise(x, y) * 0.55 + vnoise(x * 2.1 + 5.2, y * 2.1 + 1.3) * 0.3 + vnoise(x * 4.3 + 9.1, y * 4.3 + 7.7) * 0.15;
}

/** 모래 높이장: 캡슐이 놓인 영역은 평평하게 두고 바깥으로 갈수록 완만한 둔덕, 물가는 바다 쪽으로 기운다 */
function sandHeight(x: number, z: number, b: WorldBounds) {
  const dx = Math.max(b.minX - 3 - x, 0, x - (b.maxX + 3));
  const dz = Math.max(b.minZ - 3 - z, 0, z - (b.maxZ + 4));
  const d = Math.hypot(dx, dz);
  const mask = THREE.MathUtils.smoothstep(d, 0.5, 14);
  let y = (fbm(x * 0.045, z * 0.06) - 0.45) * 2.6 * mask;
  y += (fbm(x * 0.17 + 40, z * 0.2) - 0.5) * 0.28 * mask; // 잔 물결
  // 물가 경사
  const t = THREE.MathUtils.clamp((z - (SHORE_Z - 8)) / 11, 0, 1);
  y += (t * t * (3 - 2 * t) - 1) * 0.95;
  return y;
}

const SAND_VERT_INJECT = /* glsl */ `
  varying vec2 vWXZ;
`;

/** 모래 바닥(텍스처 두 스케일 혼합, 젖은 모래 띠), 바다, 포말 */
function Ground({ bounds }: { bounds: WorldBounds }) {
  const [diff, nor, rough] = useTexture([
    '/assets/textures/sand_diff_1k.jpg',
    '/assets/textures/sand_nor_gl_1k.jpg',
    '/assets/textures/sand_rough_1k.jpg',
  ]);
  const gl = useThree((s) => s.gl);
  useMemo(() => {
    const aniso = Math.min(8, gl.capabilities.getMaxAnisotropy());
    for (const t of [diff, nor, rough]) {
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.anisotropy = aniso;
    }
    diff.colorSpace = THREE.SRGBColorSpace;
    nor.colorSpace = THREE.NoColorSpace;
    rough.colorSpace = THREE.NoColorSpace;
    // uv는 월드 좌표/10 → 한 타일 10 유닛
  }, [diff, nor, rough, gl]);

  const sandGeo = useMemo(() => {
    const W = 520;
    const D = 96 - (SHORE_Z - 10);
    const g = new THREE.PlaneGeometry(W, D, 260, 130);
    g.rotateX(-Math.PI / 2);
    g.translate(0, 0, (96 + SHORE_Z - 10) / 2);
    const pos = g.getAttribute('position');
    const uv = g.getAttribute('uv');
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      pos.setY(i, sandHeight(x, z, bounds));
      uv.setXY(i, x / 10, z / 10);
    }
    g.computeVertexNormals();
    return g;
  }, [bounds]);
  useEffect(() => () => sandGeo.dispose(), [sandGeo]);

  const sandMat = useMemo(() => {
    const m = new THREE.MeshStandardMaterial({
      map: diff,
      normalMap: nor,
      normalScale: new THREE.Vector2(0.7, 0.7),
      roughnessMap: rough,
      color: SAND,
      roughness: 1,
      envMapIntensity: 0.7,
    });
    m.onBeforeCompile = (sh) => {
      sh.uniforms.shoreZ = { value: SHORE_Z - 0.8 };
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', `#include <common>\n${SAND_VERT_INJECT}`)
        .replace('#include <begin_vertex>', '#include <begin_vertex>\n vWXZ = (modelMatrix * vec4(position, 1.0)).xz;');
      sh.fragmentShader = sh.fragmentShader
        .replace(
          '#include <common>',
          /* glsl */ `#include <common>
          varying vec2 vWXZ;
          uniform float shoreZ;
          float h21(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7))) * 43758.5453); }
          float vn(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.-2.*f);
            return mix(mix(h21(i),h21(i+vec2(1,0)),f.x), mix(h21(i+vec2(0,1)),h21(i+vec2(1,1)),f.x), f.y); }
          float sandWet(vec2 w){
            float edge = shoreZ + (vn(w*vec2(0.05,0.2))-0.5)*5.0 + sin(w.x*0.09)*1.6;
            return 1.0 - smoothstep(0.0, 11.0, w.y - edge);
          }`,
        )
        .replace(
          '#include <map_fragment>',
          /* glsl */ `
          vec2 suv = vWXZ / 10.0;
          vec2 ruv = mat2(0.62, -0.78, 0.78, 0.62) * suv * 0.37 + vec2(3.7, 11.3);
          vec4 sA = texture2D(map, suv);
          vec4 sB = texture2D(map, ruv);
          float mixN = smoothstep(0.3, 0.7, vn(vWXZ * 0.045));
          vec4 sandTex = mix(sA, sB, mixN);
          // 사진 모래의 주황 기운을 빼고 밝은 크림색으로: 채도를 줄이고 전체를 올린다
          float sLum = dot(sandTex.rgb, vec3(0.299, 0.587, 0.114));
          sandTex.rgb = mix(vec3(sLum), sandTex.rgb, 0.6) * 1.6;
          // 넓은 얼룩: 밝은/어두운 모래 지대
          float macro = mix(0.86, 1.1, vn(vWXZ * 0.012 + 3.0));
          sandTex.rgb *= macro * mix(vec3(1.0), vec3(1.05, 0.98, 0.9), vn(vWXZ * 0.03));
          // 바람결 잔물결: 얇은 줄무늬가 명암을 살짝 흔든다
          float rip = sin(vWXZ.x * 0.55 + vn(vWXZ * 0.08) * 9.0 + vWXZ.y * 0.2) * 0.5 + 0.5;
          sandTex.rgb *= mix(0.93, 1.05, rip);
          float wetK = sandWet(vWXZ);
          sandTex.rgb *= mix(1.0, 0.74, wetK) * mix(vec3(1.0), vec3(0.9, 0.96, 0.97), wetK);
          diffuseColor *= sandTex;`,
        )
        .replace(
          '#include <roughnessmap_fragment>',
          /* glsl */ `#include <roughnessmap_fragment>
          roughnessFactor = mix(roughnessFactor, 0.22, sandWet(vWXZ) * 0.85);`,
        );
    };
    return m;
  }, [diff, nor, rough]);

  // 바다: 하늘 반사 + 태양 반짝임 띠 + 잔물결 (수평 방향으로 늘어난 파문)
  const seaMat = useMemo(
    () =>
      new THREE.ShaderMaterial({
        uniforms: {
          ...skyUniforms(1),
          seaFar: { value: new THREE.Color(SEA_FAR) },
          seaMid: { value: new THREE.Color(SEA_MID) },
          seaShore: { value: new THREE.Color(SEA_SHORE) },
          time: { value: 0 },
          sunDir: { value: SUN_DIRECTION.clone().setY(0.045).normalize() },
        },
        vertexShader: /* glsl */ `
          varying vec3 vWP;
          void main() {
            vec4 wp = modelMatrix * vec4(position, 1.0);
            vWP = wp.xyz;
            gl_Position = projectionMatrix * viewMatrix * wp;
          }`,
        fragmentShader: /* glsl */ `
          varying vec3 vWP;
          uniform float time;
          uniform vec3 sunDir;
          uniform vec3 seaFar;
          uniform vec3 seaMid;
          uniform vec3 seaShore;
          ${SKY_GLSL}
          float h21(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7))) * 43758.5453); }
          float vn(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.-2.*f);
            return mix(mix(h21(i),h21(i+vec2(1,0)),f.x), mix(h21(i+vec2(0,1)),h21(i+vec2(1,1)),f.x), f.y); }
          vec2 waveGrad(vec2 p, float t) {
            vec2 g = vec2(0.0);
            // 방향·파장이 다른 사인파 몇 개(기울기만 필요)
            g += vec2( 0.92, 0.38) * cos(dot(p, vec2( 0.92, 0.38)) * 0.55 + t * 0.9) * 0.55;
            g += vec2(-0.55, 0.83) * cos(dot(p, vec2(-0.55, 0.83)) * 0.9  + t * 1.3) * 0.40;
            g += vec2( 0.20, 0.98) * cos(dot(p, vec2( 0.20, 0.98)) * 1.7  + t * 1.9) * 0.28;
            g += vec2(-0.80,-0.60) * cos(dot(p, vec2(-0.80,-0.60)) * 3.1  + t * 2.6) * 0.18;
            float n1 = vn(p * vec2(0.9, 2.4) + vec2(t * 0.25, 0.0));
            float n2 = vn(p * vec2(2.3, 5.5) - vec2(t * 0.4, 0.0));
            g += vec2(n1 - 0.5, n2 - 0.5) * 0.9;
            return g;
          }
          void main() {
            vec3 V = normalize(cameraPosition - vWP);
            float dist = length(cameraPosition - vWP);
            // 멀수록 파문이 가로 줄무늬로 늘어나고(원근), 기울기는 약해진다
            vec2 p = vec2(vWP.x, vWP.z * 0.55);
            vec2 g = waveGrad(p, time) * (0.12 / (1.0 + dist * 0.004));
            vec3 N = normalize(vec3(-g.x, 1.0, -g.y * 1.6));
            vec3 R = reflect(-V, N);
            R.y = abs(R.y);
            vec3 sky = skyColor(R);
            float cosV = clamp(dot(N, V), 0.0, 1.0);
            float fres = 0.03 + 0.97 * pow(1.0 - cosV, 4.0);
            float shore = smoothstep(${(SHORE_Z - 90).toFixed(1)}, ${(SHORE_Z + 2).toFixed(1)}, vWP.z);
            vec3 deep = mix(seaFar, seaMid, shore);
            vec3 col = mix(deep, sky, clamp(fres * 1.15, 0.0, 1.0));
            // 태양 반사 띠: 좁은 하이라이트 + 넓은 번짐, 잔물결로 끊긴다
            float sp = max(dot(R, sunDir), 0.0);
            float sparkle = 0.55 + 0.9 * vn(vWP.xz * vec2(1.6, 4.5) + time * 0.6);
            col = mix(col, seaShore, smoothstep(${(SHORE_Z - 14).toFixed(1)}, ${(SHORE_Z + 1).toFixed(1)}, vWP.z) * 0.6);
            col += vec3(1.0, 0.97, 0.92) * (pow(sp, 900.0) * 3.2 + pow(sp, 160.0) * 1.0 * sparkle + pow(sp, 22.0) * 0.28);
            gl_FragColor = vec4(col, 1.0);
            #include <tonemapping_fragment>
            #include <colorspace_fragment>
          }`,
      }),
    [],
  );
  useFrame((s) => {
    seaMat.uniforms.time!.value = s.clock.elapsedTime;
  });

  // 밀려오는 포말: 물가에서 천천히 오르내린다
  const foamTex = useMemo(() => {
    const c = document.createElement('canvas');
    c.width = 4;
    c.height = 256;
    const g = c.getContext('2d')!;
    const grad = g.createLinearGradient(0, 0, 0, 256);
    for (const [o, col] of [
      [0, 'rgba(255,255,255,0)'],
      [0.35, 'rgba(255,255,255,0.55)'],
      [0.55, 'rgba(255,255,255,0.9)'],
      [0.7, 'rgba(255,255,255,0.3)'],
      [1, 'rgba(255,255,255,0)'],
    ] as const)
      grad.addColorStop(o, col);
    g.fillStyle = grad;
    g.fillRect(0, 0, 4, 256);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }, []);
  const foamRef = useRef<THREE.Mesh>(null);
  const foam2Ref = useRef<THREE.Mesh>(null);
  useFrame((s) => {
    const t = s.clock.elapsedTime;
    const a = (Math.sin(t * 0.55) + 1) / 2;
    if (foamRef.current) {
      foamRef.current.position.z = SHORE_Z - 1.2 + a * 1.6;
      (foamRef.current.material as THREE.MeshBasicMaterial).opacity = 0.5 + 0.35 * (1 - a);
    }
    const b = (Math.sin(t * 0.55 + 2.4) + 1) / 2;
    if (foam2Ref.current) {
      foam2Ref.current.position.z = SHORE_Z - 4.2 + b * 1.4;
      (foam2Ref.current.material as THREE.MeshBasicMaterial).opacity = 0.18 + 0.2 * (1 - b);
    }
  });

  return (
    <group>
      <mesh geometry={sandGeo} material={sandMat} receiveShadow />
      <mesh ref={foamRef} rotation-x={-Math.PI / 2} position={[0, SEA_Y + 0.06, SHORE_Z]} renderOrder={1}>
        <planeGeometry args={[600, 5]} />
        <meshBasicMaterial map={foamTex} transparent depthWrite={false} opacity={0.8} fog={false} />
      </mesh>
      <mesh ref={foam2Ref} rotation-x={-Math.PI / 2} position={[0, SEA_Y + 0.05, SHORE_Z - 4]} renderOrder={1}>
        <planeGeometry args={[600, 3]} />
        <meshBasicMaterial map={foamTex} transparent depthWrite={false} opacity={0.3} fog={false} />
      </mesh>
      <mesh rotation-x={-Math.PI / 2} position={[0, SEA_Y, SHORE_Z - 1200]} material={seaMat}>
        <planeGeometry args={[6000, 2400]} />
      </mesh>
    </group>
  );
}

/** 맑은 낮 태양광, 앞쪽 하늘 보조광 */
function Sun({ quality, center, extent }: { quality: QualityConfig; center: THREE.Vector3; extent: number }) {
  const light = useRef<THREE.DirectionalLight>(null);
  const gl = useThree((s) => s.gl);
  const frames = useRef(0);
  const key = `${center.x.toFixed(1)}|${center.z.toFixed(1)}|${extent.toFixed(1)}|${quality.shadowMapSize}`;
  useEffect(() => {
    // 그림자는 정적으로 굽는다: 배치가 바뀔 때와 시작 직후 몇 프레임만 갱신
    gl.shadowMap.autoUpdate = false;
    frames.current = 0;
  }, [gl, key]);
  useFrame(() => {
    if (frames.current < 40) {
      gl.shadowMap.needsUpdate = true;
      frames.current++;
    }
  });
  const pos = SUN_DIRECTION.clone().multiplyScalar(90);
  return (
    <>
      <directionalLight
        ref={light}
        position={pos}
        intensity={4.0}
        color="#fff3df"
        castShadow
        shadow-mapSize={[quality.shadowMapSize, quality.shadowMapSize]}
        shadow-camera-left={-extent}
        shadow-camera-right={extent}
        shadow-camera-top={extent}
        shadow-camera-bottom={-extent}
        shadow-camera-near={5}
        shadow-camera-far={220}
        shadow-bias={-0.0004}
        shadow-normalBias={0.05}
        shadow-intensity={0.5}
      />
      <directionalLight position={[0, 14, 60]} intensity={0.6} color="#dcefff" />
      <hemisphereLight args={['#cfe8ff', '#f1e4cc', 0.9]} />
    </>
  );
}

function SkyAndEnv() {
  return (
    <>
      <SkyBackdrop />
      <Environment resolution={256} frames={1} environmentIntensity={0.9}>
        <SkyForEnv />
      </Environment>
    </>
  );
}

function SeaAndSand({ bounds }: { bounds: WorldBounds }) {
  useEffect(() => {
    patchSky({ ready: true });
  }, []);
  return <Ground bounds={bounds} />;
}

export function Beach({
  quality,
  center,
  extent,
  bounds,
}: {
  quality: QualityConfig;
  center: THREE.Vector3;
  extent: number;
  bounds: WorldBounds;
}) {
  return (
    <>
      <fog attach="fog" args={[FOG_COLOR, 160, 900]} />
      <Suspense fallback={null}>
        <SkyAndEnv />
        <SeaAndSand bounds={bounds} />
      </Suspense>
      <Sun quality={quality} center={center} extent={extent} />
    </>
  );
}
