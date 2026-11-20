import { useMemo } from 'react';
import { sendMessage } from '../api/ws';
import { Composer } from '../messenger/Composer';
import { MessageList } from '../messenger/MessageList';
import { titleOf } from '../messenger/labels';
import type { RoomModel } from './useRoomModel';

/**
 * 작업 과정 피드: 대화, Agent 말풍선과 작업 단계(StepTrace), 방문·승인·합의 카드와 알림을 시간순으로 보인다.
 * 타임라인 재생 중에는 그 seq까지만 보이고 입력은 막힌다.
 */
export function ActivityFeed({ model, leftReason }: { model: RoomModel; leftReason?: string }) {
  const targets = useMemo(
    () => model.agents.filter((a) => a.state.mode !== 'traveling').map((a) => ({ id: a.agentId, name: a.name })),
    [model.agents],
  );
  const title = titleOf(model.room, model.meId, model.users);
  const disabledReason = model.replaying ? '과거를 재생 중이에요 · 지금으로 돌아가면 쓸 수 있어요' : leftReason;
  return (
    <section aria-label={`${title} 활동`} data-testid="activity-feed" className="flex min-h-0 flex-1 flex-col">
      <h2 className="border-b border-line px-5 py-2.5 text-sm font-semibold">활동</h2>
      <div className="flex min-h-0 flex-1 flex-col bg-panel/60">
        <MessageList roomId={model.roomId} meId={model.meId} users={model.users} replaySeq={model.replaySeq} />
        <Composer
          placeholder={`${title}에 메시지 보내기`}
          targets={targets}
          disabledReason={disabledReason}
          onSend={(t, to) => void sendMessage(model.roomId, t, undefined, to)}
        />
      </div>
    </section>
  );
}
