import type { RoomEvent } from '@ensemble/shared';

/** 타임라인 스크러버용 한 줄 설명 */
export function eventLabel(e: RoomEvent, nameOf: (id: string | null | undefined) => string): string {
  const clip = (s: string, n = 40) => (s.length > n ? `${s.slice(0, n)}…` : s);
  switch (e.type) {
    case 'room_created':
      return 'Room이 만들어졌어요';
    case 'member_entered':
      return `${nameOf(e.userId)} 입장`;
    case 'member_left':
      return `${nameOf(e.userId)} Leave${e.mandate ? ' (대리 참여)' : ''}`;
    case 'member_rejoined':
      return `${nameOf(e.userId)} Rejoin · ${e.missedCount}건`;
    case 'digest_viewed':
      return `${nameOf(e.userId)} 다이제스트 확인`;
    case 'visit_requested':
      return `방문 요청 · ${nameOf(e.visitorUserId)}${e.visitorKind === 'agent' ? '의 Agent' : ''}`;
    case 'visit_accepted':
      return '방문 수락';
    case 'visit_declined':
      return '방문 거절';
    case 'visit_ended':
      return '방문 종료';
    case 'agent_departed':
      return `${nameOf(e.agentId)} 출발`;
    case 'agent_arrived':
      return `${nameOf(e.agentId)} 도착`;
    case 'agent_returned':
      return `${nameOf(e.agentId)} 귀환`;
    case 'visit_takeout':
      return `가져갈 내용 · ${clip(e.text)}`;
    case 'visit_report':
      return '방문 보고';
    case 'message':
      return `${nameOf(e.actorId)}: ${clip(e.text)}`;
    case 'card_created':
      return `카드 생성 · ${clip(e.title)}`;
    case 'card_updated':
      return '카드 수정';
    case 'comment_added':
      return `댓글 · ${clip(e.text)}`;
    case 'card_pointed':
      return `카드를 ${nameOf(e.toAgentId)}에게 보여 줌`;
    case 'agent_turn_started':
      return `${nameOf(e.agentId)} 생각 시작`;
    case 'agent_step':
      return `${nameOf(e.agentId)} 작업 단계`;
    case 'agent_turn_ended':
      return `${nameOf(e.agentId)} 턴 종료`;
    case 'agent_paused':
      return `${nameOf(e.agentId)} 멈춤`;
    case 'agent_owner_note':
      return `${nameOf(e.agentId)} 메모`;
    case 'approval_requested':
      return `승인 요청 · ${clip(e.summary)}`;
    case 'approval_voted':
      return `${nameOf(e.userId)} 투표`;
    case 'approval_resolved':
      return `승인 결과 · ${{ approved: '승인', edited: '수정 승인', rejected: '거절' }[e.outcome]}`;
    case 'agreement_formed':
      return '합의 형성';
    case 'memory_retained':
      return '기억 저장';
  }
}

/** 스크러버 눈금 색: 승인(오렌지), 합의(금색), 입퇴장(회색) */
export function eventMark(e: RoomEvent): string | null {
  switch (e.type) {
    case 'approval_requested':
    case 'approval_resolved':
      return '#ff9f43';
    case 'agreement_formed':
      return '#f2d04e';
    case 'member_left':
    case 'member_rejoined':
      return '#a0aec4';
    default:
      return null;
  }
}
