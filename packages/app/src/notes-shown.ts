import { type Note, scopesOf } from '@tade/core'
import type { NoteShown } from './frame.ts'

// Which notes the side draws for a project, and in what shape: pure, because
// the side draws four times a second and the notes are read on every one.

/**
 * The notes about a project — any of whose scopes is the project or a task in
 * it — and about everything, in the order they are handed, oldest first.
 */
export function notesShown(all: readonly Note[], project: string | null): NoteShown[] {
  const inProject = (scope: string | null) =>
    scope === null || scope === project || scope.startsWith(`${project}/`)
  return all
    .filter((note) => scopesOf(note).some(inProject))
    .slice()
    .reverse()
    .map((note) => ({
      text: note.text,
      at: note.at,
      scope: note.scope,
      by: note.by,
      ...(note.also ? { also: note.also } : {}),
      ...(note.summary ? { summary: note.summary } : {}),
      ...(note.retired ? { retired: note.retired } : {}),
    }))
}
