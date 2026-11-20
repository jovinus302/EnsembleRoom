/**
 * 1회성 스모크: AGENT_MODE=claude로 실제 한 턴(사람 메시지 -> Agent)을 돌려 이벤트가 기록되는지 본다. 인메모리 DB.
 * 실행: npm run smoke:turn   (저장소 루트. AGENT_MODE는 스크립트가 claude로 강제한다)
 */
import { loadConfig } from '../src/config';
import { createContext } from '../src/context';
import { openDb } from '../src/db/index';
import { SEED, seedDatabase } from '../src/db/seed';
import { dispatch } from '../src/domain/actions';

const config = { ...loadConfig(), agentMode: 'claude' as const };
const ctx = createContext(openDb(':memory:'), config);
seedDatabase(ctx);
ctx.agents.start();

const activity: string[] = [];
const orig = ctx.hub.publishActivity.bind(ctx.hub);
ctx.hub.publishActivity = (m) => {
  activity.push(`${m.phase ?? '-'}:${m.text.length}${m.final ? ':final' : ''}`);
  orig(m);
};

const roomId = SEED.rooms.myAlice;
dispatch(ctx, { kind: 'human', userId: SEED.users.alice }, { type: 'send_message', roomId, text: '안녕, 오늘 모임 장소 후보를 한 가지만 제안해 줄래?' });

const t0 = Date.now();
while (Date.now() - t0 < 60_000 && !ctx.store.listAll(roomId).some((e) => e.type === 'agent_turn_ended')) await new Promise((r) => setTimeout(r, 200));
await new Promise((r) => setTimeout(r, 300));

for (const e of ctx.store.listAll(roomId).filter((e) => e.actorKind !== 'system' || e.type.startsWith('agent'))) {
  if (!e.type.startsWith('agent') && e.type !== 'message') continue;
  const text = 'text' in e && typeof e.text === 'string' ? ` text=${e.text.slice(0, 80)}` : '';
  console.log(`seq=${e.seq} ${e.type} actor=${e.actorKind}${text}${'result' in e ? ` result=${String(e.result)}` : ''}`);
}
console.log('outcomes:', JSON.stringify(ctx.agents.outcomes.map((o) => ({ result: o.result, tool: o.tool, errorCode: o.errorCode }))));
console.log('activity batches:', activity.length, activity.slice(0, 6).join(' '));
ctx.agents.stop();
process.exit(0);
