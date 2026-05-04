/**
 * Placeholder umbrella type for bazaar_evaluator. The richly-typed version
 * (literal discriminator arrays, named instructions, etc.) is emitted by
 * `anchor build` into `programs/target/types/bazaar_evaluator.ts` and copied
 * here via `pnpm -F @agent-bazaar/idl sync`. Until that toolchain run produces
 * a fresh artifact, this loose shape lets `tsc` pass while still requiring the
 * JSON to be a valid Anchor IDL at runtime.
 */
export type BazaarEvaluator = {
  address: string;
  metadata: {
    name: string;
    version: string;
    spec: string;
    description?: string;
    repository?: string;
  };
  instructions: readonly unknown[];
  accounts?: readonly unknown[];
  events?: readonly unknown[];
  errors?: readonly unknown[];
  types?: readonly unknown[];
};
