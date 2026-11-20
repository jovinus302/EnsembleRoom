import { Text } from '@react-three/drei';
import type { ComponentProps } from 'react';

/** 월드에서 쓰는 로컬 폰트(KS X 1001 한글 + ASCII 서브셋). CDN 폰트를 쓰지 않는다 */
export const WORLD_FONT = '/assets/fonts/NotoSansKR-Bold-subset.ttf';

/**
 * troika 텍스트 래퍼. troika는 지정 폰트에 없는 글리프를 만나면 jsdelivr의 unicode-font-resolver로 폴백하는데,
 * 사내망·오프라인 데모에서 외부 요청이 나가므로 로컬 경로로 돌려 둔다(없으면 same-origin 404 한 번, 글리프는 비움).
 */
export function WorldText(props: ComponentProps<typeof Text>) {
  return <Text font={WORLD_FONT} {...props} {...({ unicodeFontsURL: '/assets/fonts/unicode-fallback' } as object)} />;
}
