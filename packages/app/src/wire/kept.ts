// An answer a subject keeps until something it was made of changes.
//
// The frame is folded out of every subject on every drawing — up to thirty a
// second while a lane prints in front of you — and most of what a subject
// answers moves far more rarely than that. `Live.spendToday` was the first to
// stop re-deriving an answer per frame, and its comment is the argument for
// the rest: twenty-four thousand usage events folded four times a second was
// 3% of a core, to redraw a number that only moves when an agent spends.
//
// Kept on what the answer was made of, compared one by one with `Object.is`:
// the state object a field came from, `Live.revision`, the width. Never on a
// clock — an answer kept for a second is an answer that is wrong for up to a
// second after the thing it says changed. What genuinely moves with time (a
// schedule's next run, a run's running total) says when it stops being true,
// and is made again then and not before.

export class Kept<T> {
  private key: readonly unknown[] | null = null
  private value: T | undefined

  /**
   * The answer to `key`: the one kept, while every part of the key is the same
   * one it was and `expired` (asked of the kept answer) says it still holds;
   * otherwise made again by `make`, and kept.
   */
  of(key: readonly unknown[], make: () => T, expired?: (kept: T) => boolean): T {
    const was = this.key
    if (
      was !== null &&
      was.length === key.length &&
      was.every((part, at) => Object.is(part, key[at])) &&
      !(expired?.(this.value as T) ?? false)
    ) {
      return this.value as T
    }
    const value = make()
    this.key = key
    this.value = value
    return value
  }
}
