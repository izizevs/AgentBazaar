export function safeLogUrl(u: string): string {
  try {
    const parsed = new URL(u);
    parsed.username = '';
    parsed.password = '';
    return parsed.toString();
  } catch {
    return '<unparseable url>';
  }
}
