import { useEffect, useState, type ReactNode } from 'react';
import type { MetricsCounters, MetricsResponse, RoomMetrics } from '@ensemble/shared';
import { ApiError, getMetrics } from '../api/client';
import { navigate } from '../router';

/* 지표 화면 (S20). 서버가 요청자에게 보이는 이벤트만 센 값을 그대로 보여 준다. */

const pct = (v: number | null): string => (v === null ? '-' : `${Math.min(100, Math.round(v * 100))}%`);
const secs = (ms: number | null): string => (ms === null ? '-' : `${(ms / 1000).toFixed(1)}초`);

const KIND_LABEL: Record<string, string> = {
  edit: '수정 승인',
  decision: '결정 승인',
  visit: '방문 승인',
  takeout: '가져가기 승인',
};

function Card({ label, value, sub, testId }: { label: string; value: string | number; sub?: string; testId?: string }) {
  return (
    <div className="rounded-xl border border-line bg-panel px-4 py-3 backdrop-blur-md" data-testid={testId}>
      <div className="text-xs text-muted">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
      {sub && <div className="mt-0.5 text-xs text-muted">{sub}</div>}
    </div>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-6" aria-label={title}>
      <h2 className="mb-2 text-sm font-medium text-muted">{title}</h2>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">{children}</div>
    </section>
  );
}

function TotalsCards({ t, repeatRate, active }: { t: MetricsCounters; repeatRate: number | null; active: number }) {
  const byKind = Object.entries(t.approvals.byKind);
  return (
    <div data-testid="metrics-totals">
      <Group title="Agent">
        <Card label="Agent 턴 시작" value={t.agentTurns.started} />
        <Card label="행동한 턴" value={t.agentTurns.acted} sub={`넘김 ${t.agentTurns.pass}`} />
        <Card label="오류로 끝난 턴" value={t.agentTurns.error} />
        <Card label="연쇄 상한으로 멈춤" value={t.agentTurns.paused} />
      </Group>
      <Group title="방문">
        <Card label="방문 요청" value={t.visits.requested} sub={`사람 ${t.visits.humanRequested} · Agent ${t.visits.agentSent}`} />
        <Card label="수락률" value={pct(t.visits.acceptRate)} sub={`수락 ${t.visits.accepted} · 거절 ${t.visits.declined}`} />
        <Card label="방문 종료" value={t.visits.ended} />
        <Card label="가져가기(takeout)" value={t.visits.takeouts} sub={`생성률 ${pct(t.visits.takeoutRate)}`} />
      </Group>
      <Group title="Leave · Rejoin">
        <Card label="명시 Leave" value={t.presence.leavesExplicit} sub={`암묵 ${t.presence.leavesImplicit}`} />
        <Card label="위임 실행률" value={pct(t.presence.mandateRate)} sub={`위임 ${t.presence.leavesWithMandate}건`} />
        <Card label="재합류율" value={pct(t.presence.rejoinRate)} sub={`Rejoin ${t.presence.rejoins}회`} />
        <Card label="놓친 변화" value={t.presence.missedChanges} sub={`다이제스트 열람 ${t.presence.digestViewed}`} />
      </Group>
      <Group title="승인">
        <Card label="승인 요청" value={t.approvals.requested} sub={`해소 ${t.approvals.resolved} · 대기 ${t.approvals.pending}`} />
        <Card label="승인 비율" value={pct(t.approvals.approvedRate)} sub={`${t.approvals.approved}건`} />
        <Card label="수정 승인 비율" value={pct(t.approvals.editedRate)} sub={`${t.approvals.edited}건`} />
        <Card label="거절 비율" value={pct(t.approvals.rejectedRate)} sub={`${t.approvals.rejected}건`} />
        <Card label="평균 해소 시간" value={secs(t.approvals.avgResolveMs)} testId="metrics-avg-resolve" />
        {byKind.map(([k, n]) => (
          <Card key={k} label={KIND_LABEL[k] ?? k} value={n} sub="종류별 요청 수" />
        ))}
      </Group>
      <Group title="Room">
        <Card label="합의" value={t.agreements} />
        <Card label="유지된 기억" value={t.memoryRetained} />
        <Card label="활동한 Room" value={active} />
        <Card label="반복 사용률" value={pct(repeatRate)} />
      </Group>
    </div>
  );
}

const KIND_ROOM: Record<string, string> = { my: '나', our: '우리', dm: '사람' };

function RoomTable({ rows }: { rows: RoomMetrics[] }) {
  return (
    <section className="mt-8 pb-10" aria-label="Room별">
      <h2 className="mb-2 text-sm font-medium text-muted">Room별</h2>
      <div className="overflow-x-auto rounded-xl border border-line bg-panel backdrop-blur-md">
        <table className="w-full min-w-[760px] text-left text-sm" data-testid="metrics-rooms">
          <thead className="text-xs text-muted">
            <tr className="border-b border-line">
              <th className="px-3 py-2 font-medium">Room</th>
              <th className="px-3 py-2 font-medium">종류</th>
              <th className="px-3 py-2 text-right font-medium">Agent 턴</th>
              <th className="px-3 py-2 text-right font-medium">방문 요청</th>
              <th className="px-3 py-2 text-right font-medium">수락률</th>
              <th className="px-3 py-2 text-right font-medium">Leave</th>
              <th className="px-3 py-2 text-right font-medium">재합류율</th>
              <th className="px-3 py-2 text-right font-medium">승인 요청</th>
              <th className="px-3 py-2 text-right font-medium">승인/수정/거절</th>
              <th className="px-3 py-2 text-right font-medium">평균 해소</th>
              <th className="px-3 py-2 text-right font-medium">합의</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={11} className="px-3 py-4 text-center text-muted">
                  아직 보이는 Room 활동이 없어요.
                </td>
              </tr>
            )}
            {rows.map((r) => (
              <tr key={r.roomId} className="border-b border-line/50 last:border-0">
                <td className="px-3 py-2">{r.title}</td>
                <td className="px-3 py-2 text-muted">{KIND_ROOM[r.kind] ?? r.kind}</td>
                <td className="px-3 py-2 text-right tabular-nums">{r.agentTurns.started}</td>
                <td className="px-3 py-2 text-right tabular-nums">{r.visits.requested}</td>
                <td className="px-3 py-2 text-right tabular-nums">{pct(r.visits.acceptRate)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{r.presence.leavesExplicit + r.presence.leavesImplicit}</td>
                <td className="px-3 py-2 text-right tabular-nums">{pct(r.presence.rejoinRate)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{r.approvals.requested}</td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {r.approvals.approved}/{r.approvals.edited}/{r.approvals.rejected}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">{secs(r.approvals.avgResolveMs)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{r.agreements}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function MetricsPage() {
  const [data, setData] = useState<MetricsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let alive = true;
    setError(null);
    getMetrics()
      .then((d) => alive && setData(d))
      .catch((e: unknown) => alive && setError(e instanceof ApiError ? e.message : '지표를 불러오지 못했어요'));
    return () => {
      alive = false;
    };
  }, [tick]);

  return (
    <main className="pointer-events-auto h-full overflow-y-auto bg-bg px-6 py-6" data-testid="metrics-page">
      <div className="mx-auto max-w-5xl">
        <header className="flex items-center gap-3">
          <button type="button" className="rounded-md border border-line px-3 py-1.5 text-sm hover:bg-raised" onClick={() => navigate('/')}>
            메신저로
          </button>
          <h1 className="text-xl font-semibold">지표</h1>
          <button type="button" className="ml-auto rounded-md border border-line px-3 py-1.5 text-sm hover:bg-raised" onClick={() => setTick((n) => n + 1)}>
            새로고침
          </button>
        </header>
        <p className="mt-2 text-xs text-muted">
          내가 볼 수 있는 이벤트만 센 값이라 사용자마다 다를 수 있어요.
          {data && ` · ${new Date(data.generatedAt).toLocaleTimeString('ko-KR')} 기준`}
        </p>
        {error && (
          <p role="alert" className="mt-6 text-sm text-[var(--focus)]">
            {error}
          </p>
        )}
        {!data && !error && <p className="mt-6 text-sm text-muted">불러오는 중…</p>}
        {data && (
          <>
            <TotalsCards t={data.totals} repeatRate={data.rooms.repeatUseRate} active={data.rooms.active} />
            <RoomTable rows={data.perRoom} />
          </>
        )}
      </div>
    </main>
  );
}
