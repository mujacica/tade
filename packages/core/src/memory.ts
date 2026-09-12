import { z } from 'zod'

// What only you know.
//
// Everything else Wilco says about the world is derived from something it can
// observe: git, processes, transcripts. Notes are the exception, and they are
// not a contradiction of that — they are the same kind of fact as
// `intent_spoken` and `parked`, things a person said that no probe could ever
// discover. They are kept verbatim for the same reason `intent_spoken` is:
// paraphrasing what someone told you loses the detail that made it worth
// saying.

export const NoteSchema = z.strictObject({
  /** Exactly what was said. Never paraphrase it. */
  text: z.string().min(1),
  /** A task id, a project name, or null when it is about everything. */
  scope: z.string().nullable(),
  at: z.string(),
})

export type Note = z.infer<typeof NoteSchema>

export function note(text: string, scope: string | null, now: number): Note {
  return { text: text.trim(), scope, at: new Date(now).toISOString() }
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

/** What is known about something, newest first. */
export function recall(notes: readonly Note[], scope: string | null): Note[] {
  const wanted = notes.filter((entry) => appliesTo(entry, scope))
  return [...wanted].sort((a, b) => b.at.localeCompare(a.at))
}

/** Everything known, newest first, whatever it is about. */
export function allNotes(notes: readonly Note[]): Note[] {
  return [...notes].sort((a, b) => b.at.localeCompare(a.at))
}

/**
 * What is known, as a sentence. Speech is expensive, so this says the most
 * recent few and then how many more there are.
 */
export function describeNotes(notes: readonly Note[], limit = 3): string {
  if (notes.length === 0) return 'Nothing yet.'
  const said = notes.slice(0, limit).map((entry) => entry.text.replace(/\.$/, ''))
  const rest = notes.length - said.length
  const sentence = said.join('. ')
  return rest > 0 ? `${sentence}. And ${rest} more.` : `${sentence}.`
}
