#!/usr/bin/env node
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { startHttpServer, type RunningHttpServer } from "./http-server.js";
import { createDataServer } from "./server.js";

if (process.argv.includes("--help")) {
  process.stderr.write("Data MCP server (MySQL, Redis, and MongoDB providers enabled). Use --transport=stdio (default) or --transport=http. HTTP requires DATA_MCP_HTTP_TOKEN.\n");
  process.exit(0);
}

const runtime = createDataServer();

let runningHttpServer: RunningHttpServer | undefined;
let closeStdio: (() => Promise<void>) | undefined;
let shutdownPromise: Promise<void> | undefined;

function shutdown(exitCode: number): Promise<void> {
  shutdownPromise ??= (async () => {
    try {
      await closeStdio?.();
      await runningHttpServer?.close();
      await runtime.close();
    } finally {
      process.exit(exitCode);
    }
  })();
  return shutdownPromise;
}

process.once("SIGINT", () => void shutdown(0));
process.once("SIGTERM", () => void shutdown(0));
process.once("uncaughtException", () => void shutdown(1));
process.once("unhandledRejection", () => void shutdown(1));

async function main(): Promise<void> {
  const transport = readTransport();
  if (transport === "stdio") {
    const handle = serveStdio(runtime.createServer, { onerror: () => process.stderr.write("[data-mcp] stdio transport error\n") });
    closeStdio = () => handle.close();
    process.stdin.once("end", () => void shutdown(0));
    process.stdin.once("close", () => void shutdown(0));
    process.once("disconnect", () => void shutdown(0));
    process.stderr.write("Data MCP server running on stdio\n");
    return;
  }

  const token = requireEnvironmentVariable("DATA_MCP_HTTP_TOKEN");
  const host = process.env.DATA_MCP_HTTP_HOST ?? "127.0.0.1";
  if (host !== "127.0.0.1" && host !== "::1") {
    throw new Error("DATA_MCP_HTTP_HOST must be a loopback address (127.0.0.1 or ::1).");
  }
  const port = readPort(process.env.DATA_MCP_HTTP_PORT ?? "17890");
  runningHttpServer = await startHttpServer(runtime.createServer, { host, port, token });
  process.stderr.write(`Data MCP server running at http://${host}:${runningHttpServer.port}/mcp\n`);
}

function readTransport(): "stdio" | "http" {
  const argument = process.argv.find((value) => value.startsWith("--transport="));
  const value = argument?.slice("--transport=".length) ?? process.env.DATA_MCP_TRANSPORT ?? "stdio";
  if (value !== "stdio" && value !== "http") {
    throw new Error(`Unsupported transport '${value}'. Expected stdio or http.`);
  }
  return value;
}

function readPort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("DATA_MCP_HTTP_PORT must be an integer between 1 and 65535.");
  }
  return port;
}

function requireEnvironmentVariable(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required for HTTP transport.`);
  }
  return value;
}

void main().catch(() => void shutdown(1));
