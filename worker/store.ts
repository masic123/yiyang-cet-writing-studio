import type {
  D1Database,
  DurableObjectNamespace,
  DurableObjectState,
} from "@cloudflare/workers-types";
import { migrations } from "./migrations";
type Query = {
  sql: string;
  values: (string | number | null)[];
  mode: "first" | "all" | "run";
};
// Cloudflare's free SQLite Durable Object is the database service for this app.
// The adapter keeps repository queries parameterized and supports atomic batches.
export class WritingStore {
  constructor(private state: DurableObjectState) {
    const sql = state.storage.sql;
    sql.exec(
      "CREATE TABLE IF NOT EXISTS app_migrations(version INTEGER PRIMARY KEY)",
    );
    for (const migration of migrations) {
      if (sql.exec("SELECT version FROM app_migrations WHERE version=?", migration.version).toArray().length) continue;
      state.storage.transactionSync(() => {
        sql.exec(migration.sql);
        sql.exec("INSERT INTO app_migrations(version) VALUES(?)", migration.version);
      });
    }
  }
  async fetch(request: Request): Promise<Response> {
    try {
      const data = (await request.json()) as {
        queries: Query[];
        batch?: boolean;
      };
      const perform = () =>
        data.queries.map((query) => {
          const cursor = this.state.storage.sql.exec(
            query.sql,
            ...query.values,
          );
          const rows = cursor.toArray();
          return query.mode === "first"
            ? rows[0] || null
            : query.mode === "all"
              ? { results: rows, success: true, meta: {} }
              : { success: true, meta: {} };
        });
      return Response.json(
        data.batch ? this.state.storage.transactionSync(perform) : perform(),
      );
    } catch {
      return Response.json({ error: "DATABASE_QUERY_FAILED" }, { status: 500 });
    }
  }
}
export function durableDatabase(namespace: DurableObjectNamespace): D1Database {
  const stub = namespace.get(namespace.idFromName("cet-writing-studio"));
  const execute = async (queries: Query[], batch = false) => {
    const result = await stub.fetch("https://database.internal/query", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ queries, batch }),
    });
    if (!result.ok) throw new Error("DATABASE_QUERY_FAILED");
    return (await result.json()) as unknown[];
  };
  class Statement {
    constructor(
      public sql: string,
      public values: (string | number | null)[] = [],
    ) {}
    bind(...values: (string | number | null)[]) {
      return new Statement(this.sql, values);
    }
    async first() {
      return (
        await execute([{ sql: this.sql, values: this.values, mode: "first" }])
      )[0];
    }
    async all() {
      return (
        await execute([{ sql: this.sql, values: this.values, mode: "all" }])
      )[0];
    }
    async run() {
      return (
        await execute([{ sql: this.sql, values: this.values, mode: "run" }])
      )[0];
    }
  }
  return {
    prepare: (sql: string) => new Statement(sql),
    batch: (statements: Statement[]) =>
      execute(
        statements.map((s) => ({ sql: s.sql, values: s.values, mode: "run" })),
        true,
      ),
  } as unknown as D1Database;
}
