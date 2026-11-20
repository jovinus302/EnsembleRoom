import { useEffect, useRef, useState } from 'react';
import { BOARD_TOOL_LIMITS, ladderTrace, padOutcomes, type LadderRung, type LadderTool } from '@ensemble/shared';
import { TOOL_COLORS, ToolError, ViewOnlyNote, toolBtn, toolBtnPrimary, toolInput, useToolOp } from './common';

const GEO = { colW: 70, padX: 40, top: 34, rowH: 26, bottom: 34 };
const ANIM_MS = 2400;

/** SVG 좌표 계산 (순수 함수: 테스트 대상) */
export function ladderLayout(n: number, rows: number) {
  const width = GEO.padX * 2 + GEO.colW * Math.max(0, n - 1);
  const height = GEO.top + GEO.rowH * rows + GEO.bottom;
  return {
    width,
    height,
    x: (col: number) => GEO.padX + col * GEO.colW,
    y: (row: number) => GEO.top + row * GEO.rowH,
  };
}

/** start 열 참가자의 경로를 SVG polyline points 문자열로 */
export function ladderPathPoints(n: number, rungs: readonly LadderRung[], rows: number, start: number): string {
  const lay = ladderLayout(n, rows);
  return ladderTrace(n, rungs, rows, start)
    .map((p) => `${lay.x(p.col)},${lay.y(p.y)}`)
    .join(' ');
}

/** 꺾인 선(points)을 진행도 t(0~1)만큼 따라간 지점 */
function pointAlong(pts: readonly { x: number; y: number }[], t: number): { x: number; y: number } {
  let total = 0;
  for (let i = 1; i < pts.length; i++) total += Math.hypot(pts[i]!.x - pts[i - 1]!.x, pts[i]!.y - pts[i - 1]!.y);
  let left = t * total;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!;
    const b = pts[i]!;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (left <= len && len > 0) return { x: a.x + ((b.x - a.x) * left) / len, y: a.y + ((b.y - a.y) * left) / len };
    left -= len;
  }
  return pts[pts.length - 1] ?? { x: 0, y: 0 };
}

const clip = (x: string, n = 6) => (x.length > n ? `${x.slice(0, n - 1)}…` : x);

function usePrefersReducedMotion(): boolean {
  const [r, setR] = useState(() => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches);
  useEffect(() => {
    if (typeof matchMedia === 'undefined') return;
    const mq = matchMedia('(prefers-reduced-motion: reduce)');
    const on = () => setR(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return r;
}

const split = (s: string) =>
  s
    .split(/[,\n]/)
    .map((x) => x.trim())
    .filter(Boolean);

function EditForm({ tool, roomId }: { tool: LadderTool; roomId: string }) {
  const [people, setPeople] = useState(tool.participants.join(', '));
  const [outs, setOuts] = useState(tool.outcomes.join(', '));
  const { busy, error, run } = useToolOp(roomId, tool.toolId);
  const p = split(people);
  const o = split(outs);
  const L = BOARD_TOOL_LIMITS;
  const valid = p.length >= 2 && p.length <= L.participants && o.length >= 1 && o.length <= L.outcomes && [...p, ...o].every((x) => x.length <= 40);
  return (
    <form
      data-testid="ladder-edit"
      className="tg-card mt-3 flex flex-col gap-1.5 p-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) void run({ op: 'ladder_set', participants: p, outcomes: o });
      }}
    >
      <label className="text-label text-muted">
        참가자 (쉼표로 구분, 2~{L.participants}명)
        <input aria-label="참가자" value={people} onChange={(e) => setPeople(e.target.value)} className={`${toolInput} mt-0.5 w-full`} />
      </label>
      <label className="text-label text-muted">
        결과 (쉼표로 구분, 모자라면 &lsquo;꽝&rsquo;으로 채워요)
        <input aria-label="결과" value={outs} onChange={(e) => setOuts(e.target.value)} className={`${toolInput} mt-0.5 w-full`} />
      </label>
      <div>
        <button type="submit" disabled={busy || !valid} className={toolBtn}>
          참가자·결과 저장
        </button>
      </div>
      <ToolError message={error} />
    </form>
  );
}

/**
 * 사다리타기 패널. 가로줄은 실행 전엔 없다(서버가 실행 시 seed로 만들고 `run.rungs`에 담긴다).
 * 애니메이션은 "이 패널이 열려 있는 동안 run이 새로 도착했을 때"만 — 재진입·재생에서는 정지 상태로 결과를 보여 준다.
 */
export function LadderPanel({ tool, roomId, canEdit, reducedMotion }: { tool: LadderTool; roomId: string; canEdit: boolean; reducedMotion?: boolean }) {
  const prefers = usePrefersReducedMotion();
  const noMotion = reducedMotion ?? prefers;
  const n = tool.participants.length;
  const rows = BOARD_TOOL_LIMITS.ladderRows;
  const run = tool.run;
  const { busy, error, run: doOp } = useToolOp(roomId, tool.toolId);
  const [selected, setSelected] = useState<number | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const seen = useRef<number | null>(run?.seq ?? null);

  const runSeq = run?.seq ?? null;
  useEffect(() => {
    if (runSeq === null) {
      seen.current = null;
      setProgress(null);
      return;
    }
    if (seen.current === runSeq) return;
    seen.current = runSeq;
    if (noMotion) return;
    let raf = 0;
    const t0 = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - t0) / ANIM_MS);
      setProgress(t);
      if (t < 1) raf = requestAnimationFrame(step);
      else setProgress(null);
    };
    setProgress(0);
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [runSeq, noMotion]);

  const animating = progress !== null;
  const lay = ladderLayout(n, rows);
  const outcomes = padOutcomes(tool.outcomes, n);
  const results = run ? tool.participants.map((name, i) => ({ name, outcome: outcomes[run.result[i] ?? 0] ?? '', color: TOOL_COLORS[i % TOOL_COLORS.length]! })) : [];
  const shownIdx = (i: number) => selected === null || selected === i;
  const wonCols = new Set(run ? run.result.filter((_, i) => i < n).filter((r) => outcomes[r] !== '꽝') : []);
  const rail = (key: string, x1: number, x2: number, y1: number, y2: number, w: number) => (
    <g key={key}>
      <line x1={x1} x2={x2} y1={y1} y2={y2} strokeWidth={w + 2} strokeLinecap="round" style={{ stroke: 'var(--bt-wood-edge)' }} />
      <line x1={x1} x2={x2} y1={y1} y2={y2} strokeWidth={w} strokeLinecap="round" style={{ stroke: 'var(--bt-wood-1)' }} />
    </g>
  );

  return (
    <div data-testid="ladder-panel" data-ran={run ? 'true' : 'false'} data-animating={animating ? 'true' : 'false'}>
      <div
        className="bt-sand mt-3 overflow-x-auto rounded-xl border px-2 py-1"
        
      >
        <svg
          role="img"
          aria-label="사다리"
          viewBox={`0 0 ${lay.width} ${lay.height}`}
          width={lay.width}
          height={lay.height}
          className="mx-auto block max-w-full"
        >
          {tool.participants.map((_, i) => rail(`v${i}`, lay.x(i), lay.x(i), lay.y(0), lay.y(rows), 5))}
          {run?.rungs.map((r) => (
            <g key={`r${r.row}-${r.col}`} data-testid="ladder-rung">
              <line x1={lay.x(r.col)} x2={lay.x(r.col + 1)} y1={lay.y(r.row + 0.5)} y2={lay.y(r.row + 0.5)} strokeWidth={6} strokeLinecap="round" style={{ stroke: 'var(--bt-wood-edge)' }} />
              <line x1={lay.x(r.col)} x2={lay.x(r.col + 1)} y1={lay.y(r.row + 0.5)} y2={lay.y(r.row + 0.5)} strokeWidth={4} strokeLinecap="round" style={{ stroke: 'var(--bt-wood-1)' }} />
            </g>
          ))}
          {!run && (
            <g>
              <rect x={lay.width / 2 - 78} y={lay.y(rows / 2) - 14} width={156} height={28} rx={14} strokeDasharray="4 3" style={{ fill: 'var(--bt-hint-bg)', stroke: 'var(--bt-hint-bd)' }} />
              <text x={lay.width / 2} y={lay.y(rows / 2) + 4} textAnchor="middle" fontSize={12} style={{ fill: 'var(--bt-hint-ink)' }}>
                가로줄은 실행할 때 정해져요
              </text>
            </g>
          )}
          {run &&
            tool.participants.map((_, i) => (
              <g key={`p${i}`}>
              <polyline
                points={ladderPathPoints(n, run.rungs, rows, i)}
                fill="none"
                strokeWidth={selected === i ? 8 : 7}
                style={{ stroke: 'var(--fg)' }}
                strokeLinecap="round"
                strokeLinejoin="round"
                pathLength={1}
                strokeDasharray={1}
                strokeDashoffset={animating ? 1 - progress : 0}
                opacity={shownIdx(i) ? 0.22 : 0.04}
              />
              <polyline
                data-testid="ladder-path"
                data-selected={selected === i ? 'true' : 'false'}
                points={ladderPathPoints(n, run.rungs, rows, i)}
                fill="none"
                stroke={TOOL_COLORS[i % TOOL_COLORS.length]}
                strokeWidth={selected === i ? 5 : 4}
                strokeLinecap="round"
                strokeLinejoin="round"
                pathLength={1}
                strokeDasharray={1}
                strokeDashoffset={animating ? 1 - progress : 0}
                opacity={shownIdx(i) ? 0.95 : 0.12}
              />
              </g>
            ))}
          {run &&
            animating &&
            tool.participants.map((_, i) => {
              const pts = ladderTrace(n, run.rungs, rows, i).map((q) => ({ x: lay.x(q.col), y: lay.y(q.y) }));
              const at = pointAlong(pts, progress);
              return (
                <circle key={`t${i}`} cx={at.x} cy={at.y} r={6} fill={TOOL_COLORS[i % TOOL_COLORS.length]} strokeWidth={2} style={{ stroke: 'var(--bt-pill)' }} opacity={shownIdx(i) ? 1 : 0.2} />
              );
            })}
          {tool.participants.map((name, i) => {
            const c = run ? TOOL_COLORS[i % TOOL_COLORS.length]! : 'var(--muted)';
            return (
              <g key={`n${i}`} style={{ cursor: run ? 'pointer' : 'default' }} onClick={() => run && setSelected((s) => (s === i ? null : i))}>
                <rect x={lay.x(i) - 28} y={lay.y(0) - 31} width={56} height={22} rx={11} strokeWidth={selected === i ? 3 : 2} style={{ fill: 'var(--bt-pill)', stroke: c }} />
                <text x={lay.x(i)} y={lay.y(0) - 16} textAnchor="middle" fontSize={12} fontWeight={700} style={{ fill: 'var(--bt-pill-ink)' }}>
                  {clip(name)}
                </text>
              </g>
            );
          })}
          {outcomes.map((o, i) => {
            const won = !!run && wonCols.has(i) && !animating;
            const dim = !!run && !won && !animating;
            return (
              <g key={`o${i}`}>
                <rect
                  x={lay.x(i) - 29}
                  y={lay.y(rows) + 8}
                  width={58}
                  height={22}
                  rx={6}
                  strokeWidth={won ? 1.5 : 1}
                  style={{
                    fill: won ? 'var(--bt-win-fill)' : 'var(--bt-out)',
                    stroke: won ? 'var(--bt-win-bd)' : 'var(--bt-out-bd)',
                    filter: won ? 'drop-shadow(0 0 7px var(--bt-glow)) drop-shadow(0 0 2px var(--bt-win-bd))' : undefined,
                  }}
                />
                <text x={lay.x(i)} y={lay.y(rows) + 23} textAnchor="middle" fontSize={12} fontWeight={won ? 800 : 600} style={{ fill: won ? 'var(--bt-win-ink)' : dim ? 'var(--bt-out-dim)' : 'var(--bt-out-ink)' }}>
                  {clip(o)}
                </text>
              </g>
            );
          })}
        </svg>
      </div>

      {run && !animating && (
        <ul data-testid="ladder-results" className="mt-2.5 grid grid-cols-1 gap-1.5 text-body sm:grid-cols-2">
          {results.map((r, i) => {
            const nothing = r.outcome === '꽝';
            return (
              <li
                key={i}
                className="flex min-w-0 items-center gap-2 rounded-card border px-2.5 py-1.5"
                style={{
                  borderColor: nothing ? 'var(--line)' : 'color-mix(in srgb, var(--tool) 65%, transparent)',
                  background: nothing ? 'transparent' : 'color-mix(in srgb, var(--tool) 14%, transparent)',
                }}
              >
                <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: r.color }} />
                <span className="truncate font-medium">{r.name}</span>
                <span className="text-muted">→</span>
                <span className={`min-w-0 truncate ${nothing ? 'text-muted' : 'font-bold'}`}>{r.outcome}</span>
                {!nothing && <span aria-hidden className="ml-auto text-[var(--tool)]">★</span>}
              </li>
            );
          })}
        </ul>
      )}
      {animating && <p className="mt-2 text-center text-aux text-muted">사다리를 타는 중…</p>}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {!run && (
          <button
            type="button"
            data-testid="ladder-run"
            disabled={!canEdit || busy || n < 2}
            title={canEdit ? undefined : '구성원만 실행할 수 있어요'}
            onClick={() => void doOp({ op: 'ladder_run' }, ['already_ran'])}
            className={toolBtnPrimary}
          >
            사다리 타기
          </button>
        )}
        {run && (
          <button
            type="button"
            data-testid="ladder-reset"
            disabled={!canEdit || busy || animating}
            title={canEdit ? undefined : '구성원만 다시 할 수 있어요'}
            onClick={() => void doOp({ op: 'ladder_reset' }, ['not_ran'])}
            className={toolBtn}
          >
            다시 하기
          </button>
        )}
        {!canEdit && <ViewOnlyNote />}
      </div>
      <ToolError message={error} />
      {canEdit && !run && <EditForm key={`${tool.rev}`} tool={tool} roomId={roomId} />}
    </div>
  );
}
