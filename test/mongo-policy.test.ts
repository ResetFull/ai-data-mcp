import { describe, expect, it } from "vitest";
import { assertMongoWriteAllowed, assertReadOnlyPipeline } from "../src/mongo/policy.js";

describe("MongoDB policy", () => {
  it("should_reject_output_stages_from_read_only_aggregation", () => {
    expect(() => assertReadOnlyPipeline([{ $match: { status: "active" } }, { $out: "export" }])).toThrow(/\$out/i);
    expect(() => assertReadOnlyPipeline([{ $merge: { into: "summary" } }])).toThrow(/\$merge/i);
  });

  it("should_allow_read_only_aggregation_stages", () => {
    expect(() => assertReadOnlyPipeline([{ $match: { status: "active" } }, { $limit: 20 }])).not.toThrow();
  });

  it("should_block_production_writes_and_unbounded_destructive_filters", () => {
    expect(() => assertMongoWriteAllowed("prod", { _id: "1" }, false)).toThrow(/read-only/i);
    expect(() => assertMongoWriteAllowed("test", {}, false, true)).toThrow(/empty filter/i);
    expect(() => assertMongoWriteAllowed("test", {}, true, true)).not.toThrow();
  });
});
