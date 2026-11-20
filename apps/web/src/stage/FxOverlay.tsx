import { useEffect, useMemo, useRef, useState } from 'react';
import { ourColor } from '@ensemble/shared';
import { onFx, type FxEvent } from '../fx/fxStore';
import { useSession } from '../store/session';
import { useWorld } from '../store/worldStore';
import { useRect } from './WorldHost';
import { useStage } from './stageStore';

/**
 * DOM 피드백 오버레이 (S19a/c). 3D가 덮이지 않는 곳(패널 위, 토스트, Lottie)에서 같은 fxStore 사건에 반응한다.
 * 모두 pointer-events: none이라 입력을 막지 않고, 각 장면은 1~2.6초 안에 끝난다.
 * Lottie는 DOM 오버레이 전용(8.4): lime-notify = 승인 토스트, duo-highfive = 합의, lime-jump-yaw = 승인 완료.
 */

type LottieName = 'lime-notify' | 'lime-jump-yaw' | 'duo-highfive';

const LOTTIE_FRAMES: Record<LottieName, { total: number; fps: number }> = {
  'lime-notify': { total: 420, fps: 60 },
  'lime-jump-yaw': { total: 420, fps: 60 },
  'duo-highfive': { total: 480, fps: 60 },
};

/** lottie-web은 첫 사용 때만 로드한다(별도 청크). 에셋은 로컬 /assets/lottie */
export function LottieMoment({ name, size, durationMs, className }: { name: LottieName; size: number; durationMs: number; className?: string }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let anim: { destroy: () => void } | null = null;
    let dead = false;
    void import('lottie-web/build/player/lottie_light').then((m) => {
      if (dead || !host.current) return;
      const lottie = m.default;
      const meta = LOTTIE_FRAMES[name];
      const a = lottie.loadAnimation({
        container: host.current,
        renderer: 'svg',
        loop: false,
        autoplay: true,
        path: `/assets/lottie/${name}.json`,
        rendererSettings: { preserveAspectRatio: 'xMidYMid meet' },
      });
      // 원본이 7~8초라 지정 시간에 맞춰 배속 재생한다
      a.setSpeed(Math.max(1, meta.total / meta.fps / (durationMs / 1000)));
      anim = a;
    });
    return () => {
      dead = true;
      anim?.destroy();
    };
  }, [name, durationMs]);
  return <div ref={host} aria-hidden="true" data-lottie={name} className={className} style={{ width: size, height: size }} />;
}

interface Moment {
  id: number;
  kind: FxEvent['kind'];
  at: number;
  ev: FxEvent;
  ttl: number;
}

const OUTCOME_LABEL: Record<string, string> = { approved: '승인됐어요', edited: '수정안이 반영됐어요', rejected: '거절됐어요' };

export function FxOverlay() {
  const [moments, setMoments] = useState<Moment[]>([]);
  const [ripples, setRipples] = useState<{ id: number; x: number; y: number; color: string; gain: number }[]>([]);
  const meId = useSession((s) => s.user?.id);
  const users = useWorld((s) => s.users);
  const rooms = useWorld((s) => s.rooms);
  const refs = useRef({ meId, users, rooms });
  refs.current = { meId, users, rooms };

  useEffect(() => {
    const add = (ev: FxEvent, ttl: number) => {
      setMoments((m) => [...m.filter((x) => x.at > performance.now() - 6000).slice(-3), { id: ev.id, kind: ev.kind, at: performance.now(), ev, ttl }]);
      setTimeout(() => setMoments((m) => m.filter((x) => x.id !== ev.id)), ttl);
    };
    return onFx((ev) => {
      switch (ev.kind) {
        case 'approval_requested':
          add(ev, 2600);
          break;
        case 'approval_resolved':
          add(ev, 2000);
          break;
        case 'agreement':
          add(ev, 2300);
          break;
        case 'visit_accept':
        case 'visit_end':
        case 'leave':
        case 'rejoin':
        case 'error':
        case 'agent_paused':
        case 'visit_request':
          add(ev, 2200);
          break;
        case 'click': {
          if (!ev.screen) break;
          const id = ev.id;
          const color = refs.current.meId ? (refs.current.users[refs.current.meId]?.color ?? '#ff8f7a') : '#ff8f7a';
          setRipples((r) => [...r.slice(-4), { id, x: ev.screen![0], y: ev.screen![1], color, gain: ev.gain }]);
          setTimeout(() => setRipples((r) => r.filter((x) => x.id !== id)), 650);
          break;
        }
        default:
          break;
      }
    });
  }, []);

  const hero = moments.filter((m) => m.kind === 'agreement' || m.kind === 'approval_requested' || m.kind === 'approval_resolved');
  const toasts = moments.filter((m) => !hero.includes(m));
  const agreement = hero.find((m) => m.kind === 'agreement');
  const agreeColor = useMemo(() => {
    const cols = agreement?.ev.colors;
    return cols && cols.length ? ourColor(cols) : '#c9a7ff';
  }, [agreement]);
  const approvalReq = hero.find((m) => m.kind === 'approval_requested');
  const approvalRes = hero.find((m) => m.kind === 'approval_resolved');
  const label = (m: Moment): string => {
    const roomTitle = (id?: string | null) => (id ? (refs.current.rooms[id]?.title ?? '') : '');
    switch (m.kind) {
      case 'visit_accept':
        return '방문이 수락됐어요 · 유리가 맑아집니다';
      case 'visit_end':
        return '방문이 끝났어요 · 서리가 다시 낍니다';
      case 'visit_request':
        return m.ev.mine ? '방문 요청을 보냈어요' : '방문 요청이 도착했어요';
      case 'leave':
        return m.ev.mine ? '자리를 비웠어요 · Agent가 자리를 맡습니다' : `${roomTitle(m.ev.roomId) || '구성원'}이 자리를 비웠어요 · Agent가 자리를 맡습니다`;
      case 'rejoin':
        return m.ev.count ? `놓친 변화 ${m.ev.count}건이 흘러 들어와요` : '돌아왔어요';
      case 'agent_paused':
        return 'Agent가 잠시 멈췄어요';
      case 'error':
        return '문제가 생겼어요';
      default:
        return '';
    }
  };

  return (
    <div aria-hidden="true" data-testid="fx-overlay" className="pointer-events-none fixed inset-0 z-40 overflow-hidden">
      {/* L1 승인 요청: 화면 가장자리 오렌지 맥동 + lime-notify + 토스트 */}
      {approvalReq ? (
        <>
          <div key={`edge${approvalReq.id}`} className="fx-edge-pulse absolute inset-0" style={{ boxShadow: 'inset 0 0 120px 10px rgba(255,138,61,0.55)' }} />
          <div key={`ap${approvalReq.id}`} data-testid="fx-approval-toast" className="fx-pop absolute left-1/2 top-16 flex -translate-x-1/2 items-center gap-2 rounded-full border border-[#ff8a3d]/70 bg-[#2b1708]/90 py-1 pl-1 pr-4 text-sm text-[#ffd9b3] shadow-[0_0_30px_rgba(255,138,61,0.5)]">
            <LottieMoment name="lime-notify" size={64} durationMs={2300} />
            <span>
              승인 요청{approvalReq.ev.involvesMe ? ' · 내 결정이 필요해요' : ''}
              {approvalReq.ev.text ? <span className="ml-2 text-[#ffb98a]">{approvalReq.ev.text.slice(0, 28)}</span> : null}
            </span>
          </div>
        </>
      ) : null}
      {approvalRes ? (
        <div key={`res${approvalRes.id}`} data-testid="fx-approval-result" className="fx-pop absolute left-1/2 top-16 flex -translate-x-1/2 items-center gap-2 rounded-full border border-[#ffd36a]/60 bg-[#241b08]/90 py-1 pl-1 pr-4 text-sm text-[#ffe6a8]">
          {approvalRes.ev.outcome === 'approved' ? <LottieMoment name="lime-jump-yaw" size={64} durationMs={1800} /> : <span className="w-3" />}
          <span>{OUTCOME_LABEL[approvalRes.ev.outcome ?? 'approved'] ?? '처리됐어요'}</span>
        </div>
      ) : null}
      {/* L1 합의: 우리 색 방사 + duo-highfive */}
      {agreement ? (
        <div key={`ag${agreement.id}`} data-testid="fx-agreement" className="absolute inset-0 flex flex-col items-center justify-center">
          <div className="fx-agree-bloom absolute inset-0" style={{ background: `radial-gradient(circle at 50% 46%, ${agreeColor}aa 0%, ${agreeColor}33 28%, transparent 60%)` }} />
          <div className="fx-pop relative flex flex-col items-center">
            <LottieMoment name="duo-highfive" size={240} durationMs={2000} />
            <div className="-mt-6 rounded-full px-4 py-1 text-base font-semibold text-white" style={{ background: `${agreeColor}dd`, boxShadow: `0 0 36px ${agreeColor}` }}>
              우리가 합의했어요
            </div>
          </div>
        </div>
      ) : null}
      {/* L2 토스트 */}
      <div className="absolute bottom-24 left-1/2 flex -translate-x-1/2 flex-col items-center gap-2">
        {toasts.map((m) => {
          const text = label(m);
          return text ? (
            <div
              key={m.id}
              data-testid={`fx-toast-${m.kind}`}
              className="fx-pop rounded-full border border-white/20 bg-black/65 px-4 py-1.5 text-sm text-white backdrop-blur"
              style={m.ev.color ? { boxShadow: `0 0 18px ${m.ev.color}88`, borderColor: `${m.ev.color}aa` } : undefined}
            >
              {text}
            </div>
          ) : null;
        })}
      </div>
      {/* L3 클릭 파문(패널 위에서도 보인다) */}
      {ripples.map((r) => (
        <span
          key={r.id}
          className="fx-ripple absolute rounded-full"
          style={{ left: r.x, top: r.y, borderColor: r.color, boxShadow: `0 0 14px ${r.color}`, opacity: r.gain }}
        />
      ))}
    </div>
  );
}

/** 나·상대·우리 범례: 월드의 색 규칙을 한눈에 (8.3). 3D 창 왼쪽 아래 */
export function WorldLegend() {
  const meId = useSession((s) => s.user?.id);
  const users = useWorld((s) => s.users);
  const rooms = useWorld((s) => s.rooms);
  const slotRect = useRect(useStage((s) => s.slotEl));
  const webgl = useStage((s) => s.webgl);
  const quality = useStage((s) => s.quality);
  if (!meId || !users[meId] || webgl !== 'ok' || quality === 'off') return null;
  const me = users[meId]!.color;
  const others = Object.values(users).filter((u) => u.id !== meId);
  // 내가 속한 Our 중 첫 번째의 혼합색(없으면 나+상대 혼합)
  const ours = Object.values(rooms).find((r) => r.kind === 'our' && r.memberIds.includes(meId));
  const oursColor = ours ? ourColor(ours.memberIds.map((m) => users[m]?.color).filter((c): c is string => !!c)) : ourColor([me, others[0]?.color ?? me]);
  const pos: React.CSSProperties = slotRect ? { left: slotRect.left + 8, top: slotRect.top + slotRect.height - 8, transform: 'translateY(-100%)' } : { left: 8, bottom: 40 };
  const dot = (c: string, extra?: React.CSSProperties) => <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: c, boxShadow: `0 0 8px ${c}`, ...extra }} />;
  return (
    <div
      role="group"
      aria-label="색 범례"
      data-testid="world-legend"
      className="fixed z-30 flex items-center gap-3 rounded-full border border-line bg-panel px-3 py-1 text-[11px] text-muted backdrop-blur"
      style={pos}
    >
      <span className="flex items-center gap-1.5">
        {dot(me)} <span className="text-fg">나</span>
      </span>
      <span className="flex items-center gap-1.5">
        {others.slice(0, 3).map((u) => (
          <span key={u.id}>{dot(u.color)}</span>
        ))}
        <span className="text-fg">상대</span>
      </span>
      <span className="flex items-center gap-1.5">
        {dot(`linear-gradient(135deg, ${me}, ${others[0]?.color ?? me})`, { background: `linear-gradient(135deg, ${me}, ${others[0]?.color ?? me})`, boxShadow: `0 0 8px ${oursColor}` })}
        <span className="text-fg">우리</span>
        <span className="opacity-70">(섞인 색)</span>
      </span>
    </div>
  );
}
