import { create } from 'zustand';

/** 품질 단계 (계획 8.6 표). `?q=high|mid|low`로 강제하고, 강제하지 않으면 PerformanceMonitor가 자동 조정한다. */
export type QualityTier = 'high' | 'mid' | 'low';
export const QUALITY_TIERS: readonly QualityTier[] = ['low', 'mid', 'high'];

export interface QualityConfig {
  dpr: [number, number];
  /** 투과(공유 버퍼) 유리를 쓰는 캡슐 수. 0이면 전부 가짜 유리 */
  transmissionSlots: number;
  transmissionResolution: number;
  transmissionMsaa: number;
  transmissionSamples: number;
  /** 후처리 체인 사용 여부 (false면 렌더러 AGX 톤매핑만) */
  postfx: boolean;
  bloom: boolean;
  tiltShift: boolean;
  vignette: boolean;
  n8ao: boolean;
  msaa: number;
  /** 월드 전체 실내 PointLight 예산 (나머지 전구는 emissive + 글로우 스프라이트) */
  pointLights: number;
  shadowMapSize: number;
  /** 입자 수 (S19 swarm이 사용) */
  particles: number;
}

export const QUALITY: Readonly<Record<QualityTier, QualityConfig>> = {
  high: {
    dpr: [1, 2],
    transmissionSlots: 3,
    transmissionMsaa: 4,
    transmissionResolution: 1024,
    transmissionSamples: 6,
    postfx: true,
    bloom: true,
    tiltShift: true,
    vignette: true,
    n8ao: true,
    msaa: 4,
    pointLights: 4,
    shadowMapSize: 2048,
    particles: 65536,
  },
  mid: {
    dpr: [1, 1.5],
    transmissionSlots: 1,
    transmissionMsaa: 0,
    transmissionResolution: 640,
    transmissionSamples: 3,
    postfx: true,
    bloom: true,
    tiltShift: true,
    vignette: false,
    n8ao: false,
    msaa: 0,
    pointLights: 2,
    shadowMapSize: 1024,
    particles: 16384,
  },
  low: {
    dpr: [1, 1],
    transmissionSlots: 0,
    transmissionMsaa: 0,
    transmissionResolution: 128,
    transmissionSamples: 1,
    postfx: false,
    bloom: false,
    tiltShift: false,
    vignette: false,
    n8ao: false,
    msaa: 0,
    pointLights: 0,
    shadowMapSize: 512,
    particles: 4096,
  },
};

/** URL의 `?q=` 강제값. 없거나 잘못되면 null */
export function forcedQualityFromUrl(): QualityTier | null {
  if (typeof location === 'undefined') return null;
  const q = new URLSearchParams(location.search).get('q');
  return q === 'high' || q === 'mid' || q === 'low' ? q : null;
}

export function tierUp(t: QualityTier): QualityTier {
  return t === 'low' ? 'mid' : 'high';
}
export function tierDown(t: QualityTier): QualityTier {
  return t === 'high' ? 'mid' : 'low';
}

/** fps HUD용 측정값. WorldCanvas 안의 FpsProbe가 쓰고, DOM HUD가 읽는다 */
interface PerfState {
  fps: number;
  frameMs: number;
  tier: QualityTier;
  set: (p: Partial<Pick<PerfState, 'fps' | 'frameMs' | 'tier'>>) => void;
}
export const usePerf = create<PerfState>((set) => ({
  fps: 0,
  frameMs: 0,
  tier: 'mid',
  set: (p) => set(p),
}));
