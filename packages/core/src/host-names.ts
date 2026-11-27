import { hostname } from 'node:os'
import { machineLabel } from './remotes.ts'

// The one place this machine's host name is read, and only to find what it was
// once called and to refuse it where Tade publishes (`test/hostname.test.ts`).
// Apart from `remotes.ts`, whose names and sentences are drawn in the window —
// in a browser too (`pure.ts`), where there is no host name to read.

/**
 * What this machine was called before it had a name of its own: its host name
 * as a label, which is how a mirror elsewhere may still file its branches
 * (`mirrors.ts` takes them back). Read only to find that namespace and remove
 * it; never said, never sent as a name.
 */
export function formerLabel(name: string = hostname()): string {
  return machineLabel(name)
}

/**
 * This machine's host name in every form it travels in — as it is, without
 * `.local`, its first label, and each made a namespace (`mirrorMachine`'s
 * lowercase and dashes) — longest first. A form counts only from six
 * characters, so a host called `main` or `work` does not catch every sentence
 * with the word in it.
 */
export function hostNameForms(name: string = hostname()): string[] {
  const plain = name.trim().toLowerCase()
  if (plain === '') return []
  const first = plain.split('.')[0] ?? ''
  const dashed = (form: string) => form.replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-')
  const forms = new Set(
    [plain, plain.replace(/\.local$/, ''), first]
      .flatMap((form) => [form, dashed(form)])
      .filter((form) => form.length >= 6),
  )
  return [...forms].sort((a, b) => b.length - a.length)
}

/** Whether text carries this machine's host name in any of its forms, so a door that publishes can refuse it. */
export function hostNameIn(text: string, name: string = hostname()): boolean {
  const lower = text.toLowerCase()
  return hostNameForms(name).some((form) => lower.includes(form))
}
