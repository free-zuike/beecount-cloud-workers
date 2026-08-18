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

  export interface InitSqlJsConfig {
    wasmBinary?: Uint8Array;
    instantiateWasm?: (imports: WebAssembly.Imports, callback: (module: WebAssembly.Module, instance: WebAssembly.Instance) => void) => Record<string, unknown>;
  }

  export default function initSqlJs(config?: InitSqlJsConfig): Promise<SqlJsStatic>;
}

// .wasm 文件导入类型声明（wrangler 构建时处理）
declare module '*.wasm' {
  const wasm: WebAssembly.Module;
  export default wasm;
}