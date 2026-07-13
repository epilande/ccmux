/**
 * Compact elapsed-duration label with seconds precision: `42s`, `2m14s`,
 * `1h5m`. Unlike {@link formatRelativeTime} (which rounds to whole
 * minutes), this keeps sub-minute detail so concurrent durations stay
 * distinguishable — e.g. agents spawned seconds apart in a fan-out.
 * Negative input (clock skew) clamps to `0s`.
 */
export function formatDuration(ms: number): string {
  const totalSecs = Math.max(0, Math.floor(ms / 1000));
  const secs = totalSecs % 60;
  const totalMins = Math.floor(totalSecs / 60);
  const mins = totalMins % 60;
  const hours = Math.floor(totalMins / 60);

  if (hours > 0) return `${hours}h${mins}m`;
  if (totalMins > 0) return `${mins}m${secs}s`;
  return `${secs}s`;
}

export function formatRelativeTime(date: Date, suffix = ""): string {
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSecs = Math.floor(diffMs / 1000);
  const diffMins = Math.floor(diffSecs / 60);
  const diffHours = Math.floor(diffMins / 60);

  if (diffSecs < 60) return `${diffSecs}s${suffix}`;
  if (diffMins < 60) return `${diffMins}m${suffix}`;
  return `${diffHours}h${suffix}`;
}
