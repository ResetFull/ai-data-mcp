import { DataMcpError } from "../errors.js";

interface ErrorWithCode extends Error {
  code?: string;
  syscall?: string;
}

export function toMysqlPublicError(error: unknown): DataMcpError {
  if (error instanceof DataMcpError) {
    return error;
  }

  if (error instanceof Error) {
    const codedError = error as ErrorWithCode;
    if (/^(No connections available\.|Queue limit reached\.)$/.test(error.message)) {
      return new DataMcpError("DATABASE_CONNECTION_LIMIT", "MySQL refused a new connection because connection capacity was reached. Retry after active queries finish or check the server max_connections setting.");
    }
    switch (codedError.code) {
      case "ECONNREFUSED":
        return new DataMcpError("CONNECTION_REFUSED", "MySQL refused the connection. Check the host, port, VPN, and firewall.");
      case "ER_CON_COUNT_ERROR":
        return new DataMcpError("DATABASE_CONNECTION_LIMIT", "The MySQL server refused a new connection because its own max_connections limit was reached.");
      case "ECONNRESET":
      case "PROTOCOL_CONNECTION_LOST":
        return new DataMcpError("CONNECTION_BROKEN", "The MySQL connection closed unexpectedly. Retry the read after the server or network recovers.");
      case "ETIMEDOUT":
        if (codedError.syscall === "connect") {
          return new DataMcpError("CONNECTION_TIMEOUT", "Timed out while connecting to MySQL. Check network reachability, VPN, firewall rules, and the database endpoint.");
        }
        return new DataMcpError("QUERY_TIMEOUT", "The MySQL operation timed out. Narrow the query or increase timeout_ms within the allowed limit.");
      case "PROTOCOL_SEQUENCE_TIMEOUT":
        return new DataMcpError("QUERY_TIMEOUT", "The MySQL operation timed out. Narrow the query or increase timeout_ms within the allowed limit.");
      case "ER_ACCESS_DENIED_ERROR":
        return new DataMcpError("ACCESS_DENIED", "MySQL rejected the configured user or password. Check the local Data MCP secret for this connection.");
      case "ER_DBACCESS_DENIED_ERROR":
        return new DataMcpError("DATABASE_ACCESS_DENIED", "The configured MySQL user cannot access this database.");
      case "ER_BAD_DB_ERROR":
        return new DataMcpError("UNKNOWN_DATABASE", "The configured MySQL database does not exist.");
      case "ER_DUP_ENTRY":
        return new DataMcpError("DUPLICATE_ENTRY", "MySQL rejected a duplicate value for a unique key. Inspect the relevant key using a bounded read.");
      case "ER_PARSE_ERROR":
        return new DataMcpError("SQL_SYNTAX_ERROR", "MySQL rejected the SQL syntax. Check the statement against the server version.");
      case "ER_NO_SUCH_TABLE":
        return new DataMcpError("TABLE_NOT_FOUND", "MySQL could not find the requested table. Inspect the configured schema and table list.");
      default:
        return new DataMcpError("MYSQL_ERROR", "MySQL operation failed. Check permissions, statement constraints, and database availability. Raw driver details are withheld.");
    }
  }

  return new DataMcpError("UNKNOWN_ERROR", "An unexpected MySQL provider error occurred.");
}
