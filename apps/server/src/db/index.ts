import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { REPO_ROOT } from '../config';

// HOSTING: SQLite → Postgres. 이 파일(openDb/tx/마이그레이션)과 repo.ts의 SQL만 바꾸면 된다.

const here = dirname(fileURLToPath(import.meta.url));

/** 마이그레이션 목록. 번호 순서대로 한 번씩만 적용된다. */
const MIGRATIONS: { version: number; sql: () => string }[] = [
  { version: 1, sql: () => readFileSync(resolve(here, 'schema.sql'), 'utf8') },
];

export interface Db {
  raw: DatabaseSync;
  /** 트랜잭션(중첩은 savepoint). 예외가 나면 롤백하고 afterCommit 콜백도 버린다. */
  tx<T>(fn: () => T): T;
  /** 최외곽 트랜잭션이 커밋된 뒤 실행한다. 트랜잭션 밖이면 즉시 실행한다. */
  afterCommit(fn: () => void): void;
  close(): void;
}

export function defaultDbPath(): string {
  return resolve(REPO_ROOT, 'data', 'ensemble.db');
}

/** `:memory:`면 인메모리 DB(테스트). 파일이면 상위 디렉터리(data/)를 만든다. */
export function openDb(path: string = ':memory:'): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const raw = new DatabaseSync(path);
  raw.exec('PRAGMA foreign_keys = ON');
  raw.exec('PRAGMA busy_timeout = 5000');
  if (path !== ':memory:') raw.exec('PRAGMA journal_mode = WAL');

  let depth = 0;
  let queue: (() => void)[] = [];

  const db: Db = {
    raw,
    tx<T>(fn: () => T): T {
      if (depth === 0) {
        raw.exec('BEGIN IMMEDIATE');
        depth++;
        let result: T;
        try {
          result = fn();
          raw.exec('COMMIT');
        } catch (err) {
          try {
            raw.exec('ROLLBACK');
          } catch {
            /* 이미 롤백됨 */
          }
          queue = [];
          throw err;
        } finally {
          depth--;
        }
        const run = queue;
        queue = [];
        for (const f of run) f();
        return result;
      }
      const name = `sp_${depth}`;
      const mark = queue.length;
      raw.exec(`SAVEPOINT ${name}`);
      depth++;
      try {
        const result = fn();
        raw.exec(`RELEASE ${name}`);
        return result;
      } catch (err) {
        raw.exec(`ROLLBACK TO ${name}`);
        raw.exec(`RELEASE ${name}`);
        queue.length = mark;
        throw err;
      } finally {
        depth--;
      }
    },
    afterCommit(fn) {
      if (depth === 0) fn();
      else queue.push(fn);
    },
    close() {
      raw.close();
    },
  };

  migrate(db);
  return db;
}

function migrate(db: Db): void {
  db.raw.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)');
  const row = db.raw.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations').get() as { v: number };
  for (const m of MIGRATIONS) {
    if (m.version <= row.v) continue;
    db.tx(() => {
      db.raw.exec(m.sql());
      db.raw.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(m.version, Date.now());
    });
  }
}
