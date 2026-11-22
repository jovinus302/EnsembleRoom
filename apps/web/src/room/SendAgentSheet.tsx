import { useState } from 'react';
import { VISITOR_GRANTABLE } from '@ensemble/shared';
import { api, ApiError } from '../api/client';
import { MandateForm } from './MandateForm';
import { Sheet } from './Sheet';

/**
 * Agent 보내기 시트: 상대 My Room에 내 Agent를 보낸다. 맡길 일(mandate)과 허용 행동을 정한다.
 * 호스트가 수락하면서 준 권한과 여기서 허용한 행동의 교집합만 방문 Agent가 쓴다.
 * 방문 Agent는 보드 편집과 기억 저장을 할 수 없고, 끝나면 가져갈 내용이 호스트 승인(takeout)을 거친다.
 */
export function SendAgentSheet({
  hostRoomId,
  hostName,
  agentName,
  onClose,
}: {
  hostRoomId: string;
  hostName: string;
  agentName: string;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Sheet title={`Agent 보내기 · ${hostName}`} eyebrow="SEND AGENT" onClose={onClose} testId="send-agent-sheet">
      <p className="tg-aux">
        {agentName}를 {hostName}에게 보내요. {hostName}님이 수락해야 출발하고, 끝나면 가져올 내용은 {hostName}님의 승인을 거쳐요.
      </p>
      <MandateForm
        label="Agent에게 맡길 일"
        placeholder="예: 토요일 일정이 되는지 물어보고 와줘"
        grants={VISITOR_GRANTABLE}
        defaultActions={['chat', 'comment']}
        submitLabel="보내기"
        required
        busy={busy}
        error={error}
        onCancel={onClose}
        onSubmit={async (m) => {
          if (!m) return;
          setBusy(true);
          setError(null);
          try {
            await api.sendAgent(hostRoomId, m);
            onClose();
          } catch (e) {
            setError(e instanceof ApiError ? e.message : '요청에 실패했습니다');
          } finally {
            setBusy(false);
          }
        }}
      />
    </Sheet>
  );
}
