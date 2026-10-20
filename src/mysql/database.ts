import type { Connection, FieldPacket, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import type { MysqlConnectionConfig } from "./config.js";
import { MysqlConfigStore } from "./config.js";
import { MysqlConnectionMiddleware, type MysqlConnectionFactory } from "./connection-middleware.js";
import { analyzeExecutableSql, analyzeReadSql, assertTransactionDml, limitSelectSql, type WriteSqlOptions } from "./sql-policy.js";
import { assertWriteAllowed, runWrite } from "../write-policy.js";

export type SqlParameter = string | number | boolean | null;

export interface QueryData {
  connection_id: string;
  columns: string[];
  rows: Record<string, unknown>[];
  row_count: number;
  truncated: boolean;
}

export interface ExecutionData {
  statement_type: string;
  affected_rows: number;
  changed_rows: number;
  insert_id: string;
  warning_count: number;
}

export interface TransactionData {
  connection_id: string;
  committed: boolean;
  statements: ExecutionData[];
  total_affected_rows: number;
}

export class MysqlDatabaseManager {
  private readonly connectionMiddleware: MysqlConnectionMiddleware;

  public constructor(
    private readonly configStore: MysqlConfigStore,
    connectionFactory?: MysqlConnectionFactory,
  ) {
    this.connectionMiddleware = new MysqlConnectionMiddleware(connectionFactory);
  }

  public async query(
    connectionId: string,
    sql: string,
    parameters: SqlParameter[],
    maxRows: number,
    timeoutMs: number,
  ): Promise<QueryData> {
    const analysis = analyzeReadSql(sql);
    return this.withConnection(connectionId, async (connection) => {
      await connection.query({ sql: "START TRANSACTION READ ONLY", timeout: timeoutMs });
      const effectiveSql = analysis.canWrapWithLimit ? limitSelectSql(sql, maxRows) : sql;
      const [rows, fields] = await connection.query<RowDataPacket[]>({
        sql: effectiveSql,
        values: parameters,
        timeout: timeoutMs,
      });
      const normalizedRows = rows.map(normalizeRow);
      const limitedRows = trimRows(normalizedRows, maxRows);
      await connection.query({ sql: "ROLLBACK", timeout: Math.min(timeoutMs, 5000) });
      return {
        connection_id: connectionId,
        columns: fields.map((field: FieldPacket) => field.name),
        rows: limitedRows.rows,
        row_count: limitedRows.rows.length,
        truncated: limitedRows.truncated,
      };
    });
  }

  public async execute(
    connectionId: string,
    sql: string,
    parameters: SqlParameter[],
    timeoutMs: number,
    options: WriteSqlOptions = {},
  ): Promise<ExecutionData> {
    const statementType = analyzeExecutableSql(sql, options);
    const connectionConfig = await this.assertWritable(connectionId);
    return this.withConnectionConfig(connectionConfig, async (connection) => {
      const [result] = await runWrite(() => connection.query<ResultSetHeader>({ sql, values: parameters, timeout: timeoutMs }));
      return toExecutionData(statementType, result);
    });
  }

  public async executeTransaction(
    connectionId: string,
    statements: ReadonlyArray<{ sql: string; parameters: SqlParameter[] }>,
    timeoutMs: number,
    allowAll = false,
  ): Promise<TransactionData> {
    const statementTypes = statements.map(({ sql }) => assertTransactionDml(sql, allowAll));
    const connectionConfig = await this.assertWritable(connectionId);
    const results: ExecutionData[] = [];
    return this.withConnectionConfig(connectionConfig, async (connection) => runWrite(async () => {
      await connection.query({ sql: "START TRANSACTION", timeout: timeoutMs });
      try {
        for (const [index, statement] of statements.entries()) {
          const [result] = await connection.query<ResultSetHeader>({
            sql: statement.sql,
            values: statement.parameters,
            timeout: timeoutMs,
          });
          results.push(toExecutionData(statementTypes[index] ?? "unknown", result));
        }
        await connection.query({ sql: "COMMIT", timeout: timeoutMs });
      } catch (error) {
        try {
          await connection.query({ sql: "ROLLBACK", timeout: Math.min(timeoutMs, 5000) });
        } catch {
          // A disconnected session cannot confirm rollback; preserve the original error.
        }
        throw error;
      }
      return {
        connection_id: connectionId,
        committed: true,
        statements: results,
        total_affected_rows: results.reduce((total, result) => total + result.affected_rows, 0),
      };
    }));
  }

  public async close(): Promise<void> {
    await this.connectionMiddleware.close();
  }

  private async withConnection<T>(
    connectionId: string,
    operation: (connection: Connection) => Promise<T>,
  ): Promise<T> {
    const connectionConfig = await this.configStore.getConnection(connectionId);
    return this.withConnectionConfig(connectionConfig, operation);
  }

  private async withConnectionConfig<T>(
    connectionConfig: MysqlConnectionConfig,
    operation: (connection: Connection) => Promise<T>,
  ): Promise<T> {
    const password = await this.configStore.getPassword(connectionConfig.id);
    return this.connectionMiddleware.run(connectionConfig, password, operation);
  }

  private async assertWritable(connectionId: string): Promise<MysqlConnectionConfig> {
    const connection = await this.configStore.getConnection(connectionId);
    assertWriteAllowed(connection.environment, connection.write_enabled, "PRODUCTION_WRITE_REJECTED");
    return connection;
  }
}

function normalizeRow(row: RowDataPacket): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, normalizeValue(value)]));
}

function normalizeValue(value: unknown): unknown {
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Buffer.isBuffer(value)) {
    const maximumBytes = 4096;
    const truncated = value.length > maximumBytes;
    return {
      encoding: "base64",
      data: value.subarray(0, maximumBytes).toString("base64"),
      truncated,
      original_bytes: value.length,
    };
  }
  if (typeof value === "string" && value.length > 10_000) {
    return `${value.slice(0, 10_000)}… [field truncated]`;
  }
  return value;
}

function trimRows(rows: Record<string, unknown>[], maxRows: number): { rows: Record<string, unknown>[]; truncated: boolean } {
  const maximumCharacters = 50_000;
  const selected: Record<string, unknown>[] = [];
  let characters = 0;
  for (const row of rows.slice(0, maxRows + 1)) {
    const serializedLength = JSON.stringify(row).length;
    if (selected.length >= maxRows || characters + serializedLength > maximumCharacters) {
      return { rows: selected, truncated: true };
    }
    selected.push(row);
    characters += serializedLength;
  }
  return { rows: selected, truncated: rows.length > selected.length };
}

function toExecutionData(statementType: string, result: ResultSetHeader): ExecutionData {
  return {
    statement_type: statementType,
    affected_rows: result.affectedRows,
    changed_rows: result.changedRows,
    insert_id: String(result.insertId),
    warning_count: result.warningStatus,
  };
}
