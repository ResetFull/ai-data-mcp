import type { Environment } from "../config.js";
import { DataMcpError } from "../errors.js";
import { assertWriteAllowed } from "../write-policy.js";

const READ_COMMANDS = new Set([
  "DBSIZE", "ECHO", "EXISTS", "GET", "GETRANGE", "HGET", "HEXISTS", "HLEN", "HMGET", "HSCAN", "HSTRLEN", "INFO", "LINDEX", "LLEN",
  "LPOS", "LRANGE", "MGET", "PING", "PTTL", "SCAN", "SCARD", "SINTERCARD", "SISMEMBER", "SMISMEMBER", "SRANDMEMBER", "SSCAN", "STRLEN",
  "TIME", "TTL", "TYPE", "XLEN", "XRANGE", "XREVRANGE", "ZCARD", "ZCOUNT", "ZINTERCARD", "ZLEXCOUNT", "ZMSCORE", "ZRANDMEMBER", "ZRANGE",
  "ZRANK", "ZREVRANGE", "ZREVRANK", "ZSCAN", "ZSCORE",
]);

const WRITE_COMMANDS = new Set([
  "APPEND", "DECR", "DECRBY", "DEL", "EXPIRE", "EXPIREAT", "GETDEL", "GETSET", "HDEL", "HINCRBY", "HINCRBYFLOAT", "HSET", "INCR", "INCRBY",
  "INCRBYFLOAT", "LINSERT", "LPOP", "LPUSH", "LREM", "LSET", "LTRIM", "MSET", "PERSIST", "PEXPIRE", "PEXPIREAT", "RENAME", "RENAMENX", "RPOP",
  "RPUSH", "SADD", "SET", "SETEX", "SETNX", "SREM", "UNLINK", "XADD", "XDEL", "XTRIM", "ZADD", "ZINCRBY", "ZREM", "ZREMRANGEBYLEX",
  "ZREMRANGEBYRANK", "ZREMRANGEBYSCORE",
]);

export function assertRedisReadCommand(args: readonly string[]): string {
  const command = commandName(args);
  if (!READ_COMMANDS.has(command)) {
    throw new DataMcpError(
      "REDIS_COMMAND_BLOCKED",
      `Redis command '${command}' is not allowed by the read-only command policy. Use SCAN instead of KEYS and redis_execute only for explicit non-production writes.`,
    );
  }
  assertBoundedRead(command, args);
  return command;
}

export function assertRedisWriteCommand(args: readonly string[], environment: Environment, writeEnabled = false): string {
  assertWriteAllowed(environment, writeEnabled);
  const command = commandName(args);
  if (!WRITE_COMMANDS.has(command)) {
    throw new DataMcpError("REDIS_COMMAND_BLOCKED", `Redis command '${command}' is not allowed by the explicit write-command policy.`);
  }
  return command;
}

function commandName(args: readonly string[]): string {
  const command = args[0]?.trim().toUpperCase();
  if (!command) {
    throw new DataMcpError("INVALID_REDIS_COMMAND", "Redis command arguments must begin with a command name.");
  }
  return command;
}

function assertBoundedRead(command: string, args: readonly string[]): void {
  if (command === "LRANGE" || command === "ZRANGE" || command === "ZREVRANGE") {
    const start = Number(args[2]);
    const stop = Number(args[3]);
    if (!Number.isInteger(start) || !Number.isInteger(stop) || start < 0 || stop < start || stop - start + 1 > 500) {
      throw new DataMcpError("REDIS_RANGE_BLOCKED", `${command} must use a non-negative range returning at most 500 items.`);
    }
  }
  if (command === "XRANGE" || command === "XREVRANGE") {
    assertCountOption(command, args, true);
  }
  if (command === "SCAN" || command === "HSCAN" || command === "SSCAN" || command === "ZSCAN") {
    assertCountOption(command, args, false);
  }
  if (command === "LPOS" || command === "SRANDMEMBER" || command === "ZRANDMEMBER") {
    assertOptionalCountArgument(command, args);
  }
}

function assertCountOption(command: string, args: readonly string[], required: boolean): void {
  const index = args.findIndex((value) => value.toUpperCase() === "COUNT");
  if (index < 0) {
    if (required) {
      throw new DataMcpError("REDIS_COUNT_REQUIRED", `${command} requires COUNT with a value from 1 through 500.`);
    }
    return;
  }
  const count = Number(args[index + 1]);
  if (!Number.isInteger(count) || count < 1 || count > 500) {
    throw new DataMcpError("REDIS_COUNT_BLOCKED", `${command} COUNT must be from 1 through 500.`);
  }
}

function assertOptionalCountArgument(command: string, args: readonly string[]): void {
  const countIndex = command === "LPOS" ? args.findIndex((value) => value.toUpperCase() === "COUNT") + 1 : 2;
  if (countIndex <= 0 || args[countIndex] === undefined) {
    return;
  }
  const count = Number(args[countIndex]);
  if (!Number.isInteger(count) || Math.abs(count) > 500) {
    throw new DataMcpError("REDIS_COUNT_BLOCKED", `${command} count must return at most 500 items.`);
  }
}
