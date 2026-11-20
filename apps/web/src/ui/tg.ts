import type { CSSProperties } from 'react';

export type BtnVariant = 'cta' | 'primary' | 'soft' | 'ghost' | 'danger' | 'dghost' | 'person';

/** Tide Glass 버튼 클래스 문자열 (styles/tide.css 의 tg-btn 계열) */
export function btn(v: BtnVariant, o?: { round?: boolean; block?: boolean }): string {
  return `tg-btn tg-btn-${v}${o?.round ? ' tg-btn-round' : ''}${o?.block ? ' tg-btn-block' : ''}`;
}

/** 사람/도구 색을 CSS 변수(기본 `--c`)로 넘기는 style 객체 */
export function cvar(color: string | undefined, name = '--c'): CSSProperties {
  return (color ? { [name]: color } : {}) as CSSProperties;
}
