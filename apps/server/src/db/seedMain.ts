import { loadConfig } from '../config';
import { createContext } from '../context';
import { openDb } from './index';
import { seedDatabase } from './seed';

// `npm run seed`: data/ensemble.db에 시드를 넣는다. 재실행해도 중복되지 않는다.
const config = loadConfig();
const db = openDb(config.dbPath);
seedDatabase(createContext(db, config));
const n = (sql: string) => (db.raw.prepare(sql).get() as { n: number }).n;
console.log(
  `seed ok: users=${n('SELECT COUNT(*) n FROM users')} rooms=${n('SELECT COUNT(*) n FROM rooms')} ` +
    `events=${n('SELECT COUNT(*) n FROM events')} memory=${n('SELECT COUNT(*) n FROM memory_items')} (${config.dbPath})`,
);
db.close();
