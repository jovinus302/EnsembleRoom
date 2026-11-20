import { randomUUID } from 'node:crypto';
import type { Repo } from '../db/repo';
import type { MemoryItem, MemoryStore, RetainInput } from './types';

/** 한 번의 recall이 돌려주는 최대 항목 수 (계획 6절: 최근 20개) */
export const MAX_RECALL_ITEMS = 20;

/** 대략적인 토큰 수 추정. 한글은 글자당 약 0.5토큰으로 잡고 id·구분 오버헤드를 더한다. */
export const estimateTokens = (text: string): number => Math.ceil(text.length / 2) + 8;

function keywords(query: string): string[] {
  return [...new Set(query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((t) => t.length >= 2))];
}

/** SQLite 구현. 시연 규모에서는 최근순 + 키워드 일치 수로 충분하다(벡터 검색 없음). */
export class LocalMemoryStore implements MemoryStore {
  constructor(private readonly repo: Repo) {}

  retain(ns: string, input: RetainInput): MemoryItem {
    const id = `mem_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    this.repo.insertMemoryItem({
      id,
      ns,
      kind: input.kind,
      text: input.text,
      sourceRoomId: input.sourceRoomId ?? null,
      createdBy: input.createdBy,
    });
    return this.repo.getMemoryItem(id)!;
  }

  recall(nsList: readonly string[], query: string, tokenBudget: number): MemoryItem[] {
    const items = this.repo.listMemoryItemsIn(nsList); // 오래된 순
    const kws = keywords(query);
    const ranked = items
      .map((item, idx) => {
        const text = item.text.toLowerCase();
        return { item, idx, score: kws.reduce((n, k) => n + (text.includes(k) ? 1 : 0), 0) };
      })
      .sort((a, b) => b.score - a.score || b.item.createdAt - a.item.createdAt || b.idx - a.idx);
    const out: MemoryItem[] = [];
    let used = 0;
    for (const { item } of ranked) {
      if (out.length >= MAX_RECALL_ITEMS) break;
      const cost = estimateTokens(item.text);
      if (used + cost > tokenBudget) continue;
      used += cost;
      out.push(item);
    }
    return out;
  }

  list(ns: string): MemoryItem[] {
    return this.repo.listMemoryItems(ns);
  }
  get(id: string): MemoryItem | undefined {
    return this.repo.getMemoryItem(id);
  }
  forget(id: string): void {
    this.repo.setMemoryStatus(id, 'deleted');
  }
  reassign(id: string, ns: string): void {
    this.repo.setMemoryNs(id, ns);
  }
}
