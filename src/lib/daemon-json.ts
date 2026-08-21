/**
 * Reading a daemon response body.
 *
 * `Response.json()` is typed `any`, so every reader has to decide what to
 * believe about the wire. Left to each call site that decision was an
 * unannounced `as`, repeated about thirty times. These helpers make the same
 * decision explicit and keep it in one place:
 *
 * - `daemonError` pulls the `error` string an endpoint sends with a non-OK
 *   status. It never throws: a body that is missing, empty, or not JSON at all
 *   is a daemon that failed before it could explain itself, which is the
 *   caller's fallback message rather than a second failure.
 * - `readBoolean` / `readString` narrow a single field off an unknown body,
 *   for the small reads (`killed`, `socketPath`, `socketError`).
 * - `daemonBody` is the honest name for the wide case: a response shape the
 *   daemon owns and the CLI mirrors (`TranscriptResponse`, `ScanResponse`).
 *   It proves the body is a JSON object and then TRUSTS the fields.
 *
 * `daemonBody` deliberately stops at the object check. Hand-maintaining a
 * field-level validator for every response type would duplicate definitions
 * the server already owns and drift the moment one changes, buying type
 * safety the compiler cannot enforce anyway. What it does buy is a single
 * stated point of trust, and a clear failure when the body is not an object
 * at all (an HTML error page from a proxy, a bare string) instead of an
 * `undefined` field surfacing as a confusing crash several lines later.
 */

/** True for a JSON object body, narrowing so `in` checks compile. */
function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The `error` string a daemon endpoint sent with a non-OK status, or null if
 * it sent none. Never throws, and consumes the body, so call it once per
 * response.
 */
export async function daemonError(response: Response): Promise<string | null> {
  const body: unknown = await response.json().catch(() => null);
  if (!isJsonObject(body)) return null;
  const error = body.error;
  return typeof error === "string" && error.length > 0 ? error : null;
}

/** One boolean field off an already-parsed body, or null if absent/other. */
export function readBoolean(body: unknown, key: string): boolean | null {
  if (!isJsonObject(body)) return null;
  const value = body[key];
  return typeof value === "boolean" ? value : null;
}

/** One string field off an already-parsed body, or null if absent/other. */
export function readString(body: unknown, key: string): string | null {
  if (!isJsonObject(body)) return null;
  const value = body[key];
  return typeof value === "string" ? value : null;
}

/**
 * Parse a response the daemon owns the shape of. Proves the body is a JSON
 * object, then trusts `T` (see the file header for why it stops there).
 *
 * `what` names the shape in the thrown message, so a daemon returning
 * something else fails where it happened rather than several lines later.
 */
export async function daemonBody<T>(
  response: Response,
  what: string,
): Promise<T> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error(`Daemon sent a non-JSON ${what} response`);
  }
  if (!isJsonObject(body)) {
    throw new Error(`Daemon sent a malformed ${what} response`);
  }
  return body as T;
}
