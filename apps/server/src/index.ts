import { buildApp } from './app';
import { loadConfig } from './config';
import { createContext } from './context';
import { openDb } from './db/index';
import { seedDatabase } from './db/seed';

const config = loadConfig();
const db = openDb(config.dbPath);
const ctx = createContext(db, config);
// 빈 DB로 처음 뜨면 시드를 넣는다(이미 있으면 아무 일도 하지 않는다).
seedDatabase(ctx);
// 시드 이벤트가 Agent를 깨우지 않도록 시드 뒤에 시작한다.
ctx.agents.start();

const app = await buildApp(ctx, { logger: true });
await app.listen({ port: config.port, host: '0.0.0.0' });

const shutdown = async () => {
  ctx.agents.stop(); // 진행 중인 턴에 AbortSignal을 보낸다
  await ctx.agents.drain(); // DB를 닫기 전에 턴 종료 기록이 끝나게 한다
  ctx.hub.closeAll();
  await app.close();
  db.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
