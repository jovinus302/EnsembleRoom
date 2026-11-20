import type { Mandate } from '@ensemble/shared';
import { CAPABILITY_LABEL } from './visits';
import { tint } from '../theme';

/**
 * 위임 범위 전용 표시. 방문 Agent의 소유자가 Agent에게 맡긴 범위를 일반 메시지·카드 내용과 구분해 보여 준다.
 * 점선 테두리 + 소유자 색 포인트 + "위임 범위" 태그. 호스트가 보는 방문 요청 카드와 Room 안 Agent 상태 목록이 같은 컴포넌트를 쓴다.
 * 소유자 본인이 볼 때는 문구만 "내가 맡긴 범위"로 바뀐다.
 */
export function MandateBlock({
  mandate,
  ownerName,
  color,
  viewerIsOwner,
  compact = false,
}: {
  mandate: Mandate;
  ownerName: string;
  /** 방문 Agent 소유자의 색 */
  color: string;
  viewerIsOwner: boolean;
  compact?: boolean;
}) {
  return (
    <div
      data-testid="mandate-block"
      data-viewer-owner={viewerIsOwner ? 'true' : 'false'}
      className={`surface-card rounded-lg border border-dashed ${compact ? 'mt-1.5 px-2.5 py-1.5' : 'mt-2 px-3 py-2'}`}
      style={{ borderColor: color, backgroundColor: tint(color, '--tint-mandate') }}
    >
      <div className="flex items-center gap-1.5">
        <span
          className="inline-flex items-center gap-1 rounded-full px-1.5 py-px text-[10px] font-semibold leading-4 text-[var(--on-accent)]"
          style={{ background: color }}
        >
          <svg aria-hidden="true" width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 2.5h7l3 3v8H3z" />
            <path d="M10 2.5v3h3M5.5 8.5h5M5.5 11h5" />
          </svg>
          위임 범위
        </span>
        <span className="text-[11px] text-muted">
          {viewerIsOwner ? '내가 맡긴 범위예요' : `${ownerName}님이 Agent에게 맡긴 범위예요`}
        </span>
      </div>
      <p className={`mt-1 border-l-2 pl-2 ${compact ? 'text-xs' : 'text-sm'}`} style={{ borderColor: color }} data-testid="mandate-text-display">
        {mandate.text}
      </p>
      {mandate.allowedActions.length > 0 && (
        <p className="mt-1 flex flex-wrap gap-1 text-[10px] text-muted">
          {mandate.allowedActions.map((c) => (
            <span key={c} className="rounded border border-dashed px-1 leading-4" style={{ borderColor: `${color}99` }}>
              {CAPABILITY_LABEL[c]}
            </span>
          ))}
        </p>
      )}
    </div>
  );
}
