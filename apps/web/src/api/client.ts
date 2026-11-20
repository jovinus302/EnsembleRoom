import type {
  AcceptVisitRequest,
  BoardToolOpRequest,
  CreateBoardToolRequest,
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

/** 커버 이미지 등 /api/media 자산. <img>는 Authorization 헤더를 못 보내므로 fetch → blob URL로 쓴다(URL에 토큰 없음). */
const mediaUrls = new Map<string, Promise<string>>();
export function fetchMediaUrl(assetId: string): Promise<string> {
  let p = mediaUrls.get(assetId);
  if (!p) {
    const token = getToken();
    p = fetch(`${API_BASE}/api/media/${encodeURIComponent(assetId)}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
      .then(async (res) => {
        if (!res.ok) throw new ApiError(res.status, `HTTP ${res.status}`);
        return URL.createObjectURL(await res.blob());
      })
      .catch((e) => {
        mediaUrls.delete(assetId); // 실패는 캐시하지 않는다(다시 열 때 재시도)
        throw e;
      });
    mediaUrls.set(assetId, p);
  }
  return p;
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

  /* ----- 보드 도구 (낙관적 업데이트 없음: 결과는 WS 이벤트로 반영) ----- */
  createBoardTool: (roomId: string, req: CreateBoardToolRequest) =>
    request<{ seq: number; toolId: string }>('POST', `${roomPath(roomId)}/tools`, req),
  boardToolOp: (roomId: string, toolId: string, req: BoardToolOpRequest) =>
    request<{ seq: number; toolId: string; op: string }>('POST', `${roomPath(roomId)}/tools/${encodeURIComponent(toolId)}/ops`, req),
  removeBoardTool: (roomId: string, toolId: string) =>
    request<{ seq: number }>('DELETE', `${roomPath(roomId)}/tools/${encodeURIComponent(toolId)}`),

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

/** 보드 도구 오류 코드별 문구 (서버 계약: 계획 4.2) */
const BOARD_TOOL_ERROR_TEXT: Record<string, string> = {
  tool_not_found: '도구를 찾을 수 없어요. 이미 내려갔을 수 있어요.',
  item_not_found: '대상 항목이 이미 사라졌어요.',
  already_ran: '이미 실행됐어요.',
  not_ran: '아직 실행 전이에요.',
  tool_full: '항목이 가득 찼어요.',
  too_many_tools: '보드 도구는 최대 12개까지 올릴 수 있어요.',
  invalid_day: '일정 일차가 범위를 벗어났어요.',
  invalid_tool_init: '도구 내용이 올바르지 않아요.',
  empty_title: '제목을 입력해 주세요.',
  op_kind_mismatch: '이 도구에는 할 수 없는 동작이에요.',
  humans_only: '사람만 할 수 있는 동작이에요.',
};

export function boardToolErrorText(e: unknown): string {
  if (e instanceof ApiError) return (e.code && BOARD_TOOL_ERROR_TEXT[e.code]) || e.message;
  return '요청에 실패했습니다';
}
