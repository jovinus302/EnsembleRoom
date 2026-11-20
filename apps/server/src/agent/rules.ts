/** 트리거 판정과 mock이 함께 쓰는 순수 규칙 */

/** 자동 대리로 한 번에 깨우는 부재 구성원 Agent의 상한 (사람 메시지 1건당, 구성원 순서대로) */
export const AUTO_REPLY_MAX_AGENTS = 2;

/** "ㅇㅇ", "ㅋㅋ", "ok" 같은 2글자 이하 반응: 공백·구두점·이모지 등을 빼고 글자(한글 자모 포함)가 2개 이하 */
export function isTrivialReaction(text: string): boolean {
  const core = text.replace(/[^\p{L}\p{N}]/gu, '');
  return core.length <= 2;
}
