import * as THREE from 'three';
import { GPUComputationRenderer } from 'three/examples/jsm/misc/GPUComputationRenderer.js';

/**
 * swarm GPGPU 시뮬레이션 (계획 8.6). 위치·속도 텍스처를 GPUComputationRenderer로 갱신하고 Points로 그린다.
 * 입자마다 그룹 슬롯(최대 12)이 있고, 슬롯별 uniform(목표·모드·강도·반경·속도·보조점)이 힘을 정한다.
 * 보이드형 힘: 목표 유도(응집) + 무작위 이웃 샘플링으로 분리·정렬 + curl 노이즈.
 * 비활성 슬롯의 입자는 슬롯 0(내 커서 무리)에 합류한다.
 */

export const GROUPS = 12;
export const SLOT_ME = 0;
export const SLOT_REMOTE = [1, 2] as const;
export const SLOT_AGENT = [3, 4, 5, 6, 7, 8] as const;
export const SLOT_FX = [9, 10, 11] as const;
/** 슬롯별 입자 비중(합이 1이 되도록 정규화) */
const WEIGHTS = [0.2, 0.08, 0.08, 0.06, 0.06, 0.06, 0.06, 0.06, 0.06, 0.07, 0.07, 0.07];

export const MODE = { orbit: 0, cohere: 1, vortex: 2, flow: 3, condense: 4, scatter: 5, settle: 6, ring: 7 } as const;
export type SwarmMode = keyof typeof MODE;

export interface SwarmUniforms {
  uDt: { value: number };
  uTime: { value: number };
  uTarget: { value: THREE.Vector3[] };
  /** x=mode, y=strength, z=radius, w=speed */
  uParam: { value: THREE.Vector4[] };
  uAux: { value: THREE.Vector3[] };
  uActive: { value: number[] };
}

const COMMON = /* glsl */ `
#define G ${GROUPS}
uniform float uDt;
uniform float uTime;
uniform vec3 uTarget[G];
uniform vec4 uParam[G];
uniform vec3 uAux[G];
uniform float uActive[G];
float hash12(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }
vec3 curl(vec3 p){
  return vec3(
    sin(p.y * 1.7 + p.z * 1.1) + cos(p.z * 2.3 - p.y * 0.7),
    sin(p.z * 1.9 + p.x * 1.3) + cos(p.x * 2.1 - p.z * 0.9),
    sin(p.x * 1.5 + p.y * 1.2) + cos(p.y * 2.7 - p.x * 1.1));
}
`;

const VEL_FRAG = /* glsl */ `
${COMMON}
void main(){
  vec2 uv = gl_FragCoord.xy / resolution.xy;
  vec4 pp = texture2D(texturePosition, uv);
  vec4 vv = texture2D(textureVelocity, uv);
  vec3 p = pp.xyz;
  vec3 v = vv.xyz;
  float seed = vv.w;
  int g = int(pp.w + 0.5);
  if (uActive[g] < 0.5) g = 0;
  vec3 T = uTarget[g];
  vec4 P = uParam[g];
  vec3 A = uAux[g];
  int mode = int(P.x + 0.5);
  float str = P.y;
  float rad = P.z;
  float spd = P.w;
  float ph = seed * 6.2831853;
  vec3 n = curl(p * 0.3 + vec3(0.0, uTime * 0.25, 0.0));
  vec3 dir = normalize(vec3(hash12(uv) - 0.5, hash12(uv + 1.3) - 0.5, hash12(uv + 2.7) - 0.5) + 1e-4);
  // 구 안에 거의 균일하게 퍼지도록(중심에 몰려 덩어리가 되지 않게) 반경 분포를 부풀린다
  float rr = 0.12 + 0.88 * pow(fract(seed * 13.7), 0.38);
  vec3 want = p;
  float k = 0.0;
  float c = 2.5;
  float noise = 2.0;
  vec3 extra = vec3(0.0);

  if (mode == 0) {            // orbit: 타원 궤도(A=반경)
    float a = ph + uTime * spd * (0.55 + 0.9 * fract(seed * 7.31));
    want = T + vec3(cos(a) * A.x, sin(a * 1.3 + ph) * A.y * (0.4 + rr), sin(a) * A.z) * (0.62 + 0.55 * rr);
    k = 7.5; c = 3.0; noise = 3.2;
  } else if (mode == 1) {     // cohere: 목표 주변 구름(반경 rad)으로 응집
    // 느슨하게 선회: 입자마다 다른 각속도로 목표 둘레를 돌고, 스프링 강도도 제각각이라 이동 시 꼬리가 길게 늘어진다
    float sa = uTime * (0.35 + 0.9 * fract(seed * 5.1)) + ph;
    vec3 off = dir * rad * rr;
    off = vec3(off.x * cos(sa) - off.z * sin(sa), off.y * 0.7, off.x * sin(sa) + off.z * cos(sa));
    want = T + off + vec3(sin(uTime * 1.7 + ph), cos(uTime * 1.3 + ph * 1.7), sin(uTime * 1.1 + ph * 0.6)) * rad * 0.12;
    // 모래에 깔리지 않게 지면에서 띄운다: 입자마다 다른 높이(0.6~)로 부유하며 위아래로 일렁인다
    float lift = 0.6 + 1.1 * fract(seed * 9.13) + 0.3 * sin(uTime * (0.9 + fract(seed * 4.3)) + ph);
    want.y = max(want.y, lift);
    k = 7.0 * (0.4 + 1.2 * fract(seed * 3.7)); c = 2.4; noise = 4.0;
  } else if (mode == 2) {     // vortex: 위로 말려 올라가는 소용돌이(A.y=높이)
    float h = fract(seed * 3.1 + uTime * spd * 0.5);
    float a = ph + uTime * spd * 2.4 + h * 5.0;
    float r = rad * (1.0 - 0.55 * h);
    want = T + vec3(cos(a) * r, h * A.y, sin(a) * r);
    k = 9.0; c = 3.2; noise = 1.0;
  } else if (mode == 3) {     // flow: A(출발)에서 T(도착)로 띠처럼 흐른다
    float u = fract(seed * 5.7 + uTime * spd * 0.35);
    vec3 side = normalize(cross(T - A, vec3(0.0, 1.0, 0.0)) + 1e-4);
    want = mix(A, T, u) + side * (hash12(uv + 4.1) - 0.5) * rad + vec3(0.0, sin(u * 3.14159) * rad * 0.9 + (hash12(uv + 5.2) - 0.5) * rad * 0.5, 0.0);
    k = 11.0; c = 3.4; noise = 2.5;
  } else if (mode == 4) {     // condense: 단단히 응결
    want = T + dir * rad * (0.25 + 0.5 * rr);
    k = 15.0; c = 4.0; noise = 2.5;
  } else if (mode == 5) {     // scatter: 바깥으로 터진다
    vec3 o = p - T + dir * 0.25;
    extra = normalize(o) * spd * str + vec3(0.0, 2.5, 0.0);
    k = 0.0; c = 1.4; noise = 3.0;
  } else if (mode == 7) {     // ring: 지면 가까이 깔리는 얇은 고리(A=반경 x/z, A.y=높이 폭). 안쪽으로 파고들지 않는다
    float a = ph + uTime * spd * (0.55 + 0.9 * fract(seed * 7.31));
    want = T + vec3(cos(a) * A.x, sin(a * 1.3 + ph) * A.y, sin(a) * A.z) * (0.94 + 0.12 * rr);
    k = 7.5; c = 3.0; noise = 2.0;
  } else {                    // settle: 가라앉는다
    want = vec3(p.x, 0.15, p.z);
    k = 2.5; c = 2.2; noise = 0.8;
  }

  vec3 acc = (want - p) * k * str - v * c + n * noise + extra * 2.0;

  // 보이드: 무작위 이웃 3개로 분리·정렬
  for (int i = 0; i < 3; i++) {
    vec2 nuv = vec2(hash12(uv * float(i + 1) + uTime), hash12(uv.yx + float(i) * 7.3 - uTime));
    vec4 np = texture2D(texturePosition, nuv);
    if (int(np.w + 0.5) == int(pp.w + 0.5)) {
      vec3 d = p - np.xyz;
      float dist = length(d) + 1e-3;
      if (dist < 1.1) acc += d / dist * (1.1 - dist) * 20.0;
      else if (dist < 4.0) acc += (texture2D(textureVelocity, nuv).xyz - v) * 0.9;
    }
  }

  v += acc * uDt;
  float sp = length(v);
  float maxSp = mode == 5 ? 45.0 : 55.0;
  if (sp > maxSp) v *= maxSp / sp;
  gl_FragColor = vec4(v, seed);
}
`;

const POS_FRAG = /* glsl */ `
uniform float uDt;
uniform vec3 uTarget[${GROUPS}];
void main(){
  vec2 uv = gl_FragCoord.xy / resolution.xy;
  vec4 pp = texture2D(texturePosition, uv);
  vec4 vv = texture2D(textureVelocity, uv);
  vec3 p = pp.xyz + vv.xyz * uDt;
  if (p.y < 0.3) { p.y = 0.3; }
  if (!(abs(p.x) < 900.0 && abs(p.y) < 300.0 && abs(p.z) < 900.0)) p = uTarget[0];
  gl_FragColor = vec4(p, pp.w);
}
`;

const POINT_VERT = /* glsl */ `
#define G ${GROUPS}
uniform sampler2D tPos;
uniform sampler2D tVel;
uniform float uSize;
uniform float uSizeMul;
uniform float uAlphaMul;
uniform float uPx;
uniform float uAspect;
uniform float uTime;
uniform vec3 uColor[G];
uniform float uAlpha[G];
uniform float uActive[G];
uniform float uDensity[G];
attribute vec2 aRef;
attribute float aRnd;
varying vec3 vCol;
varying float vA;
varying vec2 vDir;
varying float vStretch;
void main(){
  vec4 pp = texture2D(tPos, aRef);
  vec3 vel = texture2D(tVel, aRef).xyz;
  int g = int(pp.w + 0.5);
  // 비활성 슬롯의 입자는 그리지 않는다(내 커서 무리로 몰려 덩어리가 되지 않게)
  // 비활성 슬롯, 또는 밀도 상한을 넘는 입자는 그리지 않는다(촘촘한 무리가 흰 덩어리로 뭉치지 않게)
  if (uActive[g] < 0.5 || aRnd > uDensity[g]) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    gl_PointSize = 0.0;
    vA = 0.0; vCol = vec3(0.0); vDir = vec2(1.0, 0.0); vStretch = 0.0;
    return;
  }
  vec3 wp = pp.xyz;
  #ifdef SHADOW
  float hAbove = max(wp.y - 0.1, 0.0);
  wp.y = 0.12;
  #endif
  vec4 mv = modelViewMatrix * vec4(wp, 1.0);
  vec4 c0 = projectionMatrix * mv;
  gl_Position = c0;
  vec4 c1 = projectionMatrix * (modelViewMatrix * vec4(pp.xyz + vel * 0.06, 1.0));
  vec2 sd = (c1.xy / max(c1.w, 0.001) - c0.xy / max(c0.w, 0.001)) * vec2(uAspect, 1.0);
  float sl = length(sd);
  // 속도 방향(화면 기준)과 늘어난 정도. gl_PointCoord는 y가 아래로 향한다
  vDir = sl > 1e-5 ? vec2(sd.x, -sd.y) / sl : vec2(1.0, 0.0);
  float speed = length(vel);
  vStretch = clamp(speed * 0.16, 0.0, 3.2) * step(1e-5, sl);
  float tw = 0.8 + 0.2 * sin(uTime * 3.0 + aRnd * 40.0);
  float base = max(1.6, uSize * uSizeMul * (0.6 + aRnd * 0.8) * uPx / max(-mv.z, 0.1));
  gl_PointSize = base * (1.0 + vStretch);
  // 모래색과 분리되도록 채도·밝기를 올린다(채널 상한 1.45로 눌러 흰색으로 타지 않게)
  vec3 cc = uColor[g];
  float lum = dot(cc, vec3(0.299, 0.587, 0.114));
  cc = clamp(mix(vec3(lum), cc, 1.9) * 1.3, 0.0, 1.45);
  vCol = cc;
  vA = uAlpha[g] * tw * uAlphaMul;
  #ifdef SHADOW
  // 높이 올라갈수록 그림자는 옅고 커진다
  gl_PointSize *= 1.0 + hAbove * 0.12;
  vA *= 0.5 / (1.0 + hAbove * 0.45);
  vStretch = 0.0;
  #endif
}
`;

const POINT_FRAG = /* glsl */ `
varying vec3 vCol;
varying float vA;
varying vec2 vDir;
varying float vStretch;
void main(){
  vec2 q = (gl_PointCoord - 0.5) * 2.0;
  #ifdef SHADOW
  float sd = length(q);
  if (sd > 1.0) discard;
  gl_FragColor = vec4(0.1, 0.045, 0.03, (1.0 - sd) * (1.0 - sd) * vA);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  return;
  #endif
  float al = dot(q, vDir);
  float pe = dot(q, vec2(-vDir.y, vDir.x)) * (1.0 + vStretch);
  float d = sqrt(al * al + pe * pe);
  if (d > 1.0) discard;
  float a = 1.0 - smoothstep(0.35, 1.0, d);
  // 머리(진행 방향)는 또렷하고 꼬리는 옅어진다
  a *= mix(0.45, 1.0, smoothstep(-1.0, 0.8, al));
  vec3 core = mix(vCol, vec3(1.0), 0.2);
  vec3 col = mix(vCol * 0.82, core, 1.0 - smoothstep(0.0, 0.8, d));
  gl_FragColor = vec4(col, a * vA);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export interface GroupCmd {
  active: boolean;
  mode: SwarmMode;
  strength: number;
  radius: number;
  speed: number;
  target: THREE.Vector3;
  aux: THREE.Vector3;
  color: THREE.Color;
  alpha: number;
}

export class SwarmSim {
  readonly size: number;
  readonly count: number;
  readonly uniforms!: SwarmUniforms;
  readonly colors: THREE.Color[];
  readonly alphas: number[];
  /** 슬롯별 그리는 입자 비율(0..1). 입자 수가 많은 단계에서 한 군집이 포화되지 않도록 슬롯당 그리는 수에 상한을 둔다 */
  readonly density: number[];
  private baseDensity: number[] = [];
  readonly points: THREE.Group;
  private gpu: GPUComputationRenderer;
  private posVar: ReturnType<GPUComputationRenderer['addVariable']>;
  private velVar: ReturnType<GPUComputationRenderer['addVariable']>;
  private mat: THREE.ShaderMaterial;
  private shadowMat: THREE.ShaderMaterial;
  private geo: THREE.BufferGeometry;
  readonly dataType: 'float' | 'half';

  constructor(renderer: THREE.WebGLRenderer, size: number, spawn: THREE.Vector3) {
    this.size = size;
    this.count = size * size;
    let lastErr: string | null = 'unsupported';
    let gpu!: GPUComputationRenderer;
    let posVar!: SwarmSim['posVar'];
    let velVar!: SwarmSim['velVar'];
    let type: 'float' | 'half' = 'float';
    for (const t of ['float', 'half'] as const) {
      gpu = new GPUComputationRenderer(size, size, renderer);
      gpu.setDataType(t === 'float' ? THREE.FloatType : THREE.HalfFloatType);
      const posTex = gpu.createTexture();
      const velTex = gpu.createTexture();
      this.fillTextures(posTex, velTex, spawn);
      posVar = gpu.addVariable('texturePosition', POS_FRAG, posTex);
      velVar = gpu.addVariable('textureVelocity', VEL_FRAG, velTex);
      gpu.setVariableDependencies(posVar, [posVar, velVar]);
      gpu.setVariableDependencies(velVar, [posVar, velVar]);
      this.uniforms = this.makeUniforms();
      for (const v of [posVar, velVar]) Object.assign(v.material.uniforms, this.uniforms);
      lastErr = gpu.init();
      if (!lastErr) {
        type = t;
        break;
      }
      gpu.dispose();
    }
    if (lastErr) throw new Error(`swarm GPGPU 초기화 실패: ${lastErr}`);
    this.dataType = type;
    this.gpu = gpu;
    this.posVar = posVar;
    this.velVar = velVar;
    this.colors = Array.from({ length: GROUPS }, () => new THREE.Color('#ffffff'));
    this.alphas = new Array(GROUPS).fill(0.8);
    const wsum = WEIGHTS.reduce((a, b) => a + b, 0);
    this.density = WEIGHTS.map((w, i) => Math.min(1, (i === 0 ? 400 : 260) / Math.max(1, (this.count * w) / wsum)));

    this.baseDensity = [...this.density];
    const refs = new Float32Array(this.count * 2);
    const rnd = new Float32Array(this.count);
    for (let i = 0; i < this.count; i++) {
      refs[i * 2] = ((i % size) + 0.5) / size;
      refs[i * 2 + 1] = (Math.floor(i / size) + 0.5) / size;
      rnd[i] = Math.random();
    }
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.count * 3), 3));
    this.geo.setAttribute('aRef', new THREE.BufferAttribute(refs, 2));
    this.geo.setAttribute('aRnd', new THREE.BufferAttribute(rnd, 1));
    // 일반 합성만 쓴다: 가산 후광은 수천 입자가 겹치며 HDR로 포화돼 흰 덩어리로 타고 블룸까지 불러서 제거했다.
    // 소유자 색이 밀집해도 그대로 읽힌다(알파는 입자 수에 맞춰 낮춘다).
    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        tPos: { value: null },
        tVel: { value: null },
        uSize: { value: 0.34 },
        uSizeMul: { value: 1 },
        uAlphaMul: { value: 0.6 },
        uPx: { value: 800 },
        uAspect: { value: 1.6 },
        uTime: this.uniforms.uTime,
        uColor: { value: this.colors },
        uAlpha: { value: this.alphas },
        uActive: this.uniforms.uActive,
        uDensity: { value: this.density },
      },
      vertexShader: POINT_VERT,
      fragmentShader: POINT_FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.NormalBlending,
    });
    // 지면 그림자: 같은 입자를 지면에 투영해 어둡고 작게 그린다(떠 있는 높이가 읽힌다)
    this.shadowMat = new THREE.ShaderMaterial({
      uniforms: this.mat.uniforms,
      vertexShader: POINT_VERT,
      fragmentShader: POINT_FRAG,
      defines: { SHADOW: 1 },
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.NormalBlending,
    });
    this.points = new THREE.Group();
    const shadow = new THREE.Points(this.geo, this.shadowMat);
    shadow.frustumCulled = false;
    shadow.renderOrder = 29;
    this.points.add(shadow);
    const pts = new THREE.Points(this.geo, this.mat);
    pts.frustumCulled = false;
    pts.renderOrder = 30;
    this.points.add(pts);
  }

  private makeUniforms(): SwarmUniforms {
    return {
      uDt: { value: 0.016 },
      uTime: { value: 0 },
      uTarget: { value: Array.from({ length: GROUPS }, () => new THREE.Vector3()) },
      uParam: { value: Array.from({ length: GROUPS }, () => new THREE.Vector4(MODE.cohere, 1, 2, 1)) },
      uAux: { value: Array.from({ length: GROUPS }, () => new THREE.Vector3()) },
      uActive: { value: new Array(GROUPS).fill(0).map((_, i) => (i === 0 ? 1 : 0)) },
    };
  }

  private fillTextures(pos: THREE.DataTexture, vel: THREE.DataTexture, spawn: THREE.Vector3): void {
    const total = WEIGHTS.reduce((a, b) => a + b, 0);
    const bounds: number[] = [];
    let acc = 0;
    for (const w of WEIGHTS) {
      acc += w / total;
      bounds.push(acc);
    }
    const pd = pos.image.data as unknown as Float32Array;
    const vd = vel.image.data as unknown as Float32Array;
    const n = this.count;
    for (let i = 0; i < n; i++) {
      const f = (i + 0.5) / n;
      // 그룹은 입자 인덱스를 섞어서 배정한다(정렬된 인덱스가 텍스처 한 구역에 몰리지 않게)
      const fm = (f * 7919.0) % 1;
      let g = 0;
      while (g < GROUPS - 1 && fm > bounds[g]!) g++;
      pd[i * 4] = spawn.x + (Math.random() - 0.5) * 8;
      pd[i * 4 + 1] = 0.5 + Math.random() * 3;
      pd[i * 4 + 2] = spawn.z + (Math.random() - 0.5) * 8;
      pd[i * 4 + 3] = g;
      vd[i * 4] = vd[i * 4 + 1] = vd[i * 4 + 2] = 0;
      vd[i * 4 + 3] = Math.random();
    }
  }

  setGroup(i: number, c: GroupCmd): void {
    const u = this.uniforms;
    u.uActive.value[i] = c.active ? 1 : 0;
    u.uTarget.value[i]!.copy(c.target);
    u.uParam.value[i]!.set(MODE[c.mode], c.strength, c.radius, c.speed);
    u.uAux.value[i]!.copy(c.aux);
    this.alphas[i] = c.alpha;
  }

  step(dt: number, time: number, viewportPx: number, aspect = 1.6): void {
    this.uniforms.uDt.value = Math.min(dt, 0.05);
    this.uniforms.uTime.value = time;
    this.gpu.compute();
    const m = this.mat;
    m.uniforms.tPos!.value = this.gpu.getCurrentRenderTarget(this.posVar).texture;
    m.uniforms.tVel!.value = this.gpu.getCurrentRenderTarget(this.velVar).texture;
    m.uniforms.uPx!.value = viewportPx;
    m.uniforms.uAspect!.value = aspect;
  }

  /** 카메라가 가까운 Room 포커스에서는 그리는 입자 수를 줄인다(k<1). 같은 월드 크기가 화면에서 몇 배로 커지기 때문 */
  setDensityScale(k: number): void {
    for (let i = 0; i < this.density.length; i++) this.density[i] = this.baseDensity[i]! * k;
  }

  setPointSize(s: number): void {
    this.mat.uniforms.uSize!.value = s;
  }

  dispose(): void {
    this.gpu.dispose();
    this.geo.dispose();
    this.mat.dispose();
    this.shadowMat.dispose();
  }
}
