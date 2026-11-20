import Anthropic from '@anthropic-ai/sdk';
import { buildRoomState, pendingApprovalsFor, type DigestBoardChange, type DigestResponse, type RoomEvent } from '@ensemble/shared';
import { renderEvent } from '../agent/prompts';
import { AGENT_DEFAULTS } from '../config';
import type { AppContext } from '../context';
import { approvalItem } from '../domain/approvals';
import { QUIET_EVENTS, missedChangeCount, requireRoom, resolveSubject } from '../domain/rooms';
import { forbidden } from '../errors';

/**
 * 요약기 (계획 7절 "원문과 추출의 구분").
 *  - Room 요약: 그 Room의 `room` 가시성 이벤트가 `summaryEveryEvents`(기본 30)개 쌓일 때마다, 그리고 Rejoin 시점에 `room_summaries`를 갱신한다.
 *    프롬프트(agent/context.ts)가 읽는다. 방문 Agent에게는 주지 않는다.
 *  - Rejoin 다이제스트: `left_at_seq` 이후 이벤트의 요약 + 보드 변화 + 대기 중인 승인. 요청자의 가시성 필터를 적용한다.
 * 요약 문장은 SummaryProvider가 만든다: mock은 결정적, claude는 경량(LIGHT) 모델.
 */

export interface SummaryRequest {
  kind: 'room' | 'digest';
  title: string;
  /** 이전 Room 요약 (Room 요약의 증분 갱신용) */
  previous: string | null;
  /** 시간순 이벤트 한 줄 설명. 요청자가 볼 수 있는 이벤트만 들어 있다. */
  lines: string[];
  /** digest만: 읽는 사람의 이름 */
  viewer?: string;
}

export interface SummaryProvider {
  readonly name: string;
  summarize(req: SummaryRequest, signal?: AbortSignal): Promise<string>;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** Room 요약 상한(프롬프트 600토큰 ≈ 1200자)에 맞춘 글자 수 */
export const SUMMARY_MAX_CHARS = 900;
const MAX_LINES = 60;

/** AGENT_MODE=mock: 같은 입력이면 같은 요약 */
export class MockSummaryProvider implements SummaryProvider {
  readonly name = 'mock';
  async summarize(req: SummaryRequest): Promise<string> {
    const lines = req.lines.slice(-MAX_LINES);
    const count = (re: RegExp) => lines.filter((l) => re.test(l)).length;
    // 대화 줄은 "#seq 이름 → 이름: 내용" 모양이라 ':' 앞에 아래 낱말이 없다
    const nonChat = lines.filter((l) => /카드|코멘트|승인|합의|방문|도착|메모|보고/.test(l.split(': ')[0] ?? l)).length;
    const msgs = lines.length - nonChat;
    const stats = `대화 ${msgs}건, 카드 변경 ${count(/카드|코멘트/)}건, 승인 ${count(/승인/)}건${count(/합의/) ? `, 합의 ${count(/합의/)}건` : ''}`;
    const recent = lines.slice(-3).map((l) => clip(l.replace(/^#\d+ /, ''), 60));
    const head = req.kind === 'digest' ? `자리를 비운 동안: ${stats}.` : `${req.title} 요약: ${stats}.`;
    const tail = recent.length ? ` 최근: ${recent.join(' / ')}` : '';
    const prev = req.kind === 'room' && req.previous ? `(이전: ${clip(req.previous, 160)}) ` : '';
    return clip(`${prev}${head}${tail}`, SUMMARY_MAX_CHARS);
  }
}

/** 테스트에서 가짜로 갈아끼울 수 있는 최소 클라이언트 모양 (비스트리밍) */
export interface SummaryClient {
  messages: {
    create(params: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<{ content: { type: string; text?: string }[] }>;
  };
}

export const SUMMARY_SYSTEM =
  '당신은 협업 Room의 활동 요약기다. 주어진 이벤트 목록만 근거로, 한국어 존댓말("~했어요", "~예요")로 2~4문장 이내로 요약한다. ' +
  '누가 무엇을 제안·결정했는지, 아직 열려 있는 질문과 승인 대기 사항을 중심으로 쓴다. ' +
  '제목·머리글·마크다운(**, #, 목록)·이모지·카드 id(c_...)·이벤트 번호는 쓰지 않고, 줄바꿈 없이 평문 한 단락으로 쓴다. ' +
  '목록에 없는 내용을 추측하지 않고, 이벤트에 없는 개인정보를 덧붙이지 않는다.';

/** AGENT_MODE=claude: 경량 모델로 요약한다 (기본 claude-sonnet-4-6) */
export class ClaudeSummaryProvider implements SummaryProvider {
  readonly name = 'claude';
  constructor(private readonly opts: { client: SummaryClient; lightModel: string; maxTokens?: number }) {}

  async summarize(req: SummaryRequest, signal?: AbortSignal): Promise<string> {
    const body = [
      `Room: ${req.title}`,
      req.previous ? `이전 요약:\n${req.previous}` : null,
      `이벤트:\n${req.lines.slice(-MAX_LINES).join('\n') || '(없음)'}`,
      req.kind === 'digest'
        ? `자리를 비웠다가 돌아온 ${req.viewer ?? '사용자'}님이 읽을 요약이야. ${req.viewer ? `${req.viewer}님에게 말하듯 "${req.viewer}님이 없는 동안" 일어난 일 위주로` : '일어난 일 위주로'} 써 줘.`
        : '이전 요약과 새 이벤트를 합쳐 갱신된 요약을 써 줘.',
    ]
      .filter(Boolean)
      .join('\n\n');
    const res = await this.opts.client.messages.create(
      {
        model: this.opts.lightModel,
        max_tokens: this.opts.maxTokens ?? 500,
        system: SUMMARY_SYSTEM,
        messages: [{ role: 'user', content: body }],
      },
      signal ? { signal } : undefined,
    );
    const text = res.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('')
      .trim();
    if (!text) throw new Error('summary: 모델이 빈 응답을 돌려주었습니다');
    return clip(text.replace(/\*\*|^#+\s*/gm, ''), SUMMARY_MAX_CHARS);
  }
}

export function createClaudeSummaryProvider(env: NodeJS.ProcessEnv = process.env): ClaudeSummaryProvider {
  const apiKey = env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) throw new Error('AGENT_MODE=claude이지만 ANTHROPIC_API_KEY가 설정되지 않았습니다.');
  const baseURL = env.ANTHROPIC_BASE_URL?.trim() || undefined;
  const client = new Anthropic({ apiKey, ...(baseURL ? { baseURL } : {}), maxRetries: 0 });
  return new ClaudeSummaryProvider({
    client: client as unknown as SummaryClient,
    lightModel: env.ANTHROPIC_MODEL_LIGHT?.trim() || 'claude-sonnet-4-6',
  });
}

export function createSummaryProvider(config: AppContext['config']): SummaryProvider {
  return config.agentMode === 'claude' ? createClaudeSummaryProvider() : new MockSummaryProvider();
}

export class Summarizer {
  private provider: SummaryProvider;
  private unsubscribe: (() => void) | null = null;
  private chains = new Map<string, Promise<void>>();
  private ctl = new AbortController();
  private digestCache = new Map<string, string>();

  constructor(
    private readonly ctx: AppContext,
    provider?: SummaryProvider,
  ) {
    this.provider = provider ?? createSummaryProvider(ctx.config);
  }

  setProvider(p: SummaryProvider): void {
    this.provider = p;
  }

  /** 시드·테스트가 의도치 않게 요약을 돌리지 않도록 AgentRuntime.start()가 시작한다 */
  start(): void {
    if (this.unsubscribe) return;
    if (this.ctl.signal.aborted) this.ctl = new AbortController();
    this.unsubscribe = this.ctx.store.onAppended((e) => this.onEvent(e));
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.ctl.abort();
  }

  /** 진행 중인 요약이 모두 끝날 때까지 기다린다 */
  async drain(): Promise<void> {
    while (this.chains.size > 0) await Promise.allSettled([...this.chains.values()]);
  }

  private get every(): number {
    return this.ctx.config.summaryEveryEvents ?? AGENT_DEFAULTS.summaryEveryEvents;
  }

  /** 새 이벤트가 요약 트리거인가: Rejoin 즉시, 그 외에는 요약 이후 쌓인 변화가 N개 이상 */
  onEvent(e: RoomEvent): void {
    try {
      const room = this.ctx.repo.getRoom(e.roomId);
      if (!room || room.kind === 'dm') return;
      if (e.type === 'member_rejoined') return void this.schedule(e.roomId, true);
      if (QUIET_EVENTS.has(e.type) || e.visibility !== 'room') return;
      if (this.pendingCount(e.roomId) >= this.every) this.schedule(e.roomId, false);
    } catch (err) {
      console.error('[summarizer] trigger failed', err);
    }
  }

  /** 마지막 요약 이후 쌓인 요약 대상 이벤트 */
  private pending(roomId: string): RoomEvent[] {
    const upto = this.ctx.repo.getRoomSummary(roomId)?.uptoSeq ?? 0;
    return this.ctx.store.listAll(roomId, { afterSeq: upto }).filter((e) => e.visibility === 'room' && !QUIET_EVENTS.has(e.type));
  }
  private pendingCount(roomId: string): number {
    return this.pending(roomId).length;
  }

  private schedule(roomId: string, force: boolean): void {
    const prev = this.chains.get(roomId) ?? Promise.resolve();
    const next: Promise<void> = prev
      .then(() => this.summarizeRoom(roomId, { force }))
      .then(() => undefined)
      .catch((err) => console.error('[summarizer] failed', err))
      .finally(() => {
        if (this.chains.get(roomId) === next) this.chains.delete(roomId);
      });
    this.chains.set(roomId, next);
  }

  /**
   * Room 요약을 갱신한다. 새 변화가 없으면 건드리지 않는다(force여도 요약이 아직 없을 때만 새로 만든다).
   * `room` 가시성 이벤트만 입력으로 쓰므로 private 내용은 요약에 들어가지 않는다.
   * @returns 갱신했으면 새 요약 텍스트
   */
  async summarizeRoom(roomId: string, opts: { force?: boolean } = {}): Promise<string | null> {
    const { repo, store } = this.ctx;
    const room = repo.getRoom(roomId);
    if (!room || room.kind === 'dm') return null;
    const fresh = this.pending(roomId);
    if (fresh.length === 0) return null;
    if (!opts.force && fresh.length < this.every) return null;

    const lastSeq = store.lastSeq(roomId);
    const nameOf = this.nameResolver();
    const lines = fresh.map((e) => renderEvent(e, nameOf)).filter((l): l is string => !!l);
    if (lines.length === 0) return null;
    const previous = repo.getRoomSummary(roomId)?.text ?? null;
    const text = await this.provider.summarize({ kind: 'room', title: room.title, previous, lines }, this.ctl.signal);
    // 요약하는 동안 이미 다른 갱신이 있었더라도 더 큰 upto만 반영한다
    const cur = repo.getRoomSummary(roomId)?.uptoSeq ?? 0;
    if (lastSeq > cur) repo.upsertRoomSummary(roomId, lastSeq, text);
    return text;
  }

  private nameResolver(): (id: string | null) => string {
    const { repo } = this.ctx;
    const names = new Map<string, string>();
    for (const u of repo.listUsers()) names.set(u.id, u.name);
    return (id) => {
      if (!id) return '시스템';
      const hit = names.get(id);
      if (hit) return hit;
      const a = repo.getAgent(id) ?? repo.getRoomAgent(id);
      const n = a?.name ?? id;
      names.set(id, n);
      return n;
    };
  }

  /* ------------------------------ Rejoin 다이제스트 ------------------------------ */

  /**
   * viewer 시점의 다이제스트. 이벤트는 `listVisible(viewer)`로만 읽는다(가시성 필터).
   * 자리를 비운 적이 없으면(left_at_seq 없음) 요약 없이 대기 중인 승인만 담는다.
   */
  async digest(viewerId: string, roomId: string): Promise<DigestResponse> {
    const { repo, store } = this.ctx;
    const room = requireRoom(this.ctx, roomId);
    if (!resolveSubject(this.ctx, room, { kind: 'human', userId: viewerId })) {
      throw forbidden('not_in_room', '이 Room에 접근할 수 없습니다');
    }
    const cursor = repo.getCursor(viewerId, roomId);
    const visible = store.listVisible(viewerId, roomId);
    const upToSeq = visible.length ? visible[visible.length - 1]!.seq : 0;
    const state = buildRoomState(roomId, visible);
    const pendingApprovals = pendingApprovalsFor(state, viewerId).map((st) => approvalItem(room, st));
    const leftAt = cursor.leftAtSeq;
    if (leftAt === null || room.kind === 'dm') {
      return { roomId, leftAtSeq: null, upToSeq, missedCount: 0, summary: null, boardChanges: [], pendingApprovals };
    }

    const missed = visible.filter((e) => e.seq > leftAt && !QUIET_EVENTS.has(e.type));
    const missedCount = missedChangeCount(this.ctx, viewerId, roomId, leftAt);

    const titleOf = (cardId: string) => state.board[cardId]?.title ?? cardId;
    const changes = new Map<string, DigestBoardChange>();
    const note = (cardId: string, change: DigestBoardChange['change']) => {
      const prev = changes.get(cardId);
      // created 뒤의 updated는 created로 둔다. deleted·agreed는 항상 덮어쓴다.
      if (prev?.change === 'created' && (change === 'updated' || change === 'commented')) return;
      changes.set(cardId, { cardId, title: titleOf(cardId), change });
    };
    for (const e of missed) {
      if (e.type === 'card_created') note(e.cardId, 'created');
      else if (e.type === 'card_updated') note(e.cardId, e.patch.deleted ? 'deleted' : 'updated');
      else if (e.type === 'comment_added') note(e.cardId, 'commented');
      else if (e.type === 'agreement_formed') note(e.cardId, 'agreed');
    }

    const key = `${viewerId}|${roomId}|${leftAt}|${upToSeq}`;
    let summary = this.digestCache.get(key);
    if (summary === undefined) {
      if (missed.length === 0) summary = '자리를 비운 동안 달라진 점이 없어요.';
      else {
        const nameOf = this.nameResolver();
        const lines = missed.map((e) => renderEvent(e, nameOf) ?? extraLine(e, nameOf)).filter((l): l is string => !!l);
        summary = await this.provider.summarize({ kind: 'digest', title: room.title, previous: null, lines, viewer: repo.getUser(viewerId)?.name }, this.ctl.signal);
      }
      if (this.digestCache.size > 200) this.digestCache.clear();
      this.digestCache.set(key, summary);
    }

    return { roomId, leftAtSeq: leftAt, upToSeq, missedCount, summary, boardChanges: [...changes.values()], pendingApprovals };
  }
}

/** renderEvent가 다루지 않는 이벤트(본인 전용 포함)의 한 줄 설명 */
function extraLine(e: RoomEvent, name: (id: string | null) => string): string | null {
  switch (e.type) {
    case 'visit_report':
      return `#${e.seq} 방문 보고: ${clip(e.summary, 200)}`;
    case 'agent_owner_note':
      return `#${e.seq} ${name(e.agentId)}의 메모: ${clip(e.note, 200)}`;
    default:
      return null;
  }
}
