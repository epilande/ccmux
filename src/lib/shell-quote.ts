/**
 * POSIX single-quote escaping for embedding an arbitrary string as one shell
 * word. Wraps `value` in single quotes, closing/re-opening around any
 * embedded single quote (the standard `'\''` trick) so the result is safe to
 * splice into a shell command line regardless of its content.
 *
 * Used to build the notifier's click-to-jump `-execute` command (session ids
 * and paths go inside a `sh -c '...'` string), where the content is
 * effectively untrusted (agent-derived session ids, user-configured paths).
 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
