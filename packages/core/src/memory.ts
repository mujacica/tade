import { z } from 'zod'

// What only you know.
//
// Everything else Tade says about the world is derived from something it can
// observe: git, processes, transcripts. Notes are the exception, and they are
// not a contradiction of that — they are the same kind of fact as
// `intent_spoken` and `parked`, things a person said that no probe could ever
// discover. They are kept verbatim for the same reason `intent_spoken` is:
// paraphrasing what someone told you loses the detail that made it worth
// saying.

export const NoteSchema = z.strictObject({
  /** Exactly what was said. Never paraphrase it. */
  text: z.string().min(1),
  /**
   * A headline for it, written by whoever took it down: what the note is
   * about and what it does, in a few words. It sits *beside* the note and
   * never in place of it — `text` is still the whole of what was said, and
   * nothing here may ever be drawn from it by rewording, shortening or
   * lowercasing what a person said.
   *
   * Optional, and always will be: every note taken before this existed has
   * none, and a note can be written down by anything.
   */
  summary: z.string().min(1).optional(),
  /** A task id, a project name, or null when it is about everything. */
  scope: z.string().nullable(),
  /**
   * Where it came from: `voice`, `window`, `cli`. Defaulted rather than
   * required so notes written before this existed still load — losing them to
   * a schema change would be losing the one thing nothing can recover.
   */
  by: z.string().default('unknown'),
  at: z.string(),
})

export type Note = z.infer<typeof NoteSchema>

export function note(
  text: string,
  scope: string | null,
  by: string,
  now: number,
  summary: string | null = null,
): Note {
  const headline = summary?.trim()
  return {
    text: text.trim(),
    ...(headline ? { summary: headline } : {}),
    scope,
    by,
    at: new Date(now).toISOString(),
  }
}

/** How specific a scope is: a task beats its project beats everything. */
function depth(scope: string | null): number {
  return scope === null ? 0 : scope.split('/').length
}

/**
 * Whether a note is worth knowing while talking about `scope`. A note about a
 * project applies to every task in it, and a note about everything always
 * applies; a note about one task never leaks to its siblings.
 */
export function appliesTo(entry: Note, scope: string | null): boolean {
  if (entry.scope === null) return true
  if (scope === null) return false
  if (entry.scope === scope) return true
  return scope.startsWith(`${entry.scope}/`)
}

/**
 * What is known about something, narrowest first and newest first within that.
 *
 * Narrowest first because that is the order they should be believed in: told
 * something about a task and something else about the whole workspace, the one
 * about the task is the one that applies. Recency alone would let a passing
 * general remark outrank a specific instruction given weeks ago.
 */
export function recall(notes: readonly Note[], scope: string | null): Note[] {
  const wanted = notes.filter((entry) => appliesTo(entry, scope))
  return [...wanted].sort((a, b) => depth(b.scope) - depth(a.scope) || b.at.localeCompare(a.at))
}

/** Everything known, newest first, whatever it is about. */
export function allNotes(notes: readonly Note[]): Note[] {
  return [...notes].sort((a, b) => b.at.localeCompare(a.at))
}
