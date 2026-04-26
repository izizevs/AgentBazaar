import { getSql } from '../db/client.js';
import { logger } from '../logger.js';

const RETENTION_DAYS = 30;

/**
 * Deletes processed_signatures rows older than RETENTION_DAYS days.
 * Called by the daily cron started in index.ts.
 *
 * Uses a JS-computed cutoff timestamp as a bind parameter rather than
 * building an INTERVAL string — safer with postgres.js templating.
 */
export async function runRetentionCleanup(): Promise<number> {
  const sql = getSql();

  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);

  const rows = await sql<{ count: string }[]>`
    WITH deleted AS (
      DELETE FROM processed_signatures
      WHERE processed_at < ${cutoff}
      RETURNING 1
    )
    SELECT COUNT(*)::text AS count FROM deleted
  `;

  const deletedCount = Number(rows[0]?.count ?? 0);

  logger.info(
    { deletedCount, retentionDays: RETENTION_DAYS },
    'retention: processed_signatures cleanup complete',
  );

  return deletedCount;
}

/**
 * Starts a repeating retention cron with the given interval.
 * Returns a cleanup function that stops the timer.
 *
 * intervalMs = 0 disables the cron (tests set RETENTION_INTERVAL_MS=0).
 */
export function startRetentionCron(intervalMs: number): () => void {
  if (intervalMs === 0) {
    logger.info('retention: cron disabled (RETENTION_INTERVAL_MS=0)');
    return () => {};
  }

  // Run once 60 s after startup so any backlog is cleared on deploy
  // without delaying the first request.
  const initialDelay = setTimeout(() => {
    runRetentionCleanup().catch((err) =>
      logger.error({ err }, 'retention: initial cleanup failed'),
    );
  }, 60_000);

  const interval = setInterval(() => {
    runRetentionCleanup().catch((err) =>
      logger.error({ err }, 'retention: scheduled cleanup failed'),
    );
  }, intervalMs);

  logger.info({ intervalMs }, 'retention: cron started');

  return () => {
    clearTimeout(initialDelay);
    clearInterval(interval);
  };
}
