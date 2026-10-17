import { open } from 'node:fs/promises'
import { basename } from 'node:path'
import { type Document, loadConfig, type TadeEvent } from '@tade/core'
import type { ExtensionHost } from '@tade/extensions-core'
import {
  DOCUMENT_MOST,
  type DocumentHere,
  inTime,
  type MachineAnswer,
  type ProblemHere,
  type ScheduleHere,
  type WebDocument,
  type WebMachine,
  type WebToolRead,
  withoutPaths,
} from '@tade/web'
import { documentsOf } from '@tade/workbench'
import { lastUpdates, runningVersion } from '@tade/workbench/programs'
import type { ScheduleView } from '../model.ts'
import { scheduleViews } from '../queue.ts'
import { configPathOf, type Wiring, why } from './context.ts'

// This machine's half of what another machine of the person's reads about it
// as an owner (`@tade/web`'s `machine.ts`, `document.ts`, `tool-read.ts`;
// REMOTE-TADE.md §9.4): out of what the window already holds — the schedules
// and what their looks found, the extensions, the public name's health — and
// four small reads it does not keep, each with a deadline: the config's own
// warnings, the journal's last warnings, its documents, and whether a newer
// Tade is out. Nothing here waits on a child process, and a read that runs out
// of time is answered as having nothing to say rather than holding the answer.

/** How long any one read here may take before it is answered as nothing. */
const LOOK_MS = 5_000

/** How many of the journal's newest warnings are told. */
const WARNINGS_MOST = 20

/** How the away view itself stands, as only it knows: its public name and its own trouble. */
export interface AwayStanding {
  /** The public name set, whether its listener is up, and its health; null where none is set. */
  public(): MachineAnswer['public']
  /** Why the away view could not do something, or null. */
  problem(): string | null
}

/** The window's `WebMachine`: what this machine is, now. */
export function machineFrom(wire: Wiring, away: AwayStanding): WebMachine {
  return async () => {
    const now = wire.now()
    const [config, warnings, documents, kept] = await Promise.all([
      inTime(loadConfig(configPathOf(wire.opts)), LOOK_MS, null),
      inTime(wire.opts.client.log.read({ types: ['warning'], limit: WARNINGS_MOST }), LOOK_MS, []),
      inTime(documentsOf(wire.opts.client), LOOK_MS, []),
      inTime(lastUpdates(wire.opts.home), LOOK_MS, null),
    ])
    const problems: ProblemHere[] = [
      ...(config === null
        ? []
        : config.ok
          ? config.warnings.map((said) => ({ from: 'config' as const, at: null, said }))
          : config.issues.map((one) => ({
              from: 'config' as const,
              at: null,
              said: `config.yaml: ${one.path ? `${one.path}: ` : ''}${one.message}`,
            }))),
      ...extensionProblems(wire.opts.extensions),
      ...(away.problem() === null
        ? []
        : [{ from: 'away' as const, at: null, said: `the away view: ${away.problem()}` }]),
      ...journalProblems(warnings),
    ]
    return {
      at: new Date(now).toISOString(),
      version: runningVersion(),
      newer: kept?.tade.newer ?? null,
      public: away.public(),
      // Tade's own words, and what a look of git said can hold a path.
      problems: problems.map((one) => ({ ...one, said: withoutPaths(one.said) })),
      schedules: scheduleViews(wire.opts.client.schedules(), wire.live ?? null, now).map(
        scheduleHere,
      ),
      documents: documentsHere(documents),
    }
  }
}

/** What is wrong with the extensions this window runs: one that is broken, or needs setting up. */
function extensionProblems(host: ExtensionHost | undefined): ProblemHere[] {
  return (host?.list() ?? []).flatMap((one) => {
    if (one.state !== 'broken' && one.state !== 'needs setup') return []
    const because = one.problem ? `: ${one.problem}` : ''
    const said =
      one.state === 'broken'
        ? `${one.title} is broken${because}`
        : `${one.title} needs setting up${because}`
    return [{ from: 'extension' as const, at: null, said }]
  })
}

/** The journal's newest warnings, newest first: Tade's own trouble, as it wrote it down. */
function journalProblems(warnings: readonly TadeEvent[]): ProblemHere[] {
  return [...warnings].reverse().flatMap((event) => {
    const message = event.detail.message
    if (typeof message !== 'string' || message === '') return []
    return [{ from: 'journal' as const, at: event.ts, said: message }]
  })
}

/** One schedule as another machine is told it: its words, its next run, and its watch's looks. */
export function scheduleHere(one: ScheduleView): ScheduleHere {
  const next = one.next[0]
  const watch = one.watch
  return {
    id: one.id,
    name: one.name,
    project: one.project,
    kind: one.kind,
    when: one.when,
    paused: one.paused,
    next: next === undefined ? null : new Date(next).toISOString(),
    watch:
      watch === undefined
        ? null
        : {
            id: watch.id,
            looks: watch.looks.map((look) => ({
              at: new Date(look.at).toISOString(),
              found: look.found,
              fresh: look.fresh,
              left: look.left,
              problem: look.problem,
              said: look.said,
              on: look.on ?? null,
            })),
            found: watch.findings.map((found) => ({
              at: new Date(found.at).toISOString(),
              key: found.key,
              title: found.title,
              task: found.task,
            })),
          },
  }
}

/** Every document the journal says this machine's work produced, newest first, named by file. */
export function documentsHere(all: readonly Document[]): DocumentHere[] {
  return [...all]
    .sort((a, b) => b.at.localeCompare(a.at))
    .map((one) => ({
      task: one.task,
      project: one.task.slice(0, one.task.indexOf('/')),
      name: basename(one.path),
      state: one.state,
      at: one.at,
      bytes: one.bytes,
      triaged: one.triaged !== null,
    }))
}

/**
 * The window's `WebDocument`: the one written document its journal says this
 * task produced under this name, read — never more than another machine is
 * sent of it, and never a path somebody asked for.
 */
export function documentFrom(wire: Wiring): WebDocument {
  return async (ask) => {
    const all = await inTime(documentsOf(wire.opts.client), LOOK_MS, [])
    const one = all.find(
      (each) =>
        each.task === ask.task && basename(each.path) === ask.name && each.state === 'written',
    )
    if (one === undefined) return null
    const read = await inTime(startOf(one.path), LOOK_MS, null)
    return read === null ? null : { at: one.at, ...read }
  }
}

/** The start of a file — as much as one answer carries, and a little over to tell it was cut — and its size. */
async function startOf(path: string): Promise<{ text: string; bytes: number } | null> {
  try {
    const file = await open(path, 'r')
    try {
      const { size } = await file.stat()
      // A character is at most four bytes, so this is always enough to fill one answer.
      const buffer = Buffer.alloc(Math.min(size, DOCUMENT_MOST * 4 + 4))
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
      return { text: buffer.subarray(0, bytesRead).toString('utf8'), bytes: size }
    } finally {
      await file.close()
    }
  } catch (err) {
    // Gone between the journal and the read: there is no such document to read.
    // Anything else is a look that could not be had, and says so.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

/**
 * The window's `WebToolRead`: one of this machine's extension tools that says
 * it only reads, run as the orchestrator's with this machine's own settings —
 * written down first, as every tool call is, with the device that asked.
 */
export function toolFrom(wire: Wiring): WebToolRead {
  return async (ask, device) => {
    const host = wire.opts.extensions
    if (!host?.specs('orchestrator').some((one) => one.name === ask.tool && one.reads === true)) {
      return null
    }
    await wire.opts.client.log.append({
      type: 'tool_call',
      detail: { tool: ask.tool, caller: `device ${device}` },
    })
    try {
      const answer = await host.call(ask.tool, ask.input, { caller: { kind: 'orchestrator' } })
      return { text: answer.text, failed: false }
    } catch (err) {
      return { text: why(err), failed: true }
    }
  }
}
