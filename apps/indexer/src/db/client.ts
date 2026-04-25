import postgres from 'postgres';

let _sql: ReturnType<typeof postgres> | undefined;

export function getSql(): ReturnType<typeof postgres> {
  if (!_sql) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL is required for DB operations');
    _sql = postgres(url);
  }
  return _sql;
}
