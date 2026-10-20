export interface MysqlConnectionLifecycle {
  release(): void | Promise<void>;
  destroy(): void;
}

export async function withMysqlConnection<T>(
  connection: MysqlConnectionLifecycle,
  operation: () => Promise<T>,
): Promise<T> {
  let completed = false;
  try {
    const result = await operation();
    completed = true;
    return result;
  } finally {
    if (completed) {
      try {
        await connection.release();
      } catch (error) {
        try {
          connection.destroy();
        } catch {
          // Preserve the cleanup error.
        }
        throw error;
      }
    } else {
      connection.destroy();
    }
  }
}
