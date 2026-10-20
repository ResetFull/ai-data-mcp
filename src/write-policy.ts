import type { Environment } from "./config.js";
import { DataMcpError } from "./errors.js";

export function assertWriteAllowed(
  environment: Environment,
  writeEnabled: boolean,
  productionCode = "PRODUCTION_READ_ONLY",
): void {
  if (environment === "prod") {
    throw new DataMcpError(productionCode, "Production connections are always read-only.");
  }
  if (!writeEnabled) {
    throw new DataMcpError("WRITE_DISABLED", "Writes are disabled. Explicitly set write_enabled=true for this non-production connection in local configuration.");
  }
}

export async function runWrite<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    const name = error instanceof Error ? error.name : "";
    if (/TIMEOUT|ETIMEDOUT|ECONNRESET|EPIPE|CONNECTION_LOST|CONNECTION_BROKEN|SOCKET|ABORT/i.test(`${code} ${name}`)
      || /MongoNetwork|MongoServerSelection|MongoOperationTimeout|MongoWriteConcern|SocketClosed|ClientClosed/i.test(name)) {
      throw new DataMcpError("WRITE_OUTCOME_UNKNOWN", "The write was interrupted. Its database outcome and rollback are not confirmed; inspect the target before retrying. No automatic retry is performed.");
    }
    throw error;
  }
}
