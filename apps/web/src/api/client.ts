import type {
  AcceptVisitRequest,
  ApprovalListResponse,
  CardPatch,
  CreateCardRequest,
  DigestResponse,
  VoteRequest,
  VoteResponse,
  CreateMemoryRequest,
  LeaveRequest,
  LoginResponse,
  MemoryItemDto,
  MemoryListResponse,
  Mandate,
  VisitDto,
  MeResponse,
  MetricsResponse,
  RoomSnapshot,
  SendMessageRequest,
  UsersResponse,
  WorldResponse,
} from '@ensemble/shared';

// HOSTING: 외부 배포 시 VITE_API_BASE로 API 주소를 바꾼다.
const API_BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? '';
const TOKEN_KEY = 'ensemble.token';

/** 토큰은 sessionStorage: 같은 브라우저의 두 탭에서 서로 다른 사용자로 로그인할 수 있다. */
export function getToken(): string | null {
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}
export function setToken(token: string | null): void {
  try {
    if (token) sessionStorage.setItem(TOKEN_KEY, token);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    /* 저장소를 못 쓰면 메모리 세션으로만 동작 */
  }
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, '서버에 연결할 수 없습니다', 'network');
  }
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* 본문이 JSON이 아님 */
  }
  if (!res.ok) {
    const j = (json ?? {}) as { error?: string; code?: string };
    throw new ApiError(res.status, j.error ?? `HTTP ${res.status}`, j.code);
  }
  return json as T;
}

const roomPath = (roomId: string) => `/api/rooms/${encodeURIComponent(roomId)}`;

export interface VisitResult {
  visitId: string;
  seq: number;
  visit: VisitDto;
}

export const api = {
  login: (name: string) => request<LoginResponse>('POST', '/api/login', { name }),
  me: () => request<MeResponse>('GET', '/api/me'),
  users: () => request<UsersResponse>('GET', '/api/users'),
  world: () => request<WorldResponse>('GET', '/api/world'),
  snapshot: (roomId: string) => request<RoomSnapshot>('GET', `/api/rooms/${encodeURIComponent(roomId)}/snapshot`),
  sendMessage: (roomId: string, req: SendMessageRequest) =>
    request<{ seq: number; clientId: string }>('POST', `/api/rooms/${encodeURIComponent(roomId)}/messages`, req),
  seen: (roomId: string, seq: number) =>
    request<{ ok: true }>('POST', `/api/rooms/${encodeURIComponent(roomId)}/seen`, { seq }),

  /* ----- 입퇴장 ----- */
  enter: (roomId: string) => request<{ seq: number }>('POST', `${roomPath(roomId)}/enter`, {}),
  leave: (roomId: string, req: LeaveRequest = {}) => request<{ seq: number }>('POST', `${roomPath(roomId)}/leave`, req),
  rejoin: (roomId: string) => request<{ seq: number; missedCount: number }>('POST', `${roomPath(roomId)}/rejoin`, {}),
  digestViewed: (roomId: string) => request<{ seq: number }>('POST', `${roomPath(roomId)}/digest_viewed`, {}),

  /* ----- 방문 ----- */
  requestVisit: (hostRoomId: string) => request<VisitResult>('POST', `${roomPath(hostRoomId)}/visits`, { kind: 'human' }),
  sendAgent: (hostRoomId: string, mandate: Mandate) =>
    request<VisitResult>('POST', `${roomPath(hostRoomId)}/visits/agent`, { mandate }),
  acceptVisit: (visitId: string, req: AcceptVisitRequest) =>
    request<VisitResult>('POST', `/api/visits/${encodeURIComponent(visitId)}/accept`, req),
  declineVisit: (visitId: string) => request<VisitResult>('POST', `/api/visits/${encodeURIComponent(visitId)}/decline`, {}),
  endVisit: (visitId: string) => request<VisitResult>('POST', `/api/visits/${encodeURIComponent(visitId)}/end`, {}),

  /* ----- 보드 ----- */
  createCard: (roomId: string, req: CreateCardRequest) => request<{ seq: number }>('POST', `${roomPath(roomId)}/cards`, req),
  patchCard: (roomId: string, cardId: string, patch: CardPatch, baseVersion: number) =>
    request<{ seq: number }>('PATCH', `${roomPath(roomId)}/cards/${encodeURIComponent(cardId)}`, { patch, baseVersion }),
  addComment: (roomId: string, cardId: string, text: string) =>
    request<{ seq: number }>('POST', `${roomPath(roomId)}/comments`, { cardId, text }),
  pointCard: (roomId: string, cardId: string, agentId: string) =>
    request<{ seq: number }>('POST', `${roomPath(roomId)}/point`, { cardId, agentId }),

  /* ----- 승인 (S10) ----- */
  pendingApprovals: () => request<ApprovalListResponse>('GET', '/api/approvals?mine=pending'),
  vote: (approvalId: string, req: VoteRequest) =>
    request<VoteResponse>('POST', `/api/approvals/${encodeURIComponent(approvalId)}/vote`, req),

  /* ----- Rejoin 다이제스트 ----- */
  digest: (roomId: string) => request<DigestResponse>('GET', `${roomPath(roomId)}/digest`),

  /* ----- 메모리 ----- */
  memory: () => request<MemoryListResponse>('GET', '/api/memory'),
  roomMemory: (roomId: string) => request<MemoryListResponse>('GET', `${roomPath(roomId)}/memory`),
  addMemory: (req: CreateMemoryRequest) => request<MemoryItemDto>('POST', '/api/memory', req),
  reshareMemory: (id: string, ns: string) =>
    request<MemoryItemDto>('PATCH', `/api/memory/${encodeURIComponent(id)}`, { ns }),
  deleteMemory: (id: string) => request<{ ok: true }>('DELETE', `/api/memory/${encodeURIComponent(id)}`),
};

/** 지표 (S20). roomId를 주면 그 Room만 센다. */
export function getMetrics(roomId?: string): Promise<MetricsResponse> {
  return request<MetricsResponse>('GET', roomId ? `/api/metrics?roomId=${encodeURIComponent(roomId)}` : '/api/metrics');
}

/** 승인 투표 오류 코드별 문구 (S10 서버 계약) */
const VOTE_ERROR_TEXT: Record<string, string> = {
  not_approver: '이 승인의 승인자가 아니에요.',
  approval_not_found: '승인을 찾을 수 없어요.',
  already_voted: '이미 결정했어요.',
  already_resolved: '이미 처리된 승인이에요.',
  option_mismatch: '선택지가 맞지 않아요. 새로고침 후 다시 시도해 주세요.',
  needs_decision_approval: '합의된 카드는 결정 승인을 거쳐야 수정할 수 있어요.',
  card_gone: '대상 카드가 사라졌어요.',
  invalid_option: '올바르지 않은 선택지예요.',
  edit_not_supported: '이 승인은 수정해서 승인할 수 없어요.',
  empty_proposal: '수정안이 비어 있어요.',
};

export function voteErrorText(e: unknown): string {
  if (e instanceof ApiError) return (e.code && VOTE_ERROR_TEXT[e.code]) || e.message;
  return '요청에 실패했습니다';
}
