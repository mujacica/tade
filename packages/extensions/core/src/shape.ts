import { INTAKE_SOURCES, whenProblem } from '@tade/core'
import type { TadeExtension } from './port.ts'
import type { ExtensionWatch } from './watch.ts'

// Why an extension will not load: everything that can be decided by looking at
// what it declares, before any of it runs.
//
// Its own file because it is the one part of holding extensions that asks
// nothing of the world — no disk, no settings, no clock — and because two
// conformance suites and every extension's own test call it directly. Keeping
// it beside the host meant a pure rule nobody could read without reading a
// thousand lines of process spawning first.

/** What is wrong with how an extension is put together, or null. */
export function shapeProblem(extension: TadeExtension): string | null {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(extension.name ?? '')) {
    return `"${String(extension.name)}" is not a usable name: lowercase letters, digits and dashes`
  }
  if (!extension.title || !extension.description) return 'it needs a title and a description'
  // What it says about how it is used is read by a person, so a blank line in
  // it is a gap on the page rather than something nobody notices.
  for (const line of extension.workflow ?? []) {
    if (!line.trim()) return 'one of the lines it says it is used in is empty'
  }
  const prefix = `${extension.name.replace(/-/g, '_')}_`
  const seen = new Set<string>()
  for (const tool of extension.tools ?? []) {
    if (!tool.name.startsWith(prefix)) return `its tool ${tool.name} should start with ${prefix}`
    if (!/^[a-z0-9_]+$/.test(tool.name))
      return `its tool ${tool.name} should be lowercase with underscores`
    if (seen.has(tool.name)) return `it has two tools called ${tool.name}`
    seen.add(tool.name)
    if (!tool.description) return `its tool ${tool.name} says nothing about when to use it`
    if (tool.parameters?.type !== 'object')
      return `its tool ${tool.name} takes parameters that are not an object`
    if (tool.for.length === 0) return `its tool ${tool.name} is offered to nobody`
  }
  for (const action of extension.actions ?? []) {
    if (!seen.has(action.tool))
      return `its action ${action.id} runs ${action.tool}, which it does not have`
  }
  const watches = new Set<string>()
  for (const watch of extension.watches ?? []) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(watch.id ?? '')) {
      return `its watch "${String(watch.id)}" is not a usable name: lowercase letters, digits and dashes`
    }
    if (watches.has(watch.id)) return `it has two watches called ${watch.id}`
    watches.add(watch.id)
    if (!watch.title || !watch.means) return `its watch ${watch.id} needs a title and what it means`
    const every = whenProblem({ every: String(watch.every) })
    if (every || !/^\d/.test(String(watch.every).trim())) {
      return `its watch ${watch.id} looks every "${watch.every}", which is not a length like 30m, 1h or 1d`
    }
    if (watch.input && watch.input.type !== 'object') {
      return `its watch ${watch.id} takes input that is not an object`
    }
    if (typeof watch.check !== 'function') {
      return `its watch ${watch.id} needs a check`
    }
    // A watch may have nothing to start — what it finds is already going, and
    // badly — but only one that says so, because everything else is turned on
    // to start work by default and would fail at the first finding.
    if (typeof watch.agent !== 'function' && watch.offers !== 'ask') {
      return `its watch ${watch.id} has no agent, so it must say offers: 'ask'`
    }
    const intake = intakeShape(watch)
    if (intake) return `its watch ${watch.id} ${intake}`
  }
  const lists = new Set<string>()
  for (const list of extension.lists ?? []) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(list.id ?? '')) {
      return `its list "${String(list.id)}" is not a usable name: lowercase letters, digits and dashes`
    }
    if (lists.has(list.id)) return `it has two lists called ${list.id}`
    lists.add(list.id)
    if (!list.title) return `its list ${list.id} needs a heading`
    if (typeof list.rows !== 'function') return `its list ${list.id} has no rows`
    if (everyMs(list.every) < 30_000) {
      return `its list ${list.id} asks every "${list.every}", which is oftener than every 30s`
    }
  }
  return null
}

/**
 * Why an intake source will not load, or null — either because it is not one,
 * or because it is one and holds together.
 *
 * **The capability and what it obliges are decided in the same place**, which
 * is the whole reason this is a rule and not a convention: a watch that
 * declared itself an intake source and could not be asked whether a request
 * still stands would make work that the start door would hold for ever, and the
 * only moment anybody can do anything about that is when they turn it on.
 */
function intakeShape(watch: ExtensionWatch): string | null {
  if (watch.intake === undefined) return null
  if (!INTAKE_SOURCES.includes(watch.intake)) {
    return `says it takes in ${String(watch.intake)}, which is not a source Tade implements (there is ${INTAKE_SOURCES.join(', ')})`
  }
  if (typeof watch.recheck !== 'function') {
    return 'takes in work from outside, so it needs a recheck: a request that was closed or rewritten while its task waited must hold rather than start'
  }
  if (typeof watch.agent !== 'function') {
    return 'takes in work from outside, so it needs an agent: a request nothing can be started on is a request nobody answers'
  }
  return null
}

/** Why one watch cannot be turned on as what it says it is, in the host's words. */
export function intakeProblem(watch: ExtensionWatch): string | null {
  const problem = intakeShape(watch)
  return problem === null ? null : `${watch.id} ${problem}`
}

/** How often a sidebar section may be asked again: `30s`, `5m`, `1h`. */
export function everyMs(every: string): number {
  const match = /^(\d+)\s*(s|sec|seconds?|m|min|minutes?|h|hours?)$/.exec(
    String(every).trim().toLowerCase(),
  )
  if (!match) return 60_000
  const n = Number(match[1])
  const unit = match[2]?.[0]
  return n * (unit === 's' ? 1_000 : unit === 'm' ? 60_000 : 3_600_000)
}
