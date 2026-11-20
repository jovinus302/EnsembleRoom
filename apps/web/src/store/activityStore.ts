import { create } from 'zustand';
import type { ActivityMessage, ActivityPhase } from '@ensemble/shared';

/**
 * 휘발성 Agent 활동 (WS `activity`). 영속하지 않고 새로고침하면 사라진다.
 * 키는 `${roomId}:${agentId}`. 해제 신호: `final`, 해당 Agent의 `agent_turn_ended`, 마지막 갱신 후 타임아웃(안전장치).
 */

export interface ActivityEntry {
  roomId: string;
  agentId: string;
  turnId: string;
  /** 지금까지 스트리밍된 누적 텍스트 (계속 교체된다) */
  text: string;
  phase: ActivityPhase;
  tokensPerSec: number;
  startedAt: number;
  updatedAt: number;
}

/** 마지막 갱신 후 이 시간이 지나면 표시를 지운다(final을 놓친 경우의 안전장치). */
export const ACTIVITY_TIMEOUT_MS = 30_000;

export const activityKey = (roomId: string, agentId: string) => `${roomId}:${agentId}`;

interface ActivityState {
  byKey: Record<string, ActivityEntry>;
  /** WS activity 메시지 반영 */
  apply: (m: ActivityMessage) => void;
  /** agent_turn_started: 첫 토큰 전에도 "생각 중"을 바로 보인다 */
  begin: (roomId: string, agentId: string, turnId: string) => void;
  /** agent_step recalling 등 영속 단계로 phase만 갱신 */
  setPhase: (roomId: string, agentId: string, turnId: string, phase: ActivityPhase) => void;
  /** agent_turn_ended: 그 턴의 표시를 지우고, 늦게 오는 activity가 되살리지 못하게 막는다 */
  endTurn: (roomId: string, agentId: string, turnId: string) => void;
  clear: (roomId: string, agentId: string) => void;
  /** 구독을 해제한 Room: 끝 신호를 더 못 받으니 그 Room의 표시를 모두 지운다 */
  clearRoom: (roomId: string) => void;
  reset: () => void;
}

const timers = new Map<string, ReturnType<typeof setTimeout>>();
const endedTurns = new Set<string>();

function markEnded(turnId: string) {
  endedTurns.add(turnId);
  if (endedTurns.size > 300) {
    const first = endedTurns.values().next().value;
    if (first !== undefined) endedTurns.delete(first);
  }
}

export const useActivity = create<ActivityState>((set, get) => {
  function arm(key: string) {
    const t = timers.get(key);
    if (t) clearTimeout(t);
    timers.set(
      key,
      setTimeout(() => {
        timers.delete(key);
        set((s) => {
          if (!s.byKey[key]) return s;
          const next = { ...s.byKey };
          delete next[key];
          return { byKey: next };
        });
      }, ACTIVITY_TIMEOUT_MS),
    );
  }
  function drop(key: string) {
    const t = timers.get(key);
    if (t) clearTimeout(t);
    timers.delete(key);
    set((s) => {
      if (!s.byKey[key]) return s;
      const next = { ...s.byKey };
      delete next[key];
      return { byKey: next };
    });
  }
  function upsert(roomId: string, agentId: string, turnId: string, patch: Partial<ActivityEntry>) {
    const key = activityKey(roomId, agentId);
    const now = Date.now();
    set((s) => {
      const cur = s.byKey[key];
      const base: ActivityEntry =
        cur && cur.turnId === turnId
          ? cur
          : { roomId, agentId, turnId, text: '', phase: 'thinking', tokensPerSec: 0, startedAt: now, updatedAt: now };
      return { byKey: { ...s.byKey, [key]: { ...base, ...patch, updatedAt: now } } };
    });
    arm(key);
  }

  return {
    byKey: {},
    apply(m) {
      if (endedTurns.has(m.turnId)) return;
      if (m.final) {
        drop(activityKey(m.roomId, m.agentId));
        markEnded(m.turnId);
        return;
      }
      const cur = get().byKey[activityKey(m.roomId, m.agentId)];
      upsert(m.roomId, m.agentId, m.turnId, {
        text: m.text,
        tokensPerSec: m.tokensPerSec,
        // 단계만 알리는 메시지(빈 텍스트)는 phase를 따르고, 텍스트가 오면 쓰는 중으로 본다.
        phase: m.phase ?? (m.text ? 'writing' : (cur?.phase ?? 'thinking')),
      });
    },
    begin(roomId, agentId, turnId) {
      if (endedTurns.has(turnId)) return;
      const cur = get().byKey[activityKey(roomId, agentId)];
      if (cur && cur.turnId === turnId) return;
      upsert(roomId, agentId, turnId, { phase: 'thinking' });
    },
    setPhase(roomId, agentId, turnId, phase) {
      if (endedTurns.has(turnId)) return;
      const cur = get().byKey[activityKey(roomId, agentId)];
      if (cur && cur.turnId === turnId && cur.text) return; // 이미 쓰는 중이면 되돌리지 않는다
      upsert(roomId, agentId, turnId, { phase });
    },
    endTurn(roomId, agentId, turnId) {
      markEnded(turnId);
      const cur = get().byKey[activityKey(roomId, agentId)];
      if (cur && cur.turnId !== turnId) return; // 이미 다음 턴이 시작됨
      drop(activityKey(roomId, agentId));
    },
    clear: (roomId, agentId) => drop(activityKey(roomId, agentId)),
    clearRoom(roomId) {
      for (const a of Object.values(get().byKey)) if (a.roomId === roomId) drop(activityKey(a.roomId, a.agentId));
    },
    reset() {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
      endedTurns.clear();
      set({ byKey: {} });
    },
  };
});
