export type TourId = 'home' | 'room';

export interface TourStep {
  title: string;
  body: string;
  /** 하이라이트할 요소의 CSS 선택자(앞에서부터 처음 보이는 것). 없거나 가려져 있으면 중앙 카드로 대체한다. */
  target?: string[];
  /** 포인터를 받지 않는 3D 투명 창처럼 가림 검사를 할 수 없는 대상 */
  skipOcclusion?: boolean;
}

/** 메신저 홈 투어. 문구는 실제 UI 이름(들어가기, 방문 요청, Agent 보내기, 내 승인 대기, Leave, Rejoin, 지표)에 맞춘다. */
const HOME: TourStep[] = [
  {
    title: '나 / 상대 / 우리',
    body: '내 방은 My Room, 상대의 방은 상대의 Room, 함께 쓰는 방은 Our Room이에요. 가족·친구·동료는 Our Room의 예시일 뿐이에요.',
    target: ['nav[aria-label="대화 목록"]'],
  },
  {
    title: '3D 조망 읽기',
    body: '앞의 큰 캡슐이 내 방, 가운데가 우리 방, 뒤쪽이 상대 방이에요. 색은 내 색, 상대 색, 두 색이 섞인 우리 색을 뜻해요. 드래그로 각도를, 휠로 줌을 바꿀 수 있어요.',
    target: ['[data-testid="world-strip"]'],
    skipOcclusion: true,
  },
  {
    title: '사람과 Agent',
    body: '사람은 얼굴 초상이 든 동그란 아바타와 둥근 이름표, Agent는 작은 캐릭터에 ✦ 표식과 각진 이름표예요. Personal Agent는 내 대리인, Room Agent(라임 육각)는 그 방을 돌보는 Agent예요.',
    target: ['[data-testid="world-legend"]'],
  },
  {
    title: '방 들어가기',
    body: '왼쪽 목록에서 방을 고르면 대화가 열려요. 3D 캡슐을 눌러 고를 수도 있고, “들어가기”를 누르면 Room 안으로 들어가요.',
    target: ['[data-testid="enter-room"]', 'aside[aria-label="Room 미리보기"]'],
  },
  {
    title: '말 걸기',
    body: '입력창 왼쪽에서 받는 이를 고르고 말해요. My Room에서는 내 Agent가, Our Room에서는 아무 말에나 Room Agent가 답해요. 접속하지 않은 친구는 그 친구의 Agent가 “자리 비움 · 자동 대리”로 대신 답해요.',
    target: ['[data-tour="composer"]'],
  },
  {
    title: '방문',
    body: '사람 목록에서 상대를 고르면 “방문 요청”이나 “Agent 보내기”로 상대 방에 갈 수 있어요. Agent를 보낼 땐 위임 범위(할 수 있는 일)를 정해요. 방문이 수락되면 서리 낀 유리가 걷혀 안이 보여요.',
    target: ['section[aria-label="사람"]'],
  },
  {
    title: '승인',
    body: 'Agent는 중요한 결정을 직접 하지 않고 승인을 요청해요. 요청은 사이드바 “내 승인 대기”에 모이고, 승인 카드에서 승인 · 수정해서 승인 · 거절을 고르면 돼요.',
    target: ['[data-testid="approval-inbox"]'],
  },
  {
    title: 'Leave와 Rejoin',
    body: 'Room 안에서 Leave하면 메신저 메인으로 돌아오고, 그동안 내 Agent가 위임 범위 안에서 대신해요. 다시 들어가면(Rejoin) 그동안의 요약(다이제스트)을 보여줘요.',
    target: ['aside[aria-label="Room 미리보기"]'],
  },
  {
    title: '마무리',
    body: 'Room 아래 타임라인으로 과거를 되감고, “내 기억” 탭에서 Agent의 기억을, “지표” 버튼에서 숫자를 볼 수 있어요. 혼자 볼 때는 창을 하나 더 열어 Bob으로 로그인하면 두 사람 시점을 함께 볼 수 있어요.',
    target: ['[data-testid="open-metrics"]'],
  },
];

/** Room 화면 투어. */
const ROOM: TourStep[] = [
  {
    title: '참여자와 Agent',
    body: '여기 누가 있는지와 Agent의 상태를 보여줘요. ✦ 표식이 붙은 각진 아이콘이 Agent, 동그란 초상 아바타가 사람이에요.',
    target: ['[data-testid="agent-status-list"]'],
  },
  {
    title: '보드',
    body: '함께 정리하는 카드 보드예요. “카드 추가”로 직접 쓰거나, Agent가 만든 초안을 받아 다듬어요.',
    target: ['[data-testid="board"]'],
  },
  {
    title: '승인',
    body: 'Agent가 확정이 필요한 일을 만나면 여기에 승인 카드를 올려요. 결정은 늘 사람의 몫이에요.',
    target: ['[data-testid="approval-panel"]'],
  },
  {
    title: '활동 피드',
    body: '대화와 Agent의 작업 과정이 시간순으로 쌓여요. 아래 입력창에서 받는 이를 골라 말을 걸어요.',
    target: ['[data-testid="activity-feed"]'],
  },
  {
    title: '타임라인',
    body: '슬라이더를 끌면 지난 일을 되감아 볼 수 있어요. “지금으로”를 누르면 현재로 돌아와요.',
    target: ['[data-testid="timeline"]'],
  },
  {
    title: 'Leave',
    body: '자리를 비울 땐 Leave를 눌러요. 내 Agent에게 위임 범위를 주면 대신 참여하고, 돌아와 Rejoin하면 놓친 일을 요약해 줘요.',
    target: ['[data-testid="room-leave"]', '[data-testid="room-rejoin"]', '[data-testid="room-actions"]'],
  },
];

export const TOURS: Record<TourId, { label: string; steps: TourStep[] }> = {
  home: { label: '메신저 가이드', steps: HOME },
  room: { label: 'Room 가이드', steps: ROOM },
};
