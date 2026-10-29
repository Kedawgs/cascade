/** A D1Database that counts its queries (a db.batch() counts once, as D1 bills and limits it) and
 * adds up the rows each one read, so tests can hold the tick and the API to their D1 budgets. */
export function countingDb(db: D1Database) {
  const stats = { queries: 0, rowsRead: 0 };
  const real = new WeakMap<object, D1PreparedStatement>();
  const record = (meta: { rows_read?: number } | undefined) => {
    stats.queries++;
    stats.rowsRead += meta?.rows_read ?? 0;
  };

  function wrap(stmt: D1PreparedStatement): D1PreparedStatement {
    const w = {
      bind: (...values: unknown[]) => wrap(stmt.bind(...values)),
      async all() {
        const r = await stmt.all();
        record(r.meta);
        return r;
      },
      async run() {
        const r = await stmt.run();
        record(r.meta);
        return r;
      },
      async first(column?: string) {
        // first() reports no meta: read through all() to count the rows
        const r = await stmt.all<Record<string, unknown>>();
        record(r.meta);
        const row = r.results[0] ?? null;
        return column === undefined || row === null ? row : row[column];
      },
      async raw(o?: { columnNames?: boolean }) {
        stats.queries++;
        return stmt.raw(o as never);
      },
    } as unknown as D1PreparedStatement;
    real.set(w, stmt);
    return w;
  }

  const counted = {
    prepare: (sql: string) => wrap(db.prepare(sql)),
    async batch(stmts: D1PreparedStatement[]) {
      const rs = await db.batch(stmts.map((s) => real.get(s) ?? s));
      stats.queries++;
      for (const r of rs) stats.rowsRead += r.meta?.rows_read ?? 0;
      return rs;
    },
    async exec(sql: string) {
      stats.queries++;
      return db.exec(sql);
    },
    withSession: () => counted,
    dump: () => db.dump(),
  } as unknown as D1Database;

  return {
    db: counted,
    stats,
    reset() {
      stats.queries = 0;
      stats.rowsRead = 0;
    },
  };
}

/** Every table the migration makes. */
export const TABLES = ["meta", "cursors", "logs", "blocks", "txs", "seed_pages", "readings", "hours", "messages", "batch_checks", "chunk_checks", "nonces", "alerts", "holds", "lease", "guard"] as const;

/** Empties every table (between tests in one file, which share a D1). */
export async function wipe(db: D1Database): Promise<void> {
  await db.batch(TABLES.map((t) => db.prepare(`DELETE FROM ${t}`)));
}

/** Each table's row count. */
export async function rowCounts(db: D1Database): Promise<Record<string, number>> {
  const rs = await db.batch(TABLES.map((t) => db.prepare(`SELECT COUNT(*) AS n FROM ${t}`)));
  return Object.fromEntries(TABLES.map((t, i) => [t, (rs[i].results[0] as { n: number }).n]));
}
