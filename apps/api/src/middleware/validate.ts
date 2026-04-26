// Zod validation helpers for path params and query strings.
// Returns structured 400 errors on invalid input.
import { zValidator } from '@hono/zod-validator';
import type { ZodType } from 'zod';

// Wraps @hono/zod-validator with a consistent error shape.
export function validateQuery<T extends ZodType>(schema: T) {
  return zValidator('query', schema, (result, c) => {
    if (!result.success) {
      return c.json(
        {
          error: 'validation_error',
          message: 'Invalid query parameters',
          issues: result.error.issues.map((i) => ({
            path: i.path.join('.'),
            message: i.message,
          })),
        },
        400,
      );
    }
  });
}

export function validateParam<T extends ZodType>(schema: T) {
  return zValidator('param', schema, (result, c) => {
    if (!result.success) {
      return c.json(
        {
          error: 'validation_error',
          message: 'Invalid path parameter',
          issues: result.error.issues.map((i) => ({
            path: i.path.join('.'),
            message: i.message,
          })),
        },
        400,
      );
    }
  });
}
