// Cluster constants for AgentBazaar dashboard

export const SOLANA_NETWORK = (process.env.NEXT_PUBLIC_SOLANA_NETWORK as string) ?? 'devnet';

export const RPC_ENDPOINT =
  process.env.NEXT_PUBLIC_SOLANA_RPC_URL ?? 'https://api.devnet.solana.com';

export const DEVNET_USDC_MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';

export const CIRCLE_FAUCET_URL = 'https://faucet.circle.com/';

export const SOLANA_FAUCET_URL = 'https://faucet.solana.com/';

export const EXPLORER_BASE = 'https://explorer.solana.com';

export function explorerTxUrl(sig: string): string {
  return `${EXPLORER_BASE}/tx/${sig}?cluster=devnet`;
}

export function explorerAddressUrl(address: string): string {
  return `${EXPLORER_BASE}/address/${address}?cluster=devnet`;
}
