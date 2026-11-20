import type { MemoryKind } from '@ensemble/shared';

/** 기억 항목. memory_items 테이블 한 행 */
export interface MemoryItem {
  id: string;
  ns: string;
  kind: MemoryKind;
  text: string;
  sourceRoomId: string | null;
  createdBy: string;
  status: string;
  createdAt: number;
}

export interface RetainInput {
  kind: MemoryKind;
  text: string;
  sourceRoomId?: string | null;
  createdBy: string;
}

/**
 * 메모리 백엔드 인터페이스 (계획 7절). Hindsight의 retain / recall / list 연산 모양을 따른다.
 * ns(bank)가 격리 단위다. 호출자가 ns를 고를 수 있는 곳은 gateway뿐이고, gateway가 서버 진실로 계산한다.
 */
export interface MemoryStore {
  retain(ns: string, input: RetainInput): MemoryItem;
  /** nsList 전체에서 질의와 관련 있는 항목을 최근순+키워드로 고른다. 결과 토큰 합이 tokenBudget을 넘지 않는다. */
  recall(nsList: readonly string[], query: string, tokenBudget: number): MemoryItem[];
  list(ns: string): MemoryItem[];
  /* 아래는 소유자(MemoryPanel) 관리용 */
  get(id: string): MemoryItem | undefined;
  forget(id: string): void;
  /** 항목의 ns 변경 (공유 대상 Room 지정·해제) */
  reassign(id: string, ns: string): void;
}
