/**
 * SATI mock — returns canned 0-reputation responses for all agents.
 * Used in M0 tests where reputation lookups are not yet required.
 * In M1 this stub can be replaced with a real SATI client or a more
 * sophisticated mock that maps agent IDs to preset scores.
 */

export interface SatiReputationResponse {
  agentId: string;
  score: number;
  jobsCompleted: number;
  lastUpdatedAt: number;
}

/**
 * Return a canned 0-reputation response for any agent ID.
 */
export function getSatiReputation(agentId: string): SatiReputationResponse {
  return {
    agentId,
    score: 0,
    jobsCompleted: 0,
    lastUpdatedAt: 0,
  };
}
