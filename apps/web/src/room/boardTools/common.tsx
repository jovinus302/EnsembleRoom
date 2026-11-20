import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import { COVER_KINDS, boardToolSummary, can, formatWon, settle, type BoardTool, type BoardToolKind, type BoardToolOpRequest } from '@ensemble/shared';
import { api, boardToolErrorText, fetchMediaUrl } from '../../api/client';
import { AgentAvatar, AgentTag, Avatar } from '../../messenger/Avatar';
import { FALLBACK_COLOR } from '../../messenger/agentIdentity';
import type { RoomModel } from '../useRoomModel';
import './boardTools.css';

/** 사람 참가자 구분용 팔레트 (사다리 경로 색) */
export const TOOL_COLORS = ['#d0674d', '#3f8f9a', '#d6a93a', '#5c9a5a', '#5b82bd', '#c77a9a', '#8a7457', '#7fb0a0'];

/**
 * 도구 종류별 고유 색. 테이블 위의 실물(사다리=나무, 정산=영수증, 여행=티켓, 메모판=포스트잇)을 따른다.
 * 유리 캡슐 팔레트(원목 샌드·골드 그레이·바다 청회색 틸·식물 초록). A2A 보라(#8b7bff)·A2H 주황(#ff9a3c)은 상호작용 전용이라 쓰지 않는다. 3D 소품(BoardToolProps)도 이 색을 쓴다.
 */
export const TOOL_THEME: Record<BoardToolKind, { color: string; ink: string; noun: string }> = {
  ladder: { color: '#c9a678', ink: '#2b2012', noun: '나무 사다리' },
  settlement: { color: '#b99a5b', ink: '#2b2210', noun: '영수증' },
  trip: { color: '#5f8a94', ink: '#0b1b20', noun: '여행 지도' },
  custom: { color: '#5c9a5a', ink: '#0d2010', noun: '메모지' },
};

/** 도구 색을 CSS 변수(--tool, --tool-ink)로 내려 보내는 style. 하위 버튼·막대가 var(--tool)로 받는다. */
/** 종류 색은 폴백 값이고, boardTools.css 가 --bt-c-<kind>/--bt-ink-<kind> 로 덮어쓴다. */
const themed = (kind: BoardToolKind) => `var(--bt-c-${kind}, ${TOOL_THEME[kind].color})`;
const themedInk = (kind: BoardToolKind) => `var(--bt-ink-${kind}, ${TOOL_THEME[kind].ink})`;

export const toolVars = (kind: BoardToolKind): CSSProperties =>
  ({
    '--tool': themed(kind),
    '--tool-ink': themedInk(kind),
    // 글자로 쓸 때: 밝은 배경에서도 읽히도록 전경색과 섞는다
    '--tool-text': `color-mix(in srgb, ${themed(kind)} 62%, var(--fg))`,
  }) as CSSProperties;

/** 도구 종류 아이콘을 담은 색 배지 */
export function ToolBadge({ kind, size = 28 }: { kind: BoardToolKind; size?: number }) {
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center rounded-lg shadow-sm"
      style={{ width: size, height: size, background: themed(kind), color: themedInk(kind) }}
    >
      <ToolIcon kind={kind} size={Math.round(size * 0.62)} />
    </span>
  );
}

/** 타일·배너용 종류별 작은 일러스트(인라인 SVG). 가로로 늘려 쓰므로 slice로 채운다. */
export function ToolArt({ kind }: { kind: BoardToolKind }) {
  const common = { viewBox: '0 0 160 64', preserveAspectRatio: 'xMidYMid slice', className: 'bt-art h-full w-full', 'aria-hidden': true } as const;
  if (kind === 'ladder')
    return (
      <svg {...common}>
        <rect width="160" height="64" fill="#f1ebdd" />
        <ellipse cx="80" cy="58" rx="46" ry="6" fill="#d9cdb2" opacity="0.7" />
        {[62, 98].map((x) => (
          <g key={x}>
            <rect x={x - 3.5} y="2" width="7" height="58" rx="3.5" fill="#c9a678" />
            <rect x={x - 3.5} y="2" width="2.5" height="58" rx="1.2" fill="#e8d3ae" />
          </g>
        ))}
        {[14, 28, 42, 54].map((y) => (
          <rect key={y} x="62" y={y - 2.2} width="36" height="4.4" rx="2.2" fill="#b8925f" />
        ))}
        <circle cx="62" cy="28" r="4" fill="#d0674d" stroke="#fff" strokeWidth="1.5" />
      </svg>
    );
  if (kind === 'settlement')
    return (
      <svg {...common}>
        <rect width="160" height="64" fill="#f4f1ea" />
        <path d="M52 4h56v52l-4-3-4 3-4-3-4 3-4-3-4 3-4-3-4 3-4-3-4 3-4-3-4 3z" fill="#fff" stroke="#d8d3c6" />
        <g stroke="#c9c3b2" strokeWidth="1.3" strokeLinecap="round" strokeDasharray="2 3">
          <line x1="60" x2="100" y1="20" y2="20" />
          <line x1="60" x2="100" y1="28" y2="28" />
        </g>
        <rect x="60" y="36" width="40" height="5" rx="2.5" fill="#b99a5b" opacity="0.8" />
        <circle cx="124" cy="44" r="9" fill="#e3c77d" stroke="#b99a5b" strokeWidth="1.5" />
        <circle cx="132" cy="36" r="7" fill="#efd48d" stroke="#b99a5b" strokeWidth="1.5" />
      </svg>
    );
  if (kind === 'trip')
    return (
      <svg {...common}>
        <rect width="160" height="64" fill="#e6eef0" />
        <path d="M0 44q30-18 60-4t60-10 40 4v30H0z" fill="#cfe0e3" />
        <path d="M24 48q28-26 58-12t52-24" fill="none" stroke="#5f8a94" strokeWidth="2" strokeDasharray="3 5" strokeLinecap="round" />
        <circle cx="24" cy="48" r="3.5" fill="#5f8a94" />
        <path d="M134 10c-5 0-8 3.6-8 8 0 5.6 8 14 8 14s8-8.4 8-14c0-4.4-3-8-8-8z" fill="#5f8a94" />
        <circle cx="134" cy="18" r="2.8" fill="#fff" />
      </svg>
    );
  return (
    <svg {...common}>
      <rect width="160" height="64" fill="#eef3ec" />
      <rect x="22" y="10" width="46" height="42" rx="5" fill="#fff6cf" transform="rotate(-4 45 31)" stroke="#e6d28a" />
      <rect x="80" y="8" width="52" height="44" rx="5" fill="#fff" stroke="#d3dcd0" />
      <g stroke="#c8cfc4" strokeWidth="1.6" strokeLinecap="round">
        <path d="M30 22h28M30 30h20" />
        <path d="M100 20h24M100 29h24M100 38h16" />
      </g>
      <path d="M88 19l3 3 5-6M88 28l3 3 5-6" fill="none" stroke="#5c9a5a" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** 한 줄 상태 요약 ("아직 안 뽑음" / "Bob → Alice 6,000원" / "2일 · 5곳" / "투표 3표") */
export function toolStatusLine(tool: BoardTool): string {
  switch (tool.kind) {
    case 'ladder': {
      if (!tool.run) return '아직 안 뽑음';
      return boardToolSummary(tool);
    }
    case 'settlement': {
      const r = settle(tool);
      const t = r.transfers[0];
      if (t) return `${t.from} → ${t.to} ${formatWon(t.amount)}${r.transfers.length > 1 ? ` 외 ${r.transfers.length - 1}건` : ''}`;
      return tool.expenses.length === 0 ? '지출 없음' : `총 ${formatWon(r.total)} · 정산 끝`;
    }
    case 'trip':
      return `${tool.days}일 · ${tool.items.length}곳`;
    case 'custom': {
      const votes = tool.blocks.reduce((s, b) => s + (b.type === 'vote' ? Object.keys(b.votes).length : 0), 0);
      const checks = tool.blocks.flatMap((b) => (b.type === 'checklist' ? b.items : []));
      const parts: string[] = [];
      if (votes > 0) parts.push(`투표 ${votes}표`);
      if (checks.length > 0) parts.push(`체크 ${checks.filter((c) => c.done).length}/${checks.length}`);
      return parts.length > 0 ? parts.join(' · ') : `블록 ${tool.blocks.length}개`;
    }
  }
}

/** 구경만 가능한 시점(방문자·재생·DM) 안내. 컨트롤은 각 패널이 disabled로 막는다. */
export function ViewOnlyNote({ className = '' }: { className?: string }) {
  return (
    <p data-testid="tool-viewonly" className={`flex items-center gap-1.5 text-[11px] text-muted ${className}`}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" />
        <circle cx="12" cy="12" r="3" />
      </svg>
      보기만 할 수 있어요
    </p>
  );
}

/**
 * 도구 편집 UI를 보여 줄지. 서버가 최종 판단하지만(403) 방문자·재생 중에는 컨트롤을 비활성화한다.
 * shared 권한 표의 board_tools capability를 쓴다(My 소유자·Our 구성원만 해당, 방문자·DM은 아님).
 */
export function canEditTools(m: RoomModel): boolean {
  if (m.replaying) return false;
  const relation = m.room.kind === 'my' ? (m.room.ownerId === m.meId ? 'owner' : null) : 'member';
  if (!relation || !can({ kind: 'human', relation, roomKind: m.room.kind }, 'board_tools')) return false;
  const me = m.state.members[m.meId];
  return !(me && !me.present);
}

export function ToolIcon({ kind, size = 18 }: { kind: BoardToolKind; size?: number }) {
  const common = {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
    'data-tool-icon': kind,
  };
  if (kind === 'ladder')
    return (
      <svg {...common}>
        <path d="M7 3v18M17 3v18M7 8h10M7 13h10M7 18h10" />
      </svg>
    );
  if (kind === 'settlement')
    return (
      <svg {...common}>
        <circle cx="9" cy="9" r="5" />
        <path d="M9 7v4M7.5 9h3" />
        <path d="M14 13.5c3 .3 5 1.6 5 3.5 0 2-2.7 3.5-6 3.5-1.6 0-3-.3-4-.9" />
      </svg>
    );
  if (kind === 'custom')
    return (
      <svg {...common}>
        <rect x="5" y="4" width="14" height="17" rx="2" />
        <path d="M9 4V3h6v1M8.5 10l1.5 1.5L12.5 9M8.5 16l1.5 1.5 2.5-2.5M14.5 10.5H16M14.5 16.5H16" />
      </svg>
    );
  return (
    <svg {...common}>
      <path d="M3 6l6-2 6 2 6-2v14l-6 2-6-2-6 2z" />
      <path d="M9 4v14M15 6v14" />
    </svg>
  );
}

/** 커버 이미지를 가진(가질 수 있는) 도구 종류인가 */
export const hasCover = (tool: BoardTool): boolean => COVER_KINDS.includes(tool.kind);

/**
 * 도구 커버. 기본은 종류별 일러스트(ToolIcon). 서버가 이미지를 만들어 붙이면(cover.status 'ready') 이벤트로 자동 교체된다.
 * 생성 중(pending)에는 기본 일러스트 위에 은은한 표시만 한다. 실패·로딩 오류는 조용히 기본 일러스트를 유지한다.
 */
export function ToolCover({ tool, height = 72 }: { tool: BoardTool; height?: number }) {
  const assetId = tool.cover?.status === 'ready' ? tool.cover.assetId : null;
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setSrc(null);
    if (assetId) fetchMediaUrl(assetId).then((u) => alive && setSrc(u), () => undefined);
    return () => {
      alive = false;
    };
  }, [assetId]);
  if (!hasCover(tool)) return null;
  const pending = tool.cover?.status === 'pending';
  return (
    <div
      data-testid="tool-cover"
      data-cover-state={src ? 'image' : pending ? 'pending' : 'default'}
      className="relative flex w-full items-center justify-center overflow-hidden rounded-lg tw-track text-muted"
      style={{ height }}
    >
      {src ? (
        <img src={src} alt="" className="h-full w-full object-cover" draggable={false} />
      ) : (
        <>
          <ToolArt kind={tool.kind} />
          {pending && (
            <span data-testid="tool-cover-pending" className="absolute bottom-1 right-1.5 animate-pulse text-[10px] text-muted/80">
              이미지 생성 중…
            </span>
          )}
        </>
      )}
    </div>
  );
}

/** 만든 주체 표시: Agent는 아바타+이름표, 사람은 색 점+이름 */
export function ToolCreator({ tool, m, compact = false, made = false }: { tool: BoardTool; m: RoomModel; compact?: boolean; made?: boolean }) {
  const { kind, id } = tool.createdBy;
  if (kind === 'agent' || kind === 'room_agent') {
    const a = m.resolveAgent(id, kind);
    return (
      <span data-testid="tool-creator" data-creator-kind={kind} className="inline-flex items-center gap-1.5 text-[11px] text-muted">
        <AgentAvatar variant={a.variant} color={a.color} size={compact ? 18 : 22} name={a.name} room={kind === 'room_agent'} />
        {made ? (
          <span>
            <span style={{ color: `color-mix(in srgb, ${a.color} 55%, var(--fg))` }}>{a.name}</span>가 만듦
          </span>
        ) : (
          <>
            <span style={{ color: a.color }}>{a.name}</span>
            <AgentTag color={a.color} room={kind === 'room_agent'} />
          </>
        )}
      </span>
    );
  }
  if (kind === 'human') {
    const u = m.users[id ?? ''];
    return (
      <span data-testid="tool-creator" data-creator-kind="human" className="inline-flex items-center gap-1.5 text-[11px] text-muted">
        <Avatar name={u?.name ?? '누군가'} color={u?.color ?? FALLBACK_COLOR} size={compact ? 16 : 20} />
        <span>{u?.name ?? '누군가'}{made ? '님이 만듦' : ''}</span>
      </span>
    );
  }
  return (
    <span data-testid="tool-creator" data-creator-kind="system" className="text-[11px] text-muted">
      시스템
    </span>
  );
}

/**
 * 도구 op 호출 훅. 낙관적 업데이트는 없다: 요청 중엔 busy(버튼 비활성), 결과는 WS 이벤트로 도착한다.
 * `quiet`에 든 오류 코드는 메시지를 띄우지 않는다(예: 동시 실행의 already_ran → 최신 결과가 곧 보인다).
 */
export function useToolOp(roomId: string, toolId: string) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(
    async (op: BoardToolOpRequest['op'], quiet: readonly string[] = []): Promise<boolean> => {
      setBusy(true);
      setError(null);
      try {
        await api.boardToolOp(roomId, toolId, { op });
        return true;
      } catch (e) {
        const code = (e as { code?: string }).code;
        if (!(code && quiet.includes(code))) setError(boardToolErrorText(e));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [roomId, toolId],
  );
  return { busy, error, run, clearError: () => setError(null) };
}

export function ToolError({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p role="alert" data-testid="tool-error" className="mt-2 text-[11px] text-red-500">
      {message}
    </p>
  );
}

export const toolInput =
  'tw-inset rounded-lg border border-line px-2.5 py-1 text-sm placeholder:text-muted focus-visible:border-[var(--tool,var(--focus))] disabled:opacity-50';
export const toolBtn =
  'tw-inset rounded-lg border border-line px-3 py-1 text-xs transition-colors hover:border-[var(--tool,var(--line))] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-line';
export const toolBtnPrimary =
  'rounded-lg bg-[var(--tool,var(--fg))] px-3.5 py-1 text-xs font-bold text-[var(--tool-ink,var(--bg))] shadow-sm transition-[filter] hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40';
