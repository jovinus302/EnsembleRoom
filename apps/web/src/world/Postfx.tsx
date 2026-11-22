import { useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { Bloom, BrightnessContrast, EffectComposer, HueSaturation, N8AO, TiltShift2, ToneMapping, Vignette } from '@react-three/postprocessing';
import { ToneMappingMode } from 'postprocessing';
import type { TiltShiftEffect } from '@react-three/postprocessing';
import type { BloomEffect } from 'postprocessing';
import { fxLevel } from '../fx/fxStore';
import type { QualityConfig } from './quality';
import type { FocusUv } from './CameraRig';

/**
 * 후처리 체인 (계획 8.1): N8AO(high) → Bloom → TiltShift2(초점 띠가 대상을 따라감) → Vignette → Neutral 톤매핑.
 * low 단계에서는 이 컴포넌트를 마운트하지 않고 렌더러 Neutral 톤매핑만 쓴다.
 */
export function Postfx({ quality, focused, focusUv }: { quality: QualityConfig; focused: boolean; focusUv: React.RefObject<FocusUv> }) {
  const tilt = useRef<TiltShiftEffect>(null);
  const bloom = useRef<BloomEffect>(null);
  const bloomScale = useRef(1);
  const cur = useRef({ y: 0.45, blur: 0.2 });
  useFrame((_, dt) => {
    // L1(승인)이 활성이면 블룸을 낮춰 결정이 분위기에 묻히지 않게 한다(8.7)
    const b = bloom.current;
    if (b) {
      bloomScale.current += (fxLevel().bloom - bloomScale.current) * Math.min(1, dt * 5);
      b.intensity = (focused ? 0.12 : 0.3) * bloomScale.current;
    }
    const t = tilt.current;
    if (!t) return;
    const c = cur.current;
    const ty = (focusUv.current?.y ?? 0.45) - (focused ? 0 : 0.12);
    c.y += (ty - c.y) * Math.min(1, dt * 5);
    const targetBlur = focused ? 0.08 : 0.12;
    c.blur += (targetBlur - c.blur) * Math.min(1, dt * 4);
    t.start = [0, c.y];
    t.end = [1, c.y];
    t.blur = c.blur;
    t.taper = focused ? 0.5 : 0.45;
  });
  return (
    <EffectComposer multisampling={quality.msaa} enableNormalPass={false}>
      <>
        {quality.n8ao ? <N8AO aoRadius={2.6} distanceFalloff={1.2} intensity={2.2} quality="medium" halfRes /> : <></>}
        {quality.bloom ? <Bloom ref={bloom} mipmapBlur luminanceThreshold={focused ? 3.2 : 2.4} luminanceSmoothing={0.3} intensity={focused ? 0.12 : 0.3} radius={0.7} /> : <></>}
        {quality.tiltShift ? <TiltShift2 ref={tilt} samples={8} direction={[1, 1]} blur={0.2} taper={0.38} start={[0, 0.45]} end={[1, 0.45]} /> : <></>}
        {quality.vignette ? <Vignette eskil={false} offset={0.28} darkness={0.3} /> : <></>}
        <ToneMapping mode={ToneMappingMode.NEUTRAL} />
        {/* 낮 장면 채도 보정 */}
        <HueSaturation saturation={0.12} />
        <BrightnessContrast contrast={focused ? 0.12 : 0.08} brightness={0} />
      </>
    </EffectComposer>
  );
}
