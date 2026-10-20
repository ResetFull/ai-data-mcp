import { afterEach, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directories: string[] = [];
afterEach(async () => { for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }); });

async function environment(): Promise<NodeJS.ProcessEnv> {
  const path = await mkdtemp(join(tmpdir(), "data-mcp-cli-"));
  directories.push(path);
  return { ...process.env, DATA_MCP_CONFIG: join(path, "connections.json"), DATA_MCP_SECRETS_FILE: join(path, "secrets.json"), DATA_MCP_SECRETS_JSON: "" };
}

describe("public CLI", () => {
  it("should_preserve_existing_configuration_when_initialization_is_repeated", async () => {
    const env = await environment();
    execFileSync(process.execPath, ["scripts/config.mjs", "init"], { env });
    const initial = await readFile(env.DATA_MCP_CONFIG!, "utf8");
    execFileSync(process.execPath, ["scripts/config.mjs", "validate"], { env });
    await writeFile(env.DATA_MCP_SECRETS_FILE!, "preserve-this-existing-file");
    execFileSync(process.execPath, ["scripts/config.mjs", "init"], { env });
    expect(await readFile(env.DATA_MCP_CONFIG!, "utf8")).toBe(initial);
    expect(await readFile(env.DATA_MCP_SECRETS_FILE!, "utf8")).toBe("preserve-this-existing-file");
  });

  it("should_fail_configured_smoke_when_configuration_is_missing", async () => {
    const result = spawnSync(process.execPath, ["scripts/verify-stdio.mjs", "--configured"], { env: await environment(), encoding: "utf8", timeout: 15000 });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("CONFIG_NOT_FOUND");
    expect(result.stdout).not.toContain('"ok":true');
  });
});
