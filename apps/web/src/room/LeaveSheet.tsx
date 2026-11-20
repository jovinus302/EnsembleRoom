import { useState } from 'react';
import { VISITOR_GRANTABLE, type Capability } from '@ensemble/shared';
import { api, ApiError } from '../api/client';
import { MandateForm } from './MandateForm';
import { Sheet } from './Sheet';

/** 대리 참여 중 Agent가 할 수 있는 행동 (서버 권한 표의 representing과 같다) */
const LEAVE_GRANTS: Capability[] = [...VISITOR_GRANTABLE, 'request_approval'];

/**
 * Leave 시트: 위임 메모와 허용 행동을 정한다.
 * 메모를 비우면 대리 참여 없이 자리만 비운다(Agent는 대신 말하지 않는다).
 */
export function LeaveSheet({
  roomId,
  agentName,
  onClose,
  onLeft,
}: {
  roomId: string;
  agentName: string;
  onClose: () => void;
  /** Leave가 완료된 뒤(시트를 닫은 다음) 호출 */
  onLeft?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Sheet title="Leave · 자리 비우기" onClose={onClose} testId="leave-sheet">
      <p className="mt-2 text-sm text-muted">
        {agentName}가 내 대신 이 Room에 남아 위임 범위 안에서만 움직여요. 보드를 직접 바꾸지는 못하고, 확정이 필요한 일은 나에게
        승인을 요청해요.
      </p>
      <MandateForm
        label="위임 메모 (비워 두면 대리 참여 없이 Leave)"
        placeholder="예: 토요일 오후로 조율, 예산 3만원, 확정은 내 승인"
        grants={LEAVE_GRANTS}
        defaultActions={['chat', 'comment', 'propose_edit', 'request_approval']}
        submitLabel="Leave"
        required={false}
        busy={busy}
        error={error}
        onCancel={onClose}
        onSubmit={async (m) => {
          setBusy(true);
          setError(null);
          try {
            await api.leave(roomId, m ? { mandate: m } : {});
            onClose();
            onLeft?.();
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
