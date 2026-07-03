/**
 * In-process fixed-window rate limiter.
 *
 * Works correctly for single-process deployments (docker compose, single Node
 * instance). For multi-process / horizontally-scaled deployments, enforce rate
 * limits at the reverse proxy layer (nginx limit_req, Caddy rate_limit,
 * Cloudflare) — this module has no cross-process state.
 */

interface Window {
  count: number
  resetAt: number
}

const windows = new Map<string, Window>()

// Prune expired windows every 5 minutes to prevent unbounded Map growth.
setInterval(() => {
  const now = Date.now()
  for (const [key, w] of windows) {
    if (now > w.resetAt) windows.delete(key)
  }
}, 5 * 60 * 1000).unref()

export interface RateResult {
  ok: boolean
  limit: number
  remaining: number
  resetAt: number
}

/**
 * Returns rate-limit result with ok flag and counters for X-RateLimit-* headers.
 *
 * @param key     Unique bucket key (e.g. "login:<ip>", "hb:<licenseId>")
 * @param limit   Max requests per window
 * @param windowMs Window size in milliseconds
 */
export function allow(key: string, limit: number, windowMs: number): RateResult {
  const now = Date.now()
  let w = windows.get(key)
  if (!w || now > w.resetAt) {
    w = { count: 1, resetAt: now + windowMs }
    windows.set(key, w)
    return { ok: true, limit, remaining: limit - 1, resetAt: w.resetAt }
  }
  w.count++
  return { ok: w.count <= limit, limit, remaining: Math.max(0, limit - w.count), resetAt: w.resetAt }
}

// ── Nonce deduplication ───────────────────────────────────────────────────────

// Nonces expire after 10 minutes — covers any reasonable clock skew + retry window.
const NONCE_TTL_MS = 10 * 60_000
const nonces = new Map<string, number>() // nonce → expiresAt

setInterval(() => {
  const now = Date.now()
  for (const [nonce, expiresAt] of nonces) {
    if (now > expiresAt) nonces.delete(nonce)
  }
}, 5 * 60 * 1000).unref()

/**
 * Returns true if this nonce has not been seen before (and records it).
 * Returns false if the nonce was already used within the TTL window.
 *
 * @param namespace Prefix to scope nonces per endpoint (e.g. "hb")
 * @param nonce     Caller-supplied nonce string
 */
export function claimNonce(namespace: string, nonce: string): boolean {
  const key = `${namespace}:${nonce}`
  const now = Date.now()
  const expiresAt = nonces.get(key)
  // Treat an expired entry as absent — correctness independent of the cleanup interval
  if (expiresAt !== undefined && now <= expiresAt) return false
  nonces.set(key, now + NONCE_TTL_MS)
  return true
}

/** FOR TESTING ONLY — clears all rate-limit and nonce state between tests. */
export function __resetForTesting(): void {
  windows.clear()
  nonces.clear()
}
