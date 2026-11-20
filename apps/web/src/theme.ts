/**
 * 글자로 쓰는 사람/Agent/채널 색: 원래 색(파스텔·형광 계열)에 --ink-base 를 --ink-pct 만큼 섞어 명도를 맞춘다.
 * (navy: 원래 색 그대로)
 * 원래 색은 테두리·점·배경 틴트에 그대로 쓰고, 글자에는 이 함수를 쓴다. 색상(hue)은 유지된다.
 */
export function ink(color: string | undefined | null): string {
  if (!color) return 'var(--muted)';
  return `color-mix(in oklab, ${color} var(--ink-pct), var(--ink-base))`;
}

/** 승인(A2H) 오렌지(PALETTE.approvalOrange)의 글자용 버전. --approval-ink. */
export const APPROVAL_INK = 'var(--approval-ink)';

/** 말풍선·카드 바탕: 색을 비율(--tint-*)로 --card-base 에 섞는다. */
export function tint(color: string, pctVar: string, baseVar = '--card-base'): string {
  return `color-mix(in srgb, ${color} var(${pctVar}), var(${baseVar}))`;
}
