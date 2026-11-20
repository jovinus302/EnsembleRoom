import { create } from 'zustand';

/** Rejoin 다이제스트 모달의 대상. App 루트의 <RejoinDigest/>가 읽는다. */
interface DigestUiState {
  roomId: string | null;
  open: (roomId: string) => void;
  close: () => void;
}

export const useDigestUi = create<DigestUiState>((set) => ({
  roomId: null,
  open: (roomId) => set({ roomId }),
  close: () => set({ roomId: null }),
}));
