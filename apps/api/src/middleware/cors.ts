// CORS middleware — allow all origins for public read-only Discovery API.
import { cors } from 'hono/cors';

export const corsMiddleware = cors({
  origin: '*',
  allowMethods: ['GET', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'X-Agent-Pubkey'],
  maxAge: 86400,
});
