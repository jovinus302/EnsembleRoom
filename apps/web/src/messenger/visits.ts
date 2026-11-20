import { PALETTE, type Capability, type Mandate, type RoomEvent, type VisitEndReason, type VisitStatus } from '@ensemble/shared';

/** 타임라인의 visit_* 이벤트를 visitId별 현재 상태로 접는다 (snapshot의 visits가 스토어에 없으므로 이벤트가 진실). */
export interface VisitState {
  visitId: string;
  visitorUserId: string;
  visitorKind: 'human' | 'agent';
  visitorAgentId?: string;
  /** Agent 방문의 위임 범위(호스트·방문자 소유자에게만 이벤트로 온다) */
  mandate?: Mandate;
  status: VisitStatus;
  permissions: Capability[];
  endReason?: VisitEndReason;
  requestedSeq: number;
}

export function foldVisits(events: readonly RoomEvent[]): Map<string, VisitState> {
  const out = new Map<string, VisitState>();
  for (const e of events) {
    switch (e.type) {
      case 'visit_requested':
        out.set(e.visitId, {
          visitId: e.visitId,
          visitorUserId: e.visitorUserId,
          visitorKind: e.visitorKind,
          visitorAgentId: e.visitorAgentId,
          mandate: e.mandate,
          status: 'requested',
          permissions: [],
          requestedSeq: e.seq,
        });
        break;
      case 'visit_accepted': {
        const v = out.get(e.visitId);
        if (v) out.set(e.visitId, { ...v, status: 'active', permissions: e.permissions });
        break;
      }
      case 'visit_declined': {
        const v = out.get(e.visitId);
        if (v) out.set(e.visitId, { ...v, status: 'declined' });
        break;
      }
      case 'visit_ended': {
        const v = out.get(e.visitId);
        if (v) out.set(e.visitId, { ...v, status: 'ended', endReason: e.reason });
        break;
      }
      default:
        break;
    }
  }
  return out;
}

export const CAPABILITY_LABEL: Record<Capability, string> = {
  chat: '대화',
  comment: '댓글',
  edit_board: '보드 편집',
  propose_edit: '수정 제안',
  remember: '기억 저장',
  request_approval: '승인 요청',
};

export const END_REASON_LABEL: Record<VisitEndReason, string> = {
  visitor_left: '방문자가 떠남',
  host_ended: '호스트가 종료',
  agent_ended: 'Agent가 마침',
  turn_limit: '턴 상한 도달',
  timeout: '시간 초과',
};

/** 승인 전용 색(오렌지). 계획 8.3: 오렌지는 승인에만 쓴다. */
export const APPROVAL_ORANGE: string = PALETTE.approvalOrange;
