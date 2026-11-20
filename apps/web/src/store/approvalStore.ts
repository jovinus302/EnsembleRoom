import { create } from 'zustand';
import type { ApprovalItemDto } from '@ensemble/shared';
import { api } from '../api/client';

/** 전역 "내 승인 대기" 인박스 (GET /api/approvals?mine=pending). 승인 이벤트·world_preview가 오면 새로고침한다. */
interface ApprovalInboxState {
  items: ApprovalItemDto[];
  loaded: boolean;
  load: () => Promise<void>;
  /** 투표 응답으로 받은 최신 항목을 반영한다(대기 중이 아니면 목록에서 뺀다) */
  applyItem: (a: ApprovalItemDto, meId: string) => void;
  reset: () => void;
}

export const useApprovalInbox = create<ApprovalInboxState>((set) => ({
  items: [],
  loaded: false,
  async load() {
    try {
      const r = await api.pendingApprovals();
      set({ items: r.approvals, loaded: true });
    } catch {
      /* 다음 신호 때 다시 시도 */
    }
  },
  applyItem(a, meId) {
    set((s) => {
      const rest = s.items.filter((x) => x.approvalId !== a.approvalId);
      const stillMine = a.status === 'pending' && a.approvers.includes(meId) && a.votes[meId] === undefined;
      return { items: stillMine ? [...rest, a] : rest };
    });
  },
  reset: () => set({ items: [], loaded: false }),
}));

let timer: ReturnType<typeof setTimeout> | null = null;
/** 짧은 시간에 몰리는 신호를 한 번의 요청으로 합친다 */
export function refreshApprovalInbox(): void {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    void useApprovalInbox.getState().load();
  }, 150);
}
