import { AnswerBlockSchema, MAX_BLOCKS_PER_MESSAGE, parseNamespace, type AnswerBlock, type SourceChip } from '@ensemble/shared';
import type { AppContext } from '../context';

/**
 * say.blocks 정규화 (계획 B1-4). 모델이 낸 원본(`src: string[]` 근거 id)을 검증해 저장 형태(`sources: SourceChip[]`)로 바꾼다.
 * - 블록마다 따로 검증한다. 틀린 블록은 버리고 나머지는 살린다. 문자열·배열 상한 초과는 자른 뒤 다시 검증한다.
 * - 근거 id는 서버가 이번 턴에 준 것만 칩이 된다(mem_… = 제공된 기억, d… = 현황, #seq = 프롬프트에 실린 이벤트).
 *   기억 원문은 칩에 넣지 않는다.
 * - schedule·profile·status 항목은 유효한 근거가 하나도 없으면 지운다(환각 방지). 항목이 비면 블록도 지운다.
 */

export interface NormalizeOpts {
  providedIds: readonly string[];
  digestRefs: ReadonlyMap<string, SourceChip>;
  eventSeqs: readonly number[];
  /** 제공된 기억 id → 칩 (없으면 null) */
  memoryChip: (id: string) => SourceChip | null;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** 기억 id의 ns로 출처 칩을 만든다: private "내 기억", for "내 기억 · {방}", room "{방} 기억" */
export function memoryChipResolver(ctx: AppContext): NormalizeOpts['memoryChip'] {
  return (id) => {
    const item = ctx.repo.getMemoryItem(id);
    if (!item || item.status !== 'active') return null;
    const p = parseNamespace(item.ns);
    if (!p) return null;
    if (p.kind === 'private') return { kind: 'memory', label: '내 기억' };
    if (p.kind === 'for') {
      const title = ctx.repo.getRoom(p.roomId)?.title;
      return { kind: 'memory', label: title ? `내 기억 · ${title}`.slice(0, 40) : '내 기억', roomId: p.roomId };
    }
    if (p.kind === 'room') {
      const title = ctx.repo.getRoom(p.roomId)?.title;
      return { kind: 'memory', label: title ? `${title} 기억`.slice(0, 40) : '방 기억', roomId: p.roomId };
    }
    return null;
  };
}

function chipsFrom(src: unknown, o: NormalizeOpts): SourceChip[] {
  if (!Array.isArray(src)) return [];
  const provided = new Set(o.providedIds);
  const seqs = new Set(o.eventSeqs);
  const out: SourceChip[] = [];
  const seen = new Set<string>();
  for (const r of src) {
    if (typeof r !== 'string') continue;
    const ref = r.trim();
    let chip: SourceChip | null = null;
    if (/^mem_/.test(ref)) chip = provided.has(ref) ? o.memoryChip(ref) : null;
    else if (/^d\d+$/.test(ref)) chip = o.digestRefs.get(ref) ?? null;
    else {
      const m = /^#?(\d+)$/.exec(ref);
      if (m && seqs.has(Number(m[1]))) chip = { kind: 'event', label: '대화' };
    }
    if (!chip) continue;
    const key = `${chip.kind}|${chip.label}|${chip.roomId ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(chip);
    if (out.length >= 4) break;
  }
  return out;
}

/** `src`가 있는 항목을 sources로 바꾼다. required이면 근거 없는 항목은 지운다 */
function mapItems(list: unknown, o: NormalizeOpts, required: boolean): Obj[] {
  if (!Array.isArray(list)) return [];
  const out: Obj[] = [];
  for (const raw of list) {
    if (!isObj(raw)) continue;
    const { src, sources: _ignored, ...rest } = raw;
    const chips = chipsFrom(src, o);
    if (required && chips.length === 0) continue;
    out.push(chips.length ? { ...rest, sources: chips } : rest);
  }
  return out;
}

/** 종류별로 근거 변환·빈 항목 제거. 블록이 성립하지 않으면 null */
function prepare(block: unknown, o: NormalizeOpts): Obj | null {
  if (!isObj(block)) return null;
  switch (block.type) {
    case 'schedule': {
      const days = (Array.isArray(block.days) ? block.days : [])
        .filter(isObj)
        .map((d) => ({ ...d, items: mapItems(d.items, o, true) }))
        .filter((d) => d.items.length > 0);
      return days.length ? { ...block, days } : null;
    }
    case 'profile': {
      const groups = (Array.isArray(block.groups) ? block.groups : [])
        .filter(isObj)
        .map((g) => ({ ...g, chips: mapItems(g.chips, o, true) }))
        .filter((g) => g.chips.length > 0);
      return groups.length ? { ...block, groups } : null;
    }
    case 'status': {
      const rooms = (Array.isArray(block.rooms) ? block.rooms : [])
        .filter(isObj)
        .map((r) => ({ ...r, items: mapItems(r.items, o, true) }))
        .filter((r) => r.items.length > 0);
      return rooms.length ? { ...block, rooms } : null;
    }
    case 'checklist': {
      const items = mapItems(block.items, o, false);
      return items.length ? { ...block, items } : null;
    }
    case 'money': {
      const lines = Array.isArray(block.lines) ? block.lines.filter(isObj) : [];
      return lines.length ? { ...block, lines } : null;
    }
    case 'compare':
      return block;
    default:
      return null;
  }
}

/** zod 상한 초과(문자열 길이·배열 길이)를 잘라서 다시 검증한다. 다른 오류면 null */
function parseWithTruncate(raw: Obj): AnswerBlock | null {
  let cur: unknown = raw;
  for (let attempt = 0; attempt < 40; attempt++) {
    const r = AnswerBlockSchema.safeParse(cur);
    if (r.success) return r.data;
    let fixed = false;
    for (const issue of r.error.issues) {
      const max = (issue as { maximum?: unknown }).maximum;
      if (issue.code !== 'too_big' || typeof max !== 'number') continue;
      const origin = (issue as { origin?: string }).origin;
      const parent = issue.path.slice(0, -1).reduce<unknown>((v, k) => (v as Obj)?.[k as string], cur);
      const key = issue.path[issue.path.length - 1];
      const target = (issue.path.length === 0 ? cur : issue.path.reduce<unknown>((v, k) => (v as Obj)?.[k as string], cur)) as unknown;
      if (origin === 'string' && typeof target === 'string' && key !== undefined && isObjOrArr(parent)) {
        (parent as Obj)[key as string] = target.slice(0, max);
        fixed = true;
      } else if (origin === 'array' && Array.isArray(target) && key !== undefined && isObjOrArr(parent)) {
        (parent as Obj)[key as string] = target.slice(0, max);
        fixed = true;
      }
    }
    if (!fixed) return null;
  }
  return null;
}
const isObjOrArr = (v: unknown): v is object => typeof v === 'object' && v !== null;

export function normalizeBlocks(raw: unknown, o: NormalizeOpts): AnswerBlock[] {
  if (!Array.isArray(raw)) return [];
  const out: AnswerBlock[] = [];
  for (const b of raw.slice(0, 6)) {
    if (out.length >= MAX_BLOCKS_PER_MESSAGE) break;
    let prepared: Obj | null;
    try {
      prepared = prepare(structuredClone(b), o);
    } catch {
      prepared = null;
    }
    if (!prepared) continue;
    const parsed = parseWithTruncate(prepared);
    if (parsed) out.push(parsed);
  }
  return out;
}
