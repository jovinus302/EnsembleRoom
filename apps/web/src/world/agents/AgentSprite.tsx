import { useEffect, useMemo } from 'react';
import { useTexture } from '@react-three/drei';
import * as THREE from 'three';

export const BODY_URL = '/assets/characters/body-blue.png';
export const ARM_URL = '/assets/characters/arm-blue.png';
export const LIME_URL = '/assets/characters/body-lime.png';
export const ATLAS_URL = '/assets/characters/lime-yaw-atlas.png';
export const YAW_FRAMES = 47;
const ATLAS_COLS = 8;
const ATLAS_ROWS = 6;

export function useCharacterTextures() {
  const [body, arm, lime, atlas] = useTexture([BODY_URL, ARM_URL, LIME_URL, ATLAS_URL]);
  useMemo(() => {
    for (const t of [body, arm, lime, atlas]) {
      t!.colorSpace = THREE.SRGBColorSpace;
      t!.anisotropy = 4;
      t!.premultiplyAlpha = false;
      t!.needsUpdate = true;
    }
  }, [body, arm, lime, atlas]);
  return { body: body!, arm: arm!, lime: lime!, atlas: atlas! };
}

/** 프레임 번호 -> 아틀라스 UV 오프셋 */
export function atlasFrameUv(frame: number, out: THREE.Vector4): THREE.Vector4 {
  const f = ((Math.round(frame) % YAW_FRAMES) + YAW_FRAMES) % YAW_FRAMES;
  const col = f % ATLAS_COLS;
  const row = Math.floor(f / ATLAS_COLS);
  return out.set(col / ATLAS_COLS, 1 - (row + 1) / ATLAS_ROWS, 1 / ATLAS_COLS, 1 / ATLAS_ROWS);
}

/**
 * 스프라이트 셰이더: 몸통 텍스처 + 소유자 색 틴트 + 탈색 + 밑단 물결 + 림 글로우 + 절차적 얼굴(눈·입).
 * 눈·입은 텍스처가 아니라 셰이더(SDF)로 그려서 시선·깜빡임·입 벌림을 uniform만으로 바꾼다.
 */
export interface SpriteUniforms {
  map: { value: THREE.Texture };
  uFrame: { value: THREE.Vector4 };
  uTint: { value: THREE.Color };
  uTintAmt: { value: number };
  uDesat: { value: number };
  uLight: { value: number };
  uTime: { value: number };
  uWave: { value: number };
  uRim: { value: THREE.Color };
  uRimAmt: { value: number };
  uAlpha: { value: number };
  uFlash: { value: THREE.Color };
  uFlashAmt: { value: number };
  uFaceOn: { value: number };
  uFaceCenter: { value: THREE.Vector2 };
  uFaceScale: { value: number };
  uLook: { value: THREE.Vector2 };
  uBlink: { value: number };
  uMouth: { value: number };
  uSquint: { value: number };
  uWorry: { value: number };
}

const VERT = /* glsl */ `
  uniform float uTime;
  uniform float uWave;
  uniform vec4 uFrame;
  varying vec2 vUv;
  varying vec2 vLocal;
  void main() {
    vLocal = uv;
    vUv = uFrame.xy + uv * uFrame.zw;
    vec3 p = position;
    float k = (1.0 - uv.y);
    p.x += sin(uTime * 3.1 + uv.y * 9.0) * 0.012 * uWave * k * k;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  }
`;

const FRAG = /* glsl */ `
  uniform sampler2D map;
  uniform vec3 uTint; uniform float uTintAmt;
  uniform float uDesat; uniform float uLight; uniform float uTime;
  uniform vec3 uRim; uniform float uRimAmt;
  uniform float uAlpha;
  uniform vec3 uFlash; uniform float uFlashAmt;
  uniform float uFaceOn; uniform vec2 uFaceCenter; uniform float uFaceScale;
  uniform vec2 uLook; uniform float uBlink; uniform float uMouth; uniform float uSquint; uniform float uWorry;
  varying vec2 vUv;
  varying vec2 vLocal;

  float sdEllipse(vec2 p, vec2 r) {
    float k0 = length(p / r);
    float k1 = length(p / (r * r));
    return k0 * (k0 - 1.0) / max(k1, 1e-4);
  }

  void main() {
    vec4 tex = texture2D(map, vUv);
    if (tex.a < 0.04) discard;
    vec3 c = tex.rgb;
    float lum = dot(c, vec3(0.299, 0.587, 0.114));
    // 소유자 색 틴트: 원본의 명암은 유지하고 색상만 소유자 색으로
    vec3 tinted = uTint * (0.42 + lum * 1.05);
    c = mix(c, tinted, uTintAmt);
    c = mix(c, vec3(dot(c, vec3(0.299, 0.587, 0.114))) * vec3(0.9, 0.92, 0.98), uDesat);
    c *= uLight;
    // 림 글로우(가장자리 밝게): 알파 경계 근처
    float edge = 1.0 - smoothstep(0.0, 0.55, tex.a);
    c += uRim * (edge * 0.9 + 0.0) * uRimAmt;
    c = mix(c, uFlash, uFlashAmt);

    // ---- 절차적 얼굴 ----
    if (uFaceOn > 0.001) {
      vec2 q = (vLocal - uFaceCenter) / uFaceScale;
      float ex = 0.34;
      vec2 look = uLook * 0.16;
      float open = mix(1.0, 0.12, uBlink);
      float eyeH = mix(0.5, 0.22, uSquint) * open;
      float eyeW = 0.17;
      vec2 e1 = q - vec2(-ex, 0.0) - look;
      vec2 e2 = q - vec2( ex, 0.0) - look;
      float d1 = sdEllipse(e1, vec2(eyeW, eyeH * 0.5 + 0.012));
      float d2 = sdEllipse(e2, vec2(eyeW, eyeH * 0.5 + 0.012));
      float eyes = (1.0 - smoothstep(-0.02, 0.03, d1)) + (1.0 - smoothstep(-0.02, 0.03, d2));
      // 하이라이트
      vec2 h1 = e1 - vec2(0.05, 0.07); vec2 h2 = e2 - vec2(0.05, 0.07);
      float hi = (1.0 - smoothstep(0.03, 0.06, length(h1))) + (1.0 - smoothstep(0.03, 0.06, length(h2)));
      hi *= open * (1.0 - uSquint * 0.6);
      // 눈썹(걱정)
      float brow = 0.0;
      if (uWorry > 0.01) {
        vec2 b1 = q - vec2(-ex, 0.38) - look * 0.5; b1.y += b1.x * 0.5;
        vec2 b2 = q - vec2( ex, 0.38) - look * 0.5; b2.y -= b2.x * 0.5;
        brow = max(1.0 - smoothstep(0.012, 0.03, abs(b1.y)) , 0.0) * step(abs(b1.x), 0.16)
             + max(1.0 - smoothstep(0.012, 0.03, abs(b2.y)) , 0.0) * step(abs(b2.x), 0.16);
        brow *= uWorry;
      }
      // 입: 닫힘은 곡선(미소), 열리면 타원
      vec2 m = q - vec2(look.x * 0.8, -0.5);
      float mouthOpen = uMouth;
      float mouth;
      if (mouthOpen > 0.06) {
        float d = sdEllipse(m, vec2(0.16 + 0.04 * mouthOpen, 0.04 + 0.2 * mouthOpen));
        mouth = 1.0 - smoothstep(-0.02, 0.03, d);
      } else {
        float curve = m.x * m.x * 1.6 * (1.0 - uWorry * 1.8) - 0.0;
        float d = abs(m.y + curve - 0.04) ;
        mouth = (1.0 - smoothstep(0.018, 0.04, d)) * step(abs(m.x), 0.17);
      }
      float inkA = clamp(eyes + mouth + brow, 0.0, 1.0) * uFaceOn;
      vec3 ink = vec3(0.07, 0.09, 0.16);
      c = mix(c, ink, inkA);
      c = mix(c, vec3(1.0), clamp(hi, 0.0, 1.0) * uFaceOn * 0.95 * step(0.5, eyes));
      // 볼 홍조
      float cheek = (1.0 - smoothstep(0.0, 0.14, length(q - vec2(-0.5, -0.28)))) + (1.0 - smoothstep(0.0, 0.14, length(q - vec2(0.5, -0.28))));
      c = mix(c, vec3(1.0, 0.55, 0.6), cheek * 0.22 * uFaceOn);
    }
    gl_FragColor = vec4(c, tex.a * uAlpha);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

export function createSpriteMaterial(map: THREE.Texture): THREE.ShaderMaterial & { u: SpriteUniforms } {
  const u: SpriteUniforms = {
    map: { value: map },
    uFrame: { value: new THREE.Vector4(0, 0, 1, 1) },
    uTint: { value: new THREE.Color('#ffffff') },
    uTintAmt: { value: 0 },
    uDesat: { value: 0 },
    uLight: { value: 1 },
    uTime: { value: 0 },
    uWave: { value: 1 },
    uRim: { value: new THREE.Color('#ffffff') },
    uRimAmt: { value: 0.3 },
    uAlpha: { value: 1 },
    uFlash: { value: new THREE.Color('#ffffff') },
    uFlashAmt: { value: 0 },
    uFaceOn: { value: 1 },
    uFaceCenter: { value: new THREE.Vector2(0.5, 0.5) },
    uFaceScale: { value: 0.2 },
    uLook: { value: new THREE.Vector2(0, 0) },
    uBlink: { value: 0 },
    uMouth: { value: 0 },
    uSquint: { value: 0 },
    uWorry: { value: 0 },
  };
  const m = new THREE.ShaderMaterial({
    uniforms: u as unknown as Record<string, THREE.IUniform>,
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthWrite: true,
    side: THREE.DoubleSide,
  }) as THREE.ShaderMaterial & { u: SpriteUniforms };
  m.u = u;
  return m;
}

/** 단위 평면(아래 중앙이 원점) */
export function bottomPlane(w: number, h: number, pivotV = 0): THREE.PlaneGeometry {
  const g = new THREE.PlaneGeometry(w, h);
  g.translate(0, h / 2 - pivotV * h, 0);
  return g;
}

/** 팔: 위 중앙이 원점 */
export function topPlane(w: number, h: number): THREE.PlaneGeometry {
  const g = new THREE.PlaneGeometry(w, h);
  g.translate(0, -h / 2, 0);
  return g;
}

export function useDisposable<T extends { dispose(): void }>(factory: () => T, deps: React.DependencyList): T {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const obj = useMemo(factory, deps);
  useEffect(() => () => obj.dispose(), [obj]);
  return obj;
}
