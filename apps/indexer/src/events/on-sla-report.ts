import { getSql } from '../db/client.js';
import { logger } from '../logger.js';
import type { SlaReportData } from './escrow-decoder.js';
import { decodeSlaSeverity } from './escrow-decoder.js';

export async function onSlaReport(txSignature: string, data: SlaReportData): Promise<void> {
  const escrowPubkey = data.escrow.toString();
  const seller = data.seller.toString();
  const severity = decodeSlaSeverity(data.severity);
  // refundBps is basis points (0–10000); convert to pct (0–100).
  const refundPct = Math.round(Number(data.refundBps.toString()) / 100);
  const score = data.score;
  const computedAt = new Date(Number(data.confirmedAt.toString()) * 1000);

  const sql = getSql();

  await sql`
    INSERT INTO sla_reports (escrow_pubkey, severity, refund_pct, computed_at)
    VALUES (${escrowPubkey}, ${severity}, ${refundPct}, ${computedAt})
  `;

  // Atomic UPSERT: first job seeds the row; subsequent jobs increment and
  // recompute avg_score from the running total_score to avoid read-modify-write races.
  await sql`
    INSERT INTO agent_reputation (wallet, jobs_completed, avg_score, total_score, last_updated)
    VALUES (${seller}, 1, ${score}, ${score}, now())
    ON CONFLICT (wallet) DO UPDATE
    SET jobs_completed = agent_reputation.jobs_completed + 1,
        total_score    = agent_reputation.total_score + ${score},
        avg_score      = ROUND(
          (agent_reputation.total_score + ${score})::numeric
          / (agent_reputation.jobs_completed + 1)
        ),
        last_updated   = now()
  `;

  logger.info(
    { txSignature, escrowPubkey, seller, severity, refundPct, score },
    'SLAReport — inserted + reputation updated',
  );
}
