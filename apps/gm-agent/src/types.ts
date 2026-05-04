export interface Bindings {
  RPC_URL: string;
  DISCOVERY_API_URL?: string;
  PROVIDER_SECRET_KEY: string; // base58-encoded 64-byte secretKey
  PINATA_JWT: string;
}
