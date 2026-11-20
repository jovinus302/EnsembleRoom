/** 채팅 목록 자동 스크롤 판정 (순수 함수) */

export const NEAR_BOTTOM_PX = 80;

/** 맨 아래에서 threshold 이내면 "따라가기" 상태로 본다 */
export function isNearBottom(
  m: { scrollHeight: number; scrollTop: number; clientHeight: number },
  threshold = NEAR_BOTTOM_PX,
): boolean {
  return m.scrollHeight - m.scrollTop - m.clientHeight <= threshold;
}

/** 내용이 늘었을 때: 따라가는 중이면 맨 아래로, 아니면 "새 메시지" 안내를 띄운다 */
export function onContentGrow(stick: boolean): { scrollToBottom: boolean; showJump: boolean } {
  return stick ? { scrollToBottom: true, showJump: false } : { scrollToBottom: false, showJump: true };
}

/** 내가 방금 보낸 메시지가 추가됐는지(pending 개수 증가) — 위치와 무관하게 맨 아래로 */
export function sentByMe(prevPending: number, nextPending: number): boolean {
  return nextPending > prevPending;
}
