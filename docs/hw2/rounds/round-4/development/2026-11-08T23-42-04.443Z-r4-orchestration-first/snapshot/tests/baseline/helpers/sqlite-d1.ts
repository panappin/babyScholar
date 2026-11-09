import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';

/** Only the D1 surface used by generation handlers; executes actual migration
 * schemas and SQL in fresh SQLite memory. It is not a workerd/D1 emulator. */
export class SqliteD1 {
  readonly sqlite = new DatabaseSync(':memory:');
  beforeExecute?: (sql: string, values: SQLInputValue[]) => void;

  constructor() {
    const directory = new URL('../../../drizzle/', import.meta.url);
    for (const file of readdirSync(directory).filter(name => name.endsWith('.sql')).sort()) {
      this.sqlite.exec(readFileSync(new URL(file, directory), 'utf8'));
    }
  }

  prepare(sql: string) { return new Prepared(this, sql); }
  async batch(statements: Prepared[]) {
    this.sqlite.exec('BEGIN');
    try {
      const results = statements.map(statement => statement.execute());
      this.sqlite.exec('COMMIT');
      return results;
    } catch (error) {
      this.sqlite.exec('ROLLBACK');
      throw error;
    }
  }
  close() { this.sqlite.close(); }
}

class Prepared {
  constructor(private readonly owner: SqliteD1, readonly sql: string, private readonly values: SQLInputValue[] = []) {}
  bind(...values: SQLInputValue[]) { return new Prepared(this.owner, this.sql, values); }
  async first() { return this.execute().results[0] ?? null; }
  async all() { return this.execute(); }
  async run() { return this.execute(); }
  execute() {
    this.owner.beforeExecute?.(this.sql, this.values);
    const statement = this.owner.sqlite.prepare(this.sql);
    if (statement.columns().length) return { success: true, results: statement.all(...this.values), meta: { changes: 0 } };
    const result = statement.run(...this.values);
    return { success: true, results: [], meta: { changes: Number(result.changes) } };
  }
}
