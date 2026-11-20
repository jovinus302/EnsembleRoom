import { create } from 'zustand';
import type { AgentDto, UserDto } from '@ensemble/shared';
import { api, ApiError, getToken, setToken } from '../api/client';

interface SessionState {
  /** 'init' = 저장된 토큰 확인 중 */
  status: 'init' | 'anonymous' | 'authed';
  user: UserDto | null;
  agent: AgentDto | null;
  error: string | null;
  init: () => Promise<void>;
  login: (name: string) => Promise<boolean>;
  logout: () => void;
}

export const useSession = create<SessionState>((set) => ({
  status: 'init',
  user: null,
  agent: null,
  error: null,
  async init() {
    if (!getToken()) return set({ status: 'anonymous' });
    try {
      const me = await api.me();
      set({ status: 'authed', user: me.user, agent: me.agent, error: null });
    } catch (e) {
      if (e instanceof ApiError && e.status === 0) {
        set({ status: 'anonymous', error: e.message });
        return;
      }
      setToken(null);
      set({ status: 'anonymous', user: null, agent: null });
    }
  },
  async login(name) {
    const trimmed = name.trim();
    if (!trimmed) {
      set({ error: '이름을 입력해 주세요' });
      return false;
    }
    try {
      const r = await api.login(trimmed);
      setToken(r.token);
      const me = await api.me();
      set({ status: 'authed', user: me.user, agent: me.agent, error: null });
      return true;
    } catch (e) {
      set({ error: e instanceof ApiError ? e.message : '로그인에 실패했습니다' });
      return false;
    }
  },
  logout() {
    setToken(null);
    set({ status: 'anonymous', user: null, agent: null, error: null });
  },
}));
