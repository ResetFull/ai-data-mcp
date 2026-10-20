import { createConnection } from "mysql2/promise";
import type { Connection, ConnectionOptions } from "mysql2/promise";
import type { MysqlConnectionConfig } from "./config.js";
import { withMysqlConnection } from "./connection-lifecycle.js";
import { DataMcpError } from "../errors.js";

export type MysqlConnectionFactory = (options: ConnectionOptions) => Promise<Connection>;

export interface MysqlConnectionMiddlewareOptions {
  /** Maximum number of physical MySQL handshakes in flight at once. */
  handshakeConcurrencyLimit?: number;
  /** How long a healthy, unused connection may remain in the idle cache. */
  idleTimeoutMs?: number;
  /** Maximum time spent waiting for a physical connection to become available. */
  acquisitionTimeoutMs?: number;
  /** Frequency of idle connection cleanup. */
  sweepIntervalMs?: number;
  /** Injectable clock for deterministic lifecycle tests. */
  now?: () => number;
}

const DEFAULT_HANDSHAKE_CONCURRENCY_LIMIT = 2;
const DEFAULT_IDLE_TIMEOUT_MS = 60_000;
const DEFAULT_ACQUISITION_TIMEOUT_MS = 30_000;
const DEFAULT_SWEEP_INTERVAL_MS = 15_000;
const CONNECTION_CLOSE_TIMEOUT_MS = 5_000;
const PENDING_SUCCESS = Symbol("pending-success");

type ManagedConnectionState = "idle" | "leased" | "closing" | "destroyed";

interface ConnectionEventSource {
  on?: (event: string, listener: (...arguments_: unknown[]) => void) => unknown;
  off?: (event: string, listener: (...arguments_: unknown[]) => void) => unknown;
  removeListener?: (event: string, listener: (...arguments_: unknown[]) => void) => unknown;
}

interface ManagedConnection {
  readonly connection: Connection;
  readonly connectionId: string;
  state: ManagedConnectionState;
  lastUsedAt: number;
  errorListener: ((...arguments_: unknown[]) => void) | undefined;
  closePromise?: Promise<void>;
}

interface ConnectionBucket {
  readonly idle: ManagedConnection[];
}

interface PendingAcquire {
  readonly configuration: MysqlConnectionConfig;
  readonly password: string;
  readonly resolve: (connection: ManagedConnection) => void;
  readonly reject: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
  settled: boolean;
}

interface NormalizedOptions {
  readonly handshakeConcurrencyLimit: number;
  readonly idleTimeoutMs: number;
  readonly acquisitionTimeoutMs: number;
  readonly sweepIntervalMs: number;
  readonly now: () => number;
}

/**
 * Keeps business request concurrency independent from physical MySQL handshakes.
 *
 * A connection is leased exclusively to one operation because the MySQL wire
 * protocol is not safe to multiplex. Successful operations return it to an
 * idle cache; failed operations destroy it. There is deliberately no maximum
 * number of active or idle connections. Only simultaneous handshakes are
 * bounded to protect an upstream proxy/RDS connection accept path.
 */
export class MysqlConnectionMiddleware {
  private readonly options: NormalizedOptions;
  private readonly buckets = new Map<string, ConnectionBucket>();
  private readonly connections = new Set<ManagedConnection>();
  private readonly pendingAcquires: PendingAcquire[] = [];
  private readonly inFlightCreations = new Set<Promise<void>>();
  private readonly connectionFactory: MysqlConnectionFactory;
  private readonly sweepTimer: ReturnType<typeof setInterval>;
  private creating = 0;
  private pumping = false;
  private closing = false;
  private closePromise?: Promise<void>;

  public constructor(
    connectionFactory: MysqlConnectionFactory = createConnection,
    options: MysqlConnectionMiddlewareOptions = {},
  ) {
    this.connectionFactory = connectionFactory;
    this.options = normalizeOptions(options);
    this.sweepTimer = setInterval(() => this.sweepIdleConnections(), this.options.sweepIntervalMs);
    if (typeof this.sweepTimer === "object" && "unref" in this.sweepTimer) {
      this.sweepTimer.unref();
    }
  }

  public async run<T>(
    configuration: MysqlConnectionConfig,
    password: string,
    operation: (connection: Connection) => Promise<T>,
  ): Promise<T> {
    if (this.closing) {
      throw middlewareClosedError();
    }

    let managedConnection: ManagedConnection;
    try {
      managedConnection = await this.acquire(configuration, password);
    } catch (error) {
      if (this.closing) {
        throw middlewareClosedError();
      }
      throw error;
    }
    if (this.closing || managedConnection.state !== "leased") {
      this.destroy(managedConnection);
      throw middlewareClosedError();
    }
    return withMysqlConnection(
      {
        release: () => this.release(managedConnection),
        destroy: () => this.destroy(managedConnection),
      },
      () => operation(managedConnection.connection),
    );
  }

  public async close(): Promise<void> {
    this.closePromise ??= this.performClose();
    return this.closePromise;
  }

  private async performClose(): Promise<void> {
    this.closing = true;
    clearInterval(this.sweepTimer);

    const pending = this.pendingAcquires.splice(0);
    for (const waiter of pending) {
      this.settlePending(waiter, middlewareClosedError());
    }

    const cleanupPromises: Promise<void>[] = [];
    for (const managedConnection of [...this.connections]) {
      if (managedConnection.state === "idle") {
        cleanupPromises.push(this.end(managedConnection));
      } else if (managedConnection.state === "leased") {
        // Shutdown must not wait for a slow query to finish.
        this.destroy(managedConnection);
      } else if (managedConnection.closePromise) {
        cleanupPromises.push(managedConnection.closePromise);
      }
    }
    cleanupPromises.push(this.drainInFlightCreations());
    await Promise.all(cleanupPromises);
    this.buckets.clear();
  }

  private async acquire(
    configuration: MysqlConnectionConfig,
    password: string,
  ): Promise<ManagedConnection> {
    if (this.closing) {
      throw middlewareClosedError();
    }

    const idle = this.takeIdle(configuration.id);
    if (idle) {
      idle.state = "leased";
      return idle;
    }

    if (this.creating < this.options.handshakeConcurrencyLimit) {
      return this.startCreate(configuration, password);
    }

    return new Promise<ManagedConnection>((resolve, reject) => {
      const pending: PendingAcquire = {
        configuration,
        password,
        resolve,
        reject,
        timer: setTimeout(() => this.expirePending(pending), this.acquisitionTimeout()),
        settled: false,
      };
      this.pendingAcquires.push(pending);
      this.pumpWaiters();
    });
  }

  private startCreate(configuration: MysqlConnectionConfig, password: string): Promise<ManagedConnection> {
    this.creating += 1;
    const factoryPromise = this.openPhysicalConnection(configuration, password);
    // A caller may time out before the driver settles; keep the physical slot occupied until then.
    const physicalCompletion = factoryPromise.then(
      () => {
        this.creating -= 1;
        this.pumpWaiters();
      },
      () => {
        this.creating -= 1;
        this.pumpWaiters();
      },
    );
    this.inFlightCreations.add(physicalCompletion);
    void physicalCompletion.then(
      () => this.inFlightCreations.delete(physicalCompletion),
      () => this.inFlightCreations.delete(physicalCompletion),
    );
    return this.createConnection(configuration, factoryPromise);
  }

  private startCreateForWaiter(waiter: PendingAcquire): void {
    const creation = this.startCreate(waiter.configuration, waiter.password);
    void creation.then(
      (connection) => {
        if (this.closing || connection.state !== "leased") {
          this.destroy(connection);
          this.settlePending(waiter, middlewareClosedError());
          return;
        }
        this.settlePending(waiter, PENDING_SUCCESS, connection);
      },
      (error: unknown) => this.settlePending(waiter, this.closing ? middlewareClosedError() : error),
    );
  }

  private openPhysicalConnection(configuration: MysqlConnectionConfig, password: string): Promise<Connection> {
    try {
      return Promise.resolve(this.connectionFactory(toConnectionOptions(configuration, password)));
    } catch (error) {
      return Promise.reject(error);
    }
  }

  private async createConnection(
    configuration: MysqlConnectionConfig,
    factoryPromise: Promise<Connection>,
  ): Promise<ManagedConnection> {
    const connection = await this.awaitFactory(factoryPromise, configuration.connectTimeoutMs + 1000);
    if (this.closing) {
      destroyQuietly(connection);
      throw middlewareClosedError();
    }

    const managedConnection: ManagedConnection = {
      connection,
      connectionId: configuration.id,
      state: "leased",
      lastUsedAt: this.options.now(),
      errorListener: undefined,
    };
    this.connections.add(managedConnection);
    this.attachErrorListener(managedConnection);
    return managedConnection;
  }

  private async awaitFactory(factoryPromise: Promise<Connection>, timeoutMs: number): Promise<Connection> {
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const timeoutPromise = new Promise<Connection>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        reject(new DataMcpError("CONNECTION_TIMEOUT", "Timed out while establishing a MySQL connection."));
      }, timeoutMs);
    });

    try {
      return await Promise.race([factoryPromise, timeoutPromise]);
    } catch (error) {
      if (timedOut) {
        void factoryPromise.then((connection) => destroyQuietly(connection), () => undefined);
      }
      throw error;
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    }
  }

  private release(managedConnection: ManagedConnection): void {
    if (managedConnection.state !== "leased") {
      return;
    }
    if (this.closing) {
      this.destroy(managedConnection);
      return;
    }

    managedConnection.state = "idle";
    managedConnection.lastUsedAt = this.options.now();
    this.bucket(managedConnection.connectionId).idle.push(managedConnection);
    this.pumpWaiters();
  }

  private destroy(managedConnection: ManagedConnection): void {
    if (managedConnection.state === "destroyed") {
      return;
    }
    managedConnection.state = "destroyed";
    this.removeFromIdle(managedConnection);
    this.connections.delete(managedConnection);
    destroyQuietly(managedConnection.connection);
    this.detachErrorListener(managedConnection);
  }

  private end(managedConnection: ManagedConnection): Promise<void> {
    if (managedConnection.state === "destroyed") {
      return Promise.resolve();
    }
    if (managedConnection.closePromise) {
      return managedConnection.closePromise;
    }

    managedConnection.state = "closing";
    this.removeFromIdle(managedConnection);
    const closePromise = closeConnection(managedConnection.connection, CONNECTION_CLOSE_TIMEOUT_MS).finally(() => {
      managedConnection.state = "destroyed";
      this.connections.delete(managedConnection);
      this.detachErrorListener(managedConnection);
    });
    managedConnection.closePromise = closePromise;
    return closePromise;
  }

  private takeIdle(connectionId: string): ManagedConnection | undefined {
    const bucket = this.bucket(connectionId);
    while (bucket.idle.length > 0) {
      const candidate = bucket.idle.pop();
      if (!candidate || candidate.state !== "idle") {
        continue;
      }
      if (this.options.now() - candidate.lastUsedAt >= this.options.idleTimeoutMs) {
        void this.end(candidate);
        continue;
      }
      return candidate;
    }
    return undefined;
  }

  private pumpWaiters(): void {
    if (this.pumping || this.closing) {
      return;
    }
    this.pumping = true;
    try {
      let madeProgress = true;
      while (madeProgress) {
        madeProgress = false;
        for (let index = 0; index < this.pendingAcquires.length;) {
          const waiter = this.pendingAcquires[index];
          if (!waiter || waiter.settled) {
            this.pendingAcquires.splice(index, 1);
            madeProgress = true;
            continue;
          }

          const idle = this.takeIdle(waiter.configuration.id);
          if (idle) {
            this.pendingAcquires.splice(index, 1);
            idle.state = "leased";
            this.settlePending(waiter, PENDING_SUCCESS, idle);
            madeProgress = true;
            continue;
          }

          if (this.creating < this.options.handshakeConcurrencyLimit) {
            this.pendingAcquires.splice(index, 1);
            this.startCreateForWaiter(waiter);
            madeProgress = true;
            continue;
          }
          index += 1;
        }
      }
    } finally {
      this.pumping = false;
    }
  }

  private expirePending(waiter: PendingAcquire): void {
    if (waiter.settled) {
      return;
    }
    waiter.settled = true;
    const index = this.pendingAcquires.indexOf(waiter);
    if (index >= 0) {
      this.pendingAcquires.splice(index, 1);
    }
    waiter.reject(new DataMcpError("CONNECTION_TIMEOUT", "Timed out waiting for a MySQL connection."));
    this.pumpWaiters();
  }

  private settlePending(
    waiter: PendingAcquire,
    outcome: unknown,
    connection?: ManagedConnection,
  ): void {
    if (waiter.settled) {
      if (connection) {
        this.destroy(connection);
      }
      return;
    }
    waiter.settled = true;
    clearTimeout(waiter.timer);
    if (outcome === PENDING_SUCCESS && connection) {
      waiter.resolve(connection);
    } else {
      waiter.reject(outcome);
    }
  }

  private sweepIdleConnections(): void {
    if (this.closing) {
      return;
    }
    const now = this.options.now();
    for (const bucket of this.buckets.values()) {
      for (const managedConnection of [...bucket.idle]) {
        if (managedConnection.state === "idle" && now - managedConnection.lastUsedAt >= this.options.idleTimeoutMs) {
          void this.end(managedConnection);
        }
      }
    }
  }

  private attachErrorListener(managedConnection: ManagedConnection): void {
    const source = managedConnection.connection as unknown as ConnectionEventSource;
    if (!source.on) {
      return;
    }
    const listener = (): void => {
      if (managedConnection.state === "idle" || managedConnection.state === "leased") {
        this.destroy(managedConnection);
      }
    };
    source.on("error", listener);
    managedConnection.errorListener = listener;
  }

  private detachErrorListener(managedConnection: ManagedConnection): void {
    if (!managedConnection.errorListener) {
      return;
    }
    const source = managedConnection.connection as unknown as ConnectionEventSource;
    const remove = source.off ?? source.removeListener;
    remove?.call(source, "error", managedConnection.errorListener);
    managedConnection.errorListener = undefined;
  }

  private removeFromIdle(managedConnection: ManagedConnection): void {
    const bucket = this.buckets.get(managedConnection.connectionId);
    if (!bucket) {
      return;
    }
    const index = bucket.idle.indexOf(managedConnection);
    if (index >= 0) {
      bucket.idle.splice(index, 1);
    }
  }

  private bucket(connectionId: string): ConnectionBucket {
    let bucket = this.buckets.get(connectionId);
    if (!bucket) {
      bucket = { idle: [] };
      this.buckets.set(connectionId, bucket);
    }
    return bucket;
  }

  private acquisitionTimeout(): number {
    return this.options.acquisitionTimeoutMs;
  }

  private async drainInFlightCreations(): Promise<void> {
    const creations = [...this.inFlightCreations];
    if (creations.length === 0) {
      return;
    }
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => {
      timeoutHandle = setTimeout(resolve, CONNECTION_CLOSE_TIMEOUT_MS);
    });
    await Promise.race([Promise.all(creations), timeout]);
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}

export function toConnectionOptions(configuration: MysqlConnectionConfig, password: string): ConnectionOptions {
  return {
    host: configuration.host,
    port: configuration.port,
    database: configuration.database,
    user: configuration.user,
    password,
    ...(configuration.ssl ? { ssl: { rejectUnauthorized: true } } : {}),
    connectTimeout: configuration.connectTimeoutMs,
    multipleStatements: false,
    supportBigNumbers: true,
    bigNumberStrings: true,
    dateStrings: false,
    enableKeepAlive: true,
  };
}

function normalizeOptions(options: MysqlConnectionMiddlewareOptions): NormalizedOptions {
  return {
    handshakeConcurrencyLimit: positiveInteger(options.handshakeConcurrencyLimit ?? DEFAULT_HANDSHAKE_CONCURRENCY_LIMIT, "handshakeConcurrencyLimit"),
    idleTimeoutMs: positiveInteger(options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS, "idleTimeoutMs"),
    acquisitionTimeoutMs: positiveInteger(options.acquisitionTimeoutMs ?? DEFAULT_ACQUISITION_TIMEOUT_MS, "acquisitionTimeoutMs"),
    sweepIntervalMs: positiveInteger(options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS, "sweepIntervalMs"),
    now: options.now ?? Date.now,
  };
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

async function closeConnection(connection: Connection, timeoutMs: number): Promise<void> {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const endPromise = Promise.resolve().then(() => connection.end());
  const timeoutPromise = new Promise<void>((resolve) => {
    timeoutHandle = setTimeout(() => {
      destroyQuietly(connection);
      resolve();
    }, timeoutMs);
  });
  try {
    await Promise.race([endPromise, timeoutPromise]);
  } catch {
    destroyQuietly(connection);
  }
  if (timeoutHandle) {
    clearTimeout(timeoutHandle);
  }
}

function middlewareClosedError(): DataMcpError {
  return new DataMcpError("MYSQL_MIDDLEWARE_CLOSED", "The MySQL connection middleware is closing.");
}

function destroyQuietly(connection: Connection): void {
  try {
    connection.destroy();
  } catch {
    // Preserve the original query or connection error.
  }
}
