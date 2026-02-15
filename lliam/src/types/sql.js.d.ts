/**
 * Minimal type declarations for sql.js (WASM SQLite).
 */
declare module "sql.js" {
  interface QueryExecResult {
    columns: string[];
    values: unknown[][];
  }

  interface SqlJsDatabase {
    run(sql: string, params?: unknown[]): void;
    exec(sql: string, params?: unknown[]): QueryExecResult[];
    export(): Uint8Array;
    close(): void;
  }

  interface SqlJsStatic {
    Database: new (data?: ArrayLike<number> | Buffer | null) => SqlJsDatabase;
  }

  export default function initSqlJs(config?: Record<string, unknown>): Promise<SqlJsStatic>;

  export type { SqlJsDatabase, QueryExecResult, SqlJsStatic };
}
