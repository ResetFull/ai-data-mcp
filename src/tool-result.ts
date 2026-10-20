import { DataMcpError } from "./errors.js";

export interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export interface PublicToolError {
  code: string;
  message: string;
}

export function success(output: Record<string, unknown>, text: string): ToolResult {
  const result = { content: [{ type: "text" as const, text }], structuredContent: output };
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > 100_000) {
    throw new DataMcpError("RESPONSE_TOO_LARGE", "The response exceeds 100000 bytes. Narrow the query, projection, range, or requested page size.");
  }
  return result;
}

export async function safely(
  operation: () => Promise<ToolResult>,
  toPublicError: (error: unknown) => PublicToolError,
): Promise<ToolResult> {
  try {
    return await operation();
  } catch (error) {
    const publicError = toPublicError(error);
    return {
      content: [{ type: "text", text: `${publicError.code}: ${publicError.message}` }],
      structuredContent: { error: publicError },
      isError: true,
    };
  }
}
