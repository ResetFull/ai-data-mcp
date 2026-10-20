import sqlParser from "node-sql-parser";
import { DataMcpError } from "../errors.js";

const MAX_SQL_LENGTH = 100_000;
const READ_TYPES = new Set(["select", "show", "desc", "describe", "explain"]);
const DML_TYPES = new Set(["insert", "replace", "update", "delete"]);
const SESSION_CONTROL = new Set(["BEGIN", "START", "COMMIT", "ROLLBACK", "SAVEPOINT", "RELEASE", "SET", "USE", "LOCK", "UNLOCK"]);
const parser = new sqlParser.Parser();

interface SqlAst {
  type?: string;
  where?: unknown;
}

export interface WriteSqlOptions {
  allowAll?: boolean;
  allowDdl?: boolean;
}

export interface ReadAnalysis {
  type: string;
  canWrapWithLimit: boolean;
}

export function analyzeReadSql(sql: string): ReadAnalysis {
  const analysis = analyzeSingleStatement(sql);
  if (!READ_TYPES.has(analysis.type)) {
    throw new DataMcpError("WRITE_SQL_REJECTED", `mysql_query only accepts read-only statements; received '${analysis.firstKeyword}'.`);
  }

  const maskedSql = maskCommentsAndQuotedContent(sql);
  const prohibitedPattern = /\bINTO\b|\bFOR\s+(?:UPDATE|SHARE)\b|\bLOCK\s+IN\s+SHARE\s+MODE\b|\b(?:GET_LOCK|RELEASE_LOCK|SLEEP|BENCHMARK|LOAD_FILE)\s*\(|@[A-Za-z0-9_$]+\s*:=/i;
  if (prohibitedPattern.test(maskedSql)) {
    throw new DataMcpError("UNSAFE_READ_REJECTED", "The read query contains a locking, file, session-mutation, or resource-exhaustion construct that Data MCP does not allow.");
  }

  return {
    type: analysis.type,
    canWrapWithLimit: analysis.type === "select",
  };
}

export function analyzeExecutableSql(sql: string, options: WriteSqlOptions = {}): string {
  const analysis = analyzeSingleStatement(sql);
  if (READ_TYPES.has(analysis.type)) {
    throw new DataMcpError("READ_SQL_IN_WRITE_TOOL", "Use mysql_query for SELECT, SHOW, DESCRIBE, or EXPLAIN statements.");
  }
  if (SESSION_CONTROL.has(analysis.firstKeyword)) {
    throw new DataMcpError("SESSION_CONTROL_REJECTED", "Transaction and session-control statements are not accepted. Use mysql_execute_transaction for DML transactions.");
  }
  if (!DML_TYPES.has(analysis.type)) {
    if (!new Set(["create", "alter", "drop", "truncate", "rename"]).has(analysis.type)) {
      throw new DataMcpError("SQL_WRITE_TYPE_BLOCKED", "Only DML and explicitly enabled DDL are accepted; administrative statements are blocked.");
    }
    if (!options.allowDdl) {
      throw new DataMcpError("DDL_OPT_IN_REQUIRED", "DDL requires allow_ddl=true and cannot be rolled back reliably.");
    }
  }
  if ((analysis.type === "update" || analysis.type === "delete") && !analysis.where && !options.allowAll) {
    throw new DataMcpError("UNFILTERED_WRITE_BLOCKED", "UPDATE or DELETE without WHERE requires allow_all=true.");
  }
  return analysis.type;
}

export function assertTransactionDml(sql: string, allowAll = false): string {
  const analysis = analyzeSingleStatement(sql);
  if (!DML_TYPES.has(analysis.type)) {
    throw new DataMcpError("NON_DML_TRANSACTION_REJECTED", "mysql_execute_transaction accepts only INSERT, REPLACE, UPDATE, and DELETE. Run DDL separately with mysql_execute because MySQL DDL may implicitly commit.");
  }
  return analyzeExecutableSql(sql, { allowAll });
}

export function limitSelectSql(sql: string, maxRows: number): string {
  const statement = sql.trim().replace(/;\s*$/, "");
  return `SELECT * FROM (${statement}) AS __data_mcp_limited LIMIT ${maxRows + 1}`;
}

function analyzeSingleStatement(sql: string): { type: string; firstKeyword: string; where?: unknown } {
  const trimmed = sql.trim();
  if (!trimmed) {
    throw new DataMcpError("EMPTY_SQL", "SQL must not be empty.");
  }
  if (trimmed.length > MAX_SQL_LENGTH) {
    throw new DataMcpError("SQL_TOO_LONG", `SQL must not exceed ${MAX_SQL_LENGTH} characters.`);
  }
  if (trimmed.includes("\0")) {
    throw new DataMcpError("INVALID_SQL", "SQL must not contain NUL characters.");
  }

  const firstKeyword = extractFirstKeyword(trimmed);
  let ast: SqlAst | SqlAst[];
  try {
    ast = parser.astify(trimmed, { database: "MySQL" }) as SqlAst | SqlAst[];
  } catch {
    throw new DataMcpError("UNPARSABLE_SQL", "Data MCP could not parse this as one MySQL statement. Check the syntax and avoid client-only commands such as DELIMITER.");
  }

  const statements = Array.isArray(ast) ? ast : [ast];
  if (statements.length !== 1 || !statements[0]) {
    throw new DataMcpError("MULTIPLE_STATEMENTS_REJECTED", "Exactly one SQL statement is allowed per tool call.");
  }
  const type = statements[0].type?.toLowerCase();
  if (!type) {
    throw new DataMcpError("UNKNOWN_SQL_TYPE", "Data MCP could not determine the SQL statement type.");
  }
  return { type, firstKeyword, where: statements[0].where };
}

function extractFirstKeyword(sql: string): string {
  const masked = maskLeadingComments(sql).trimStart();
  const match = /^([A-Za-z]+)/.exec(masked);
  if (!match?.[1]) {
    throw new DataMcpError("UNKNOWN_SQL_TYPE", "SQL must start with a recognizable MySQL keyword.");
  }
  return match[1].toUpperCase();
}

function maskLeadingComments(sql: string): string {
  let remaining = sql;
  while (true) {
    remaining = remaining.trimStart();
    if (remaining.startsWith("--") || remaining.startsWith("#")) {
      const newline = remaining.indexOf("\n");
      return newline === -1 ? "" : maskLeadingComments(remaining.slice(newline + 1));
    }
    if (remaining.startsWith("/*")) {
      const end = remaining.indexOf("*/", 2);
      if (end === -1) {
        throw new DataMcpError("UNTERMINATED_COMMENT", "SQL contains an unterminated block comment.");
      }
      remaining = remaining.slice(end + 2);
      continue;
    }
    return remaining;
  }
}

function maskCommentsAndQuotedContent(sql: string): string {
  let output = "";
  let index = 0;
  while (index < sql.length) {
    const current = sql[index] ?? "";
    const next = sql[index + 1] ?? "";
    if (current === "'" || current === '"' || current === "`") {
      const quote = current;
      output += " ";
      index += 1;
      while (index < sql.length) {
        const character = sql[index] ?? "";
        output += " ";
        index += 1;
        if (character === "\\") {
          if (index < sql.length) {
            output += " ";
            index += 1;
          }
          continue;
        }
        if (character === quote) {
          if (sql[index] === quote) {
            output += " ";
            index += 1;
            continue;
          }
          break;
        }
      }
      continue;
    }
    if ((current === "-" && next === "-") || current === "#") {
      const newline = sql.indexOf("\n", index + 1);
      if (newline === -1) {
        output += " ".repeat(sql.length - index);
        break;
      }
      output += " ".repeat(newline - index);
      index = newline;
      continue;
    }
    if (current === "/" && next === "*") {
      const end = sql.indexOf("*/", index + 2);
      if (end === -1) {
        output += " ".repeat(sql.length - index);
        break;
      }
      output += " ".repeat(end + 2 - index);
      index = end + 2;
      continue;
    }
    output += current;
    index += 1;
  }
  return output;
}
