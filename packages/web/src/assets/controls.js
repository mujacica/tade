// The key every press mints (`quick.js`, `talk.js`): a card's answers and the
// conversation's box are the page's two doors, and each act carries one.

/**
 * A fresh idempotency key: this browser's own randomness, and nothing of the
 * machine's.
 *
 * `crypto.randomUUID` where the browser has it — every target this page claims
 * does, over a secure context — and a value out of `getRandomValues` where it
 * does not. Never a counter and never a timestamp: two tabs of one phone would
 * mint the same one, and a key bound to another act is refused rather than
 * obeyed, so a collision would read as a broken button.
 */
export function keyOf() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID().replaceAll('-', '')
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return [...bytes].map((one) => one.toString(16).padStart(2, '0')).join('')
}
