import { createContext, useContext, useEffect, useMemo, useRef, type ReactNode } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { MeshTransmissionMaterial, useFBO } from '@react-three/drei';
import * as THREE from 'three';
import { SUN_DIRECTION } from '../sky';

/**
 * 유리 렌더 (계획 8.6).
 *  - 투과 유리: drei MeshTransmissionMaterial 여러 개가 **하나의 공유 버퍼**를 쓴다. 버퍼는 프레임당 한 번,
 *    투과 유리 메시를 숨기고 씬을 FBO로 그려 만든다(`GlassBufferProvider`).
 *  - 가짜 유리: MeshPhysicalMaterial(transparent) + env 반사 + 프레넬 림. 서리(frost)는 이쪽의 불투명도/거칠기로 낸다.
 */

interface GlassBufferApi {
  texture: THREE.Texture;
  register: (m: THREE.Object3D) => () => void;
}
const GlassBufferContext = createContext<GlassBufferApi | null>(null);

export function GlassBufferProvider({
  enabled,
  resolution,
  msaa = 0,
  children,
}: {
  enabled: boolean;
  /** 버퍼 높이(px). 너비는 화면 비율로 정해진다 */
  resolution: number;
  msaa?: number;
  children: ReactNode;
}) {
  const viewport = useThree((s) => s.size);
  const h = enabled ? resolution : 4;
  // 화면 비율에 맞춰 만든다(굴절 샘플링이 화면 UV 기준이라 해상도가 낮아도 덜 뭉개진다)
  const w = enabled ? Math.round((resolution * viewport.width) / Math.max(viewport.height, 1)) : 4;
  const fbo = useFBO(w, h, { type: THREE.HalfFloatType, samples: msaa });
  const meshes = useRef(new Set<THREE.Object3D>()).current;
  const gl = useThree((s) => s.gl);

  useFrame((state) => {
    if (!enabled || meshes.size === 0) return;
    const prevVisible: [THREE.Object3D, boolean][] = [];
    meshes.forEach((m) => {
      prevVisible.push([m, m.visible]);
      m.visible = false;
    });
    const prevTone = gl.toneMapping;
    const prevTarget = gl.getRenderTarget();
    const prevShadowAuto = gl.shadowMap.autoUpdate;
    gl.toneMapping = THREE.NoToneMapping;
    gl.shadowMap.autoUpdate = false;
    gl.setRenderTarget(fbo);
    gl.clear();
    gl.render(state.scene, state.camera);
    gl.setRenderTarget(prevTarget);
    gl.toneMapping = prevTone;
    gl.shadowMap.autoUpdate = prevShadowAuto;
    for (const [m, v] of prevVisible) m.visible = v;
  }, -1);

  const api = useMemo<GlassBufferApi>(
    () => ({
      texture: fbo.texture,
      register: (m) => {
        meshes.add(m);
        return () => {
          meshes.delete(m);
        };
      },
    }),
    [fbo, meshes],
  );
  return <GlassBufferContext.Provider value={api}>{children}</GlassBufferContext.Provider>;
}

/** 투과(굴절) 유리 메시. 공유 버퍼가 켜져 있을 때만 쓴다. `visibleRef`는 서리 정도에 따라 부모가 끈다 */
export function TransmissiveGlass({
  geometry,
  samples,
  tint,
}: {
  geometry: THREE.BufferGeometry;
  samples: number;
  tint: THREE.ColorRepresentation;
}) {
  const api = useContext(GlassBufferContext);
  const ref = useRef<THREE.Mesh>(null);
  useEffect(() => {
    const m = ref.current;
    if (!m || !api) return;
    return api.register(m);
  }, [api]);
  if (!api) return null;
  return (
    <mesh ref={ref} geometry={geometry} renderOrder={5} userData={{ glassLayer: 'transmission' }}>
      <MeshTransmissionMaterial
        buffer={api.texture}
        resolution={2}
        backsideResolution={2}
        samples={samples}
        transmission={1}
        thickness={0.55}
        ior={1.18}
        roughness={0.02}
        chromaticAberration={0.05}
        anisotropicBlur={0.05}
        distortion={0.06}
        distortionScale={0.4}
        temporalDistortion={0.0}
        attenuationColor={tint}
        attenuationDistance={12}
        envMapIntensity={1.2}
        backside={false}
      />
    </mesh>
  );
}

export interface ShellUniforms {
  rimColor: { value: THREE.Color };
  rimStrength: { value: number };
  /** 석양 역광 림·반사 줄기 세기(맑은 유리 1, 서리 0에 가깝게) */
  glint: { value: number };
  /** 서리 전환 와이프: x=띠의 위치(0..1, 캡슐 길이 방향), y=세기, z=캡슐 반길이(로컬) */
  wipe: { value: THREE.Vector3 };
}

/** 가짜 유리 재질. 앞면/뒷면 두 장을 쓴다. 림 색·세기는 uniforms로 바꾼다 */
export function createShellMaterial(side: THREE.Side): THREE.MeshPhysicalMaterial & { shell: ShellUniforms } {
  const shell: ShellUniforms = { rimColor: { value: new THREE.Color('#ffffff') }, rimStrength: { value: 1 }, glint: { value: 1 }, wipe: { value: new THREE.Vector3(0, 0, 1) } };
  const sunDir = SUN_DIRECTION.clone().normalize();
  const mat = new THREE.MeshPhysicalMaterial({
    color: '#ffffff',
    transparent: true,
    opacity: 0.1,
    roughness: 0.04,
    metalness: 0,
    ior: 1.5,
    clearcoat: 1,
    clearcoatRoughness: 0.03,
    envMapIntensity: 0.85,
    side,
    depthWrite: false,
  }) as THREE.MeshPhysicalMaterial & { shell: ShellUniforms };
  mat.shell = shell;
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.rimColor = shell.rimColor;
    sh.uniforms.rimStrength = shell.rimStrength;
    sh.uniforms.glint = shell.glint;
    sh.uniforms.wipe = shell.wipe;
    sh.uniforms.sunDirW = { value: sunDir };
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying float vLx;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvLx = position.x;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec3 rimColor;\nuniform float rimStrength;\nuniform float glint;\nuniform vec3 sunDirW;\nuniform vec3 wipe;\nvarying float vLx;')
      .replace(
        '#include <opaque_fragment>',
        /* glsl */ `
        // 거울 반사가 태양과 정렬되면 HDR 값이 half-float 한계를 넘어 블룸이 화면을 검게 번지게 한다: 상한을 둔다
        totalSpecular = min(totalSpecular, vec3(6.0));
        vec3 Nv = normalize(vNormal);
        vec3 Vv = normalize(vViewPosition);
        float ndv = clamp(abs(dot(Nv, Vv)), 0.0, 1.0);
        float rimF = pow(1.0 - ndv, 2.2);
        outgoingLight += rimColor * rimF * rimStrength;
        // 두께감: 가장자리에서 가늘고 밝은 선(굴절로 휘는 테두리)
        float edge = pow(1.0 - ndv, 5.0);
        outgoingLight += mix(rimColor, vec3(1.0), 0.55) * edge * rimStrength * 0.75;
        // 석양 역광: 해가 있는 쪽 가장자리가 따뜻하게 빛나고, 반사 줄기가 지나간다
        vec3 sunV = normalize((viewMatrix * vec4(sunDirW, 0.0)).xyz);
        float sunSide = clamp(dot(normalize(Nv.xy + vec2(1e-4)), normalize(sunV.xy + vec2(1e-4))) * 0.5 + 0.5, 0.0, 1.0);
        outgoingLight += vec3(1.0, 0.66, 0.34) * pow(1.0 - ndv, 3.0) * (0.15 + 1.5 * sunSide * sunSide) * glint * 0.9;
        vec3 Rv = reflect(-Vv, Nv);
        outgoingLight += vec3(1.0, 0.82, 0.58) * pow(max(dot(Rv, sunV), 0.0), 70.0) * 1.6 * glint;
        // 창문이 비친 듯한 옅은 세로 반사 띠(돔 곡면 위)
        float streak = smoothstep(0.07, 0.0, abs(Nv.x * 0.9 - Nv.y * 0.32 + 0.38)) * smoothstep(-0.1, 0.45, Nv.y) * (1.0 - ndv * 0.5);
        outgoingLight += vec3(1.0, 0.95, 0.9) * streak * 0.2 * glint;
        outgoingLight = clamp(outgoingLight, vec3(0.0), vec3(8.0));
        // 서리 와이프: 유리를 따라 지나가는 밝은 띠(서리→맑음/맑음→서리 전환이 눈에 보이게)
        float wx = vLx / max(wipe.z, 0.001) * 0.5 + 0.5;
        float wband = exp(-pow((wx - wipe.x) * 6.0, 2.0)) * wipe.y;
        outgoingLight += vec3(1.0, 0.93, 0.8) * wband * 2.4;
        // 반사(스페큘러)가 불투명도에 눌리지 않도록 알파를 보정한다
        diffuseColor.a = clamp(diffuseColor.a + dot(totalSpecular, vec3(0.3333)) + (rimF * 0.16 + edge * 0.5 + streak * 0.3) * rimStrength + pow(max(dot(Rv, sunV), 0.0), 70.0) * glint + wband * 0.75, 0.0, 1.0);
        #include <opaque_fragment>`,
      );
  };
  return mat;
}

/** 'agent 시야' 유리의 서리 정도(0 맑음 ~ 1 서리). 안이 읽히되 사람 방문(0)과 한눈에 달라야 한다 */
export const AGENT_FROST = 0.58;
/** 유리 상태 → 서리 목표값 */
export function frostOf(glass: 'clear' | 'frosted' | 'agent'): number {
  return glass === 'frosted' ? 1 : glass === 'agent' ? AGENT_FROST : 0;
}

const WHITE = new THREE.Color('#ffffff');
const tmp = new THREE.Color();

/** frost 0(맑음)~1(서리)에 따라 가짜 유리 재질을 갱신한다 */
export function applyFrost(
  mat: THREE.MeshPhysicalMaterial & { shell: ShellUniforms },
  frost: number,
  tint: THREE.Color,
  hover: number,
  back: boolean,
  hasTransmission: boolean,
) {
  const f = frost;
  tmp.copy(WHITE).lerp(tint, 0.1 + 0.3 * f);
  mat.color.copy(tmp);
  const clearOpacity = hasTransmission ? 0.015 : 0.03;
  mat.opacity = THREE.MathUtils.lerp(clearOpacity, back ? 0.5 : 0.86, f);
  mat.shell.glint.value = 1 - 0.85 * f;
  mat.roughness = THREE.MathUtils.lerp(0.04, 0.95, f);
  mat.clearcoat = THREE.MathUtils.lerp(0.4, 0.25, f);
  mat.shell.rimColor.value.copy(tint).lerp(WHITE, 0.25);
  mat.shell.rimStrength.value = (back ? 0.4 : 1.0) * (1 + hover * 0.9) * (1 - 0.45 * f);
}
