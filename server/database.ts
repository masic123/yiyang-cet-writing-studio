import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import type { D1Database } from "@cloudflare/workers-types";
import { migrations } from "../worker/migrations";

/** Keep the same parameterized queries and password hashes on the VPS. */
export function sqliteDatabase(path: string, options: { identityOnly?: boolean } = {}) {
  if (path !== ":memory:")
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const sql = new DatabaseSync(path);
  if (path !== ":memory:") chmodSync(path, 0o600);
  sql.exec(
    "PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;",
  );
  sql.exec(
    "CREATE TABLE IF NOT EXISTS app_migrations(version INTEGER PRIMARY KEY)",
  );
  for (const migration of migrations) {
    if (options.identityOnly && migration.version > 1) continue;
    if (sql.prepare("SELECT version FROM app_migrations WHERE version=?").get(migration.version)) continue;
    sql.exec("BEGIN IMMEDIATE");
    try {
      sql.exec(migration.sql);
      sql.prepare("INSERT INTO app_migrations(version) VALUES(?)").run(migration.version);
      sql.exec("COMMIT");
    } catch (error) {
      sql.exec("ROLLBACK");
      sql.close();
      throw error;
    }
  }
  class Statement {
    constructor(
      public source: string,
      public values: SQLInputValue[] = [],
    ) {}
    bind(...values: SQLInputValue[]) {
      return new Statement(this.source, values);
    }
    first<T>(column?: string): T | null {
      const row = sql.prepare(this.source).get(...this.values);
      return (row ? (column ? row[column] : row) : null) as T | null;
    }
    all() {
      return {
        results: sql.prepare(this.source).all(...this.values),
        success: true,
        meta: {},
      };
    }
    run() {
      const result = sql.prepare(this.source).run(...this.values);
      return {
        success: true,
        meta: {
          changes: Number(result.changes),
          last_row_id: Number(result.lastInsertRowid),
        },
      };
    }
  }
  const db = {
    prepare: (source: string) => new Statement(source),
    batch: (statements: Statement[]) => {
      sql.exec("BEGIN IMMEDIATE");
      try {
        const results = statements.map((s) => s.run());
        sql.exec("COMMIT");
        return Promise.resolve(results);
      } catch (error) {
        sql.exec("ROLLBACK");
        return Promise.reject(error);
      }
    },
  } as unknown as D1Database;
  return { sql, db };
}
