declare module 'sql.js' {
  export interface SqlJsDatabase {
    run(sql: string, params?: unknown[]): void
    exec(sql: string, params?: unknown[]): Array<{ columns: string[]; values: unknown[][] }>
    export(): Uint8Array
    close(): void
  }

  export interface SqlJsModule {
    Database: new (data?: Uint8Array) => SqlJsDatabase
  }

  export interface SqlJsInitOptions {
    locateFile?: (file: string) => string
  }

  const initSqlJs: (options?: SqlJsInitOptions) => Promise<SqlJsModule>
  export default initSqlJs
}
