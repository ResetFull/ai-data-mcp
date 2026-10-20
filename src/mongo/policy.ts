import type { Environment } from "../config.js";
import { DataMcpError } from "../errors.js";
import { assertWriteAllowed } from "../write-policy.js";

const WRITE_STAGES = new Set(["$out", "$merge"]);

export function assertReadOnlyPipeline(pipeline: ReadonlyArray<Record<string, unknown>>): void {
  for (const stage of pipeline) {
    assertNoWriteStage(stage);
  }
}

export function assertMongoWriteAllowed(
  environment: Environment,
  filter: Record<string, unknown>,
  allowAll: boolean,
  writeEnabled = false,
): void {
  assertWriteAllowed(environment, writeEnabled);
  if (Object.keys(filter).length === 0 && !allowAll) {
    throw new DataMcpError(
      "EMPTY_FILTER_BLOCKED",
      "MongoDB update/delete with an empty filter is blocked. Set allow_all=true only when the full-collection operation is intentional.",
    );
  }
}

function assertNoWriteStage(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach(assertNoWriteStage);
    return;
  }
  if (!value || typeof value !== "object") {
    return;
  }
  for (const [key, nested] of Object.entries(value)) {
    if (WRITE_STAGES.has(key.toLowerCase())) {
      throw new DataMcpError(
        "MONGO_WRITE_STAGE_BLOCKED",
        `MongoDB aggregation stage '${key}' is not allowed in the read-only aggregate tool.`,
      );
    }
    assertNoWriteStage(nested);
  }
}
