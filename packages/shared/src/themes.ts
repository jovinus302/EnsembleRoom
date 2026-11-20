import { z } from 'zod';
import type { RoomKind } from './events';

export const ThemeIdSchema = z.enum(['studio', 'lounge', 'cafe']);
export type ThemeId = z.infer<typeof ThemeIdSchema>;

/** cafe 세트의 소품 변형. 'home'은 식탁과 러그, 'meeting'은 긴 테이블과 화이트보드 */
export const ThemeVariantSchema = z.enum(['home', 'meeting']);
export type ThemeVariant = z.infer<typeof ThemeVariantSchema>;

export interface ThemeMeta {
  id: ThemeId;
  label: string;
  /** 기본 좌석 수 (사람 + Agent 자리 합산 아님: 사람 좌석) */
  seats: number;
}

export const THEMES: Readonly<Record<ThemeId, ThemeMeta>> = {
  studio: { id: 'studio', label: '작업실', seats: 2 },
  lounge: { id: 'lounge', label: '라운지·서재', seats: 2 },
  cafe: { id: 'cafe', label: '카페', seats: 6 },
};

export const THEME_IDS: readonly ThemeId[] = ThemeIdSchema.options;

/** variant가 좌석 수를 바꾸는 경우 */
const VARIANT_SEATS: Readonly<Record<ThemeVariant, number>> = { home: 6, meeting: 8 };

export function themeSeats(theme: ThemeId, variant: ThemeVariant | null = null): number {
  if (theme === 'cafe' && variant) return VARIANT_SEATS[variant];
  return THEMES[theme].seats;
}

/** 캡슐 외형: My/Your는 길쭉, Our는 1.6배 통통 (계획 8.3) */
export interface CapsuleSpec {
  proportion: 'long' | 'plump';
  scale: number;
}

export function capsuleSpec(kind: RoomKind): CapsuleSpec {
  return kind === 'our' ? { proportion: 'plump', scale: 1.6 } : { proportion: 'long', scale: 1 };
}

/** 방 종류별 기본 테마. my는 소유자별로 시드가 지정하므로 기본값은 studio */
export function defaultThemeFor(kind: RoomKind): ThemeId {
  return kind === 'our' ? 'cafe' : 'studio';
}
