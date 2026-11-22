import type { ToolCall, TurnInput } from './types';

/**
 * Mock Agent의 My Room 구조화 답변 (결정적). 소유자가 단둘이 있는 My Room(allowBlocks)에서만 mock.ts가 호출한다.
 * 제공된 기억([제공된 기억])과 [내 Room 현황] 항목에서만 골라 블록을 만들고, 항목마다 src(근거 id)를 단다.
 * 항목이 2개 미만이거나 해당 질문이 아니면 평문 say(또는 null = 기존 흐름)로 돌려준다.
 */

type Obj = Record<string, unknown>;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

const STATUS_RE = /방들|진행|현황|승인|돼\s*가|되고\s*있|어떻게\s*돼/;
const MONEY_RE = /정산|얼마|돈|값/;
const TODO_RE = /할\s*일|해야|야 해/;
const PROFILE_RE = /취향|좋아|뭐\s*먹|음식|입맛/;
const SCHEDULE_RE = /일정|뭐\s*있|비어|스케줄|시간|언제|약속/;

const DAYS = ['월', '화', '수', '목', '금', '토', '일'] as const;
const dayOf = (t: string): string | null => {
  const m = /([월화수목금토일])요일/.exec(t);
  return m ? m[1]! : null;
};
const hasTime = (t: string) => /[월화수목금토일]요일|\d+\s*시|오전|오후|저녁|점심|아침/.test(t);

interface Src {
  id: string;
  text: string;
  /** 카드의 합의 여부·승인 대기 등 */
  tag?: 'agreed' | 'card' | 'approval' | 'tool' | 'agreement' | 'mine' | 'memory';
  kind?: string;
  room?: string;
}

function sourcesOf(input: TurnInput): Src[] {
  const mem: Src[] = input.memories.map((m) => ({ id: m.id, text: m.text, tag: 'memory', kind: m.kind }));
  const dig: Src[] = (input.digest?.items ?? []).map((d) => ({
    id: d.id,
    text: d.text,
    tag: d.kind === 'card' ? (d.agreed ? 'agreed' : 'card') : d.kind,
    room: d.roomTitle,
  }));
  return [...mem, ...dig];
}

const say = (text: string, blocks?: Obj[], ids?: string[]): ToolCall => ({
  name: 'say',
  input: { text, ...(blocks?.length ? { blocks } : {}), ...(ids?.length ? { used_memory_ids: ids } : {}) },
});

function schedule(input: TurnInput, all: Src[]): ToolCall | null {
  type Item = { start?: string; title: string; status: string; room?: string; src: string[]; order: number };
  const byDay = new Map<string, Item[]>();
  const push = (day: string, it: Item) => byDay.set(day, [...(byDay.get(day) ?? []), it]);
  for (const s of all) {
    if (s.tag === 'agreement' || !hasTime(s.text)) continue;
    // 현황의 "내가 공유한 기억"은 같은 문장이 private 기억에도 있을 수 있다: 같은 문장이면 한 번만
    const day = dayOf(s.text) ?? (/오전|오후|저녁|점심|아침|\d+\s*시/.test(s.text) ? '미정' : null);
    if (!day) continue;
    const dup = [...byDay.get(day) ?? []].some((x) => x.title === clip(s.text.replace(/^(내가 이 방에 공유한 기억|방 기억\(합의\)): /, ''), 60));
    if (dup) continue;
    let status = 'fixed';
    if (s.tag === 'approval') status = 'pending';
    else if (s.tag === 'card') status = 'tentative';
    else if (/비어/.test(s.text)) status = 'free';
    else if (/야 한다/.test(s.text)) status = 'pending';
    const t = /(\d{1,2})\s*시(?:\s*반)?/.exec(s.text);
    const start = t ? `${String(Number(t[1])).padStart(2, '0')}:${/반/.test(t[0]) ? '30' : '00'}` : undefined;
    const title = clip(s.text.replace(/^(내가 이 방에 공유한 기억|방 기억\(합의\)): /, ''), 60);
    push(day, { ...(start ? { start } : {}), title, status, ...(s.room ? { room: clip(s.room, 30) } : {}), src: [s.id], order: byDay.size });
  }
  const labels = [...byDay.keys()].sort((a, b) => {
    const ia = (DAYS as readonly string[]).indexOf(a);
    const ib = (DAYS as readonly string[]).indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
  const total = [...byDay.values()].reduce((n, v) => n + v.length, 0);
  if (total === 0) return null;
  const memIds = input.memories.map((m) => m.id);
  if (total < 2) {
    const only = [...byDay.values()][0]![0]!;
    return say(`${only.title}`.replace(/\.$/, '') + '.', undefined, only.src.filter((x) => memIds.includes(x)));
  }
  const days = labels.slice(0, 7).map((label) => ({
    label,
    items: byDay.get(label)!.slice(0, 8).map(({ order: _o, ...it }) => it),
  }));
  const free = days.flatMap((d) => d.items.filter((i) => i.status === 'free').map(() => d.label));
  return say(
    `이번 주 일정을 ${total}건 정리했어요.${free.length ? ` 비어 있는 시간도 있어요.` : ''}`,
    [{ type: 'schedule', title: '이번 주 일정', days, ...(free.length ? { verdict: `${[...new Set(free)].join('·')}요일 비는 시간이 있어요` } : {}) }],
    days.flatMap((d) => d.items.flatMap((i) => i.src)).filter((x) => memIds.includes(x)),
  );
}

function profile(input: TurnInput, all: Src[]): ToolCall | null {
  type Chip = { text: string; tone: 'like' | 'dislike' | 'note'; src: string[] };
  const chips: Chip[] = [];
  const addChip = (c: Chip) => {
    if (!chips.some((x) => x.text === c.text && x.tone === c.tone)) chips.push(c);
  };
  for (const s of all) {
    const isPref = s.kind === 'preference' || (s.tag === 'mine' && /좋아|싫|선호|좋다|못 먹/.test(s.text));
    if (!isPref) continue;
    const text = s.text.replace(/^내가 이 방에 공유한 기억: /, '');
    for (const clause of text.split(/[,.]|고 (?=\S)/).map((c) => c.trim()).filter(Boolean)) {
      if (/못\s*먹|싫어/.test(clause)) {
        const subj = /^(.+?)(?:은|는|을|를|이|가)\s/.exec(clause)?.[1];
        addChip({ text: clip(subj ?? clause, 30), tone: 'dislike', src: [s.id] });
      } else if (/좋아/.test(clause)) {
        const obj = /(\S+(?:\s\S+)?)(?:을|를)\s*좋아/.exec(clause)?.[1] ?? /^(\S+?)(?:은|는)\s*.*좋아/.exec(clause)?.[1];
        addChip({ text: clip(obj ?? clause, 30), tone: 'like', src: [s.id] });
      } else {
        addChip({ text: clip(clause, 30), tone: 'note', src: [s.id] });
      }
    }
  }
  if (chips.length < 2) return null;
  const group = (label: string, tone: Chip['tone']) => ({ label, chips: chips.filter((c) => c.tone === tone).slice(0, 6) });
  const groups = [group('좋아함', 'like'), group('못 먹음·싫음', 'dislike'), group('메모', 'note')].filter((g) => g.chips.length > 0);
  const memIds = input.memories.map((m) => m.id);
  return say(
    `기억해 둔 취향을 정리했어요.`,
    [{ type: 'profile', title: '내 취향', groups }],
    chips.flatMap((c) => c.src).filter((x) => memIds.includes(x)),
  );
}

function checklist(input: TurnInput, all: Src[]): ToolCall | null {
  const items = all
    .filter((s) => s.tag === 'memory' && /야 한다/.test(s.text))
    .map((s) => ({ text: clip(s.text.replace(/\.$/, ''), 60), src: [s.id] }));
  if (items.length === 0) return null;
  const ids = items.map((i) => i.src[0]!);
  if (items.length < 3) return say(`할 일은 ${items.length}건이에요. ${items.map((i) => i.text).join(' / ')}`, undefined, ids);
  return say(`이번 주 할 일을 ${items.length}건 모았어요.`, [{ type: 'checklist', title: '이번 주 할 일', items: items.slice(0, 8) }], ids);
}

function money(input: TurnInput, all: Src[]): ToolCall | null {
  const lines: { label: string; amount: number; src?: string[] }[] = [];
  for (const s of all) {
    if (s.tag !== 'tool') continue;
    const m = /총\s*([\d,]+)원/.exec(s.text);
    if (!m) continue;
    lines.push({ label: clip(`${s.room ?? ''} ${/"([^"]+)"/.exec(s.text)?.[1] ?? '정산표'}`.trim(), 60), amount: Number(m[1]!.replace(/,/g, '')) });
  }
  const paid = all.filter((s) => s.tag === 'memory' && /냈|정산/.test(s.text));
  const memIds = paid.map((s) => s.id);
  if (lines.length === 0) {
    if (paid.length === 0) return null;
    return say(paid[0]!.text.replace(/\.$/, '') + '.', undefined, memIds.slice(0, 1));
  }
  const total = lines.reduce((n, l) => n + l.amount, 0);
  const ids = memIds.filter((id) => input.memories.some((m) => m.id === id));
  if (lines.length < 2) {
    return say(`${lines[0]!.label}에 올라간 금액은 총 ${total.toLocaleString('ko-KR')}원이에요.${paid[0] ? ` ${paid[0].text.replace(/\.$/, '')}.` : ''}`, undefined, ids.slice(0, 1));
  }
  return say('정산표에 올라간 금액을 모았어요.', [{ type: 'money', title: '정산 현황', total, lines: lines.map(({ label, amount }) => ({ label, amount })) }], ids);
}

function status(_input: TurnInput, all: Src[]): ToolCall | null {
  const byRoom = new Map<string, { text: string; state: string; src: string[] }[]>();
  for (const s of all) {
    if (!s.room || s.tag === 'mine') continue;
    const state = s.tag === 'agreed' || s.tag === 'agreement' ? 'decided' : s.tag === 'approval' ? 'pending_approval' : s.tag === 'tool' ? 'todo' : 'waiting';
    const text = clip(s.text.replace(/^방 기억\(합의\): /, '').replace(/^승인 대기: /, ''), 60);
    byRoom.set(s.room, [...(byRoom.get(s.room) ?? []), { text, state, src: [s.id] }]);
  }
  const rooms = [...byRoom.entries()].slice(0, 4).map(([room, items]) => ({ room: clip(room, 30), items: items.slice(0, 4) }));
  const n = rooms.reduce((c, r) => c + r.items.length, 0);
  if (n === 0) return null;
  const pending = [...byRoom.values()].flat().filter((i) => i.state === 'pending_approval').length;
  return say(`방 ${rooms.length}곳의 진행 상황이에요.${pending ? ` 내가 확인할 승인 ${pending}건이 대기 중이에요.` : ''}`, [{ type: 'status', rooms }]);
}

const AVAIL_RE = /비어|비었|한가/;
const PART_RE = /오전|점심|오후|저녁|아침/;

/** "토요일 저녁 비어?": 그 시간대에 잡힌 카드·승인 대기가 있으면 미정이어도 먼저 알리고, 없을 때만 비어 있다고 답한다 */
function availability(input: TurnInput, all: Src[], text: string): ToolCall | null {
  const day = /([월화수목금토일])요일/.exec(text)?.[1];
  if (!day) return null;
  const part = PART_RE.exec(text)?.[0];
  const fits = (s: Src) => s.text.includes(`${day}요일`) && (!part || !PART_RE.test(s.text) || s.text.includes(part));
  const busy = all.filter((s) => (s.tag === 'card' || s.tag === 'agreed' || s.tag === 'approval') && fits(s));
  const when = `${day}요일${part ? ` ${part}` : ''}`;
  if (busy.length > 0) {
    const first = busy[0]!;
    const title = /"([^"]+)"/.exec(first.text)?.[1] ?? clip(first.text, 30);
    const open = /미정/.test(first.text) ? '세부는 아직 미정이에요' : first.tag === 'approval' ? '승인 대기 중이에요' : '이미 정해져 있어요';
    return say(`${when}엔 비어 있지 않아요. "${title}"가 잡혀 있고, ${open}.`, undefined, []);
  }
  const free = all.filter((s) => s.tag === 'memory' && /비어/.test(s.text) && fits(s));
  if (free.length === 0) return null;
  return say(`${when}은 비어 있어요.`, undefined, free.map((s) => s.id).slice(0, 2));
}

/** 해당 질문이면 도구 호출, 아니면 null (기존 mock 흐름으로) */
export function mockOwnerAnswer(input: TurnInput, text: string): ToolCall | null {
  if (!input.allowBlocks) return null;
  const all = sourcesOf(input);
  if (AVAIL_RE.test(text)) {
    const a = availability(input, all, text);
    if (a) return a;
  }
  if (STATUS_RE.test(text)) return status(input, all);
  if (MONEY_RE.test(text)) return money(input, all);
  if (TODO_RE.test(text)) return checklist(input, all);
  if (PROFILE_RE.test(text)) return profile(input, all);
  if (SCHEDULE_RE.test(text)) return schedule(input, all);
  return null;
}
