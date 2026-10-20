import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function temporaryConfiguration() {
  const directory = await mkdtemp(join(tmpdir(), "data-mcp-fixture-"));
  const identities = [
    { id: "local-disabled", environment: "local", write_enabled: false },
    { id: "test-enabled", environment: "test", write_enabled: true },
    { id: "prod-readonly", environment: "prod", write_enabled: true },
  ];
  const configuration = {
    mysql: { connections: identities.map(identity => ({ ...identity, host: "127.0.0.1", port: 1, database: "demo", user: "demo" })) },
    redis: { connections: identities.map(identity => ({ ...identity, host: "127.0.0.1", port: 1 })) },
    mongo: { connections: identities.map(identity => ({ ...identity, database: "demo" })) },
  };
  const secrets = {
    mysql: Object.fromEntries(identities.map(({ id }) => [id, { password: "synthetic-demo-password" }])),
    mongo: Object.fromEntries(identities.map(({ id }) => [id, { uri: "mongodb://127.0.0.1:1/demo" }])),
  };
  const configPath = join(directory, "connections.json");
  const secretsPath = join(directory, "secrets.json");
  await writeFile(configPath, JSON.stringify(configuration), { mode: 0o600 });
  await writeFile(secretsPath, JSON.stringify(secrets), { mode: 0o600 });
  return {
    configuration,
    environment: { DATA_MCP_CONFIG: configPath, DATA_MCP_SECRETS_FILE: secretsPath, DATA_MCP_SECRETS_JSON: "" },
    close: () => rm(directory, { recursive: true, force: true }),
  };
}
