-- Migration #5 (Task #57): rename price_lamports → price_usdc_base_units
--
-- The on-chain program (Task #37 / PR #72) renamed the field to clarify
-- that values are USDC base units (1e-6 USDC), not SOL lamports.
-- This migration aligns the DB column name with the program's field name.
--
-- Safe to apply hot: RENAME COLUMN acquires ACCESS EXCLUSIVE briefly but
-- no rows are rewritten. Apply during low-traffic window on prod (Neon).
ALTER TABLE "service_listings" RENAME COLUMN "price_lamports" TO "price_usdc_base_units";
