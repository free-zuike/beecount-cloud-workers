// sql.js (https://github.com/sql-js/sql.js) 最小类型声明
declare module 'sql.js' {
  export interface BindParams {
    [key: string]: unknown;
  }

  export interface SqlJsStatic {
    Database: new (data?: Uint8Array) => Database;
  }

  export interface Statement {
    run(params?: unknown[] | BindParams): void;
    free(): void;
  }

  export interface Database {
    run(sql: string, params?: unknown[] | BindParams): void;
    prepare(sql: string): Statement;
    exec(sql: string): { columns: string[]; values: unknown[][] }[];
    export(): Uint8Array;
    close(): void;
  }

  export default function initSqlJs(config?: { wasmBinary?: Uint8Array }): Promise<SqlJsStatic>;
}