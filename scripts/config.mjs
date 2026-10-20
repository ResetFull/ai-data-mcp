import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DataConfigStore } from "../dist/config.js";

const base = join(homedir(), ".config", "data-mcp");
const targets = [
  [process.env.DATA_MCP_CONFIG ?? join(base, "connections.json"), "connections.example.json"],
  [process.env.DATA_MCP_SECRETS_FILE ?? join(base, "secrets.json"), "secrets.example.json"],
];

async function main() {
  const command = process.argv[2];
  if (command === "init") {
    for (const [path, example] of targets) {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const template = await readFile(new URL(`../config/${example}`, import.meta.url));
      try {
        await writeFile(path, template, { flag: "wx", mode: 0o600 });
        process.stdout.write(`Created ${example.replace(".example", "")} outside the source tree.\n`);
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        process.stdout.write(`Preserved existing ${example.replace(".example", "")}.\n`);
      }
    }
    process.stdout.write("Edit ~/.config/data-mcp, or the DATA_MCP_CONFIG / DATA_MCP_SECRETS_FILE overrides. Restart the server after changes.\n");
    return;
  }
  if (command !== "validate") throw new Error("Use init or validate.");
  const { configuration, secrets } = await new DataConfigStore().load();
  for (const provider of ["mysql", "redis", "mongo"]) {
    for (const connection of configuration[provider]?.connections ?? []) {
      if (provider !== "redis" && !secrets[provider]?.[connection.id]) {
        throw new Error(`A configured ${provider} connection is missing its secret.`);
      }
    }
  }
  process.stdout.write("Configuration schema and secret references are valid. Connectivity and database grants were not tested.\n");
}

main().catch(() => {
  process.stderr.write("Configuration operation failed. Check JSON, connection IDs, secret references, file access, and docs/configuration.md.\n");
  process.exitCode = 1;
});
