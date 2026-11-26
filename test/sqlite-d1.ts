// A stand-in for the part of Cloudflare D1 the store uses, over node's built-in SQLite, so the store can be tested without Cloudflare.
import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import type { Db, Stmt } from '../src/worker/store.ts';

const MIGRATIONS = new URL('../migrations/', import.meta.url);

class SqliteStmt implements Stmt {
  private readonly sqlite: DatabaseSync;
  private readonly sql: string;
  private readonly params: SQLInputValue[];

  constructor(sqlite: DatabaseSync, sql: string, params: SQLInputValue[] = []) {
    this.sqlite = sqlite;
    this.sql = sql;
    this.params = params;
  }

  bind(...values: unknown[]): Stmt {
    return new SqliteStmt(this.sqlite, this.sql, values.map((v) => (v === undefined ? null : (v as SQLInputValue))));
  }

  async first<T>(): Promise<T | null> {
    return ((this.sqlite.prepare(this.sql).get(...this.params) as T | undefined) ?? null);
  }

  async all<T>(): Promise<{ results: T[] }> {
    return this.rows<T>();
  }

  async run(): Promise<unknown> {
    return this.rows();
  }

  /** Every statement goes through `all`, so a write with RETURNING hands its rows back, as D1 does. */
  rows<T>(): { results: T[] } {
    return { results: this.sqlite.prepare(this.sql).all(...this.params) as T[] };
  }
}

export function sqliteDb(): Db {
  const sqlite = new DatabaseSync(':memory:');
  for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) sqlite.exec(readFileSync(new URL(file, MIGRATIONS), 'utf8'));
  return {
    prepare: (sql) => new SqliteStmt(sqlite, sql),
    // D1 runs a batch as one transaction, and so does this.
    async batch(stmts) {
      sqlite.exec('BEGIN');
      try {
        const out = (stmts as SqliteStmt[]).map((s) => s.rows());
        sqlite.exec('COMMIT');
        return out;
      } catch (err) {
        sqlite.exec('ROLLBACK');
        throw err;
      }
    },
  };
}
