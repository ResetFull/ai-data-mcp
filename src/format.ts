export type ResponseFormat = "markdown" | "json";

export function formatOutput(output: Record<string, unknown>, format: ResponseFormat, markdown: () => string): string {
  return format === "json" ? JSON.stringify(output, null, 2) : markdown();
}

export function markdownTable(rows: ReadonlyArray<Record<string, unknown>>, columns?: string[]): string {
  if (rows.length === 0) {
    return "_No rows returned._";
  }
  const selectedColumns = columns ?? Object.keys(rows[0] ?? {});
  const header = `| ${selectedColumns.map(escapeCell).join(" | ")} |`;
  const separator = `| ${selectedColumns.map(() => "---").join(" | ")} |`;
  const body = rows.map((row) => `| ${selectedColumns.map((column) => escapeCell(row[column])).join(" | ")} |`);
  return [header, separator, ...body].join("\n");
}

function escapeCell(value: unknown): string {
  if (value === null || value === undefined) {
    return "NULL";
  }
  const rendered = typeof value === "object" ? JSON.stringify(value) : String(value);
  return rendered.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}
