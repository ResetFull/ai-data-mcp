import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

export async function connectStdio(environment = {}) {
  const child = spawn(process.execPath, ["dist/index.js", "--transport=stdio"], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: { ...process.env, ...environment },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const pending = new Map();
  let nextId = 0;
  child.stderr.resume();
  const lines = createInterface({ input: child.stdout });
  lines.on("line", line => {
    try {
      const message = JSON.parse(line);
      const waiter = pending.get(message.id);
      if (waiter) {
        pending.delete(message.id);
        clearTimeout(waiter.timer);
        message.error ? waiter.reject(new Error(`MCP protocol error ${message.error.code}`)) : waiter.resolve(message.result);
      }
    } catch {
      failPending(new Error("MCP stdout contained invalid JSON."));
    }
  });
  child.on("error", () => failPending(new Error("MCP subprocess failed to start.")));
  child.on("exit", () => failPending(new Error("MCP subprocess exited before responding.")));

  function failPending(error) {
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    pending.clear();
  }

  function rpc(method, params) {
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`MCP ${method} exceeded the test deadline.`));
      }, 30000);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  async function close() {
    lines.close();
    failPending(new Error("MCP test client closed."));
    if (child.exitCode !== null || child.signalCode !== null) return;
    const stopped = once(child, "exit");
    child.stdin.end();
    const timer = setTimeout(() => child.kill("SIGTERM"), 3000);
    try { await stopped; } finally { clearTimeout(timer); }
  }

  try {
    await rpc("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "data-mcp-verification", version: "1.0.0" } });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) + "\n");
    return { rpc, call: (name, args) => rpc("tools/call", { name, arguments: args }), close };
  } catch (error) {
    await close();
    throw error;
  }
}

export function requireSuccess(result, label) {
  if (!result || result.isError || !result.structuredContent) {
    const code = result?.structuredContent?.error?.code ?? "TOOL_FAILED";
    throw new Error(`${label}: ${code}`);
  }
  return result.structuredContent;
}
