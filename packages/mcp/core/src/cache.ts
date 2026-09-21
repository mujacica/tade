import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { OfferedTool, ServerAbout } from './port.ts'

// What a server offered, last time anybody asked.
//
// Two facts collide: an enabled server's tools are only knowable by opening
// one, and the tool list is written at the moment an agent launches. So what
// came back is written down once — `<home>/mcp/<name>.json`, `0600` — and
// that file is what the tool list is built from, so the first agent after a
// restart has the tools without anything being dialled on the way up.
//
// It is the bargain `commit_seen` and `check_ran` make: write down once what
// cannot be cheaply re-derived. A cache file rather than a journal line,
// because "what tools did this server have on Tuesday" is not a question
// anybody asks, and an event nobody reads back is noise.
//
// **A cache is never the truth.** An enabled server with no cache offers no
// tools yet and says so; nothing here is ever written from anything but a
// real answer; and a file that will not parse is no cache rather than a throw.

/** What one server offered, and when it said so. */
export interface CachedServer {
  /** The server's own name for itself, in its own words. */
  about: ServerAbout
  tools: readonly OfferedTool[]
  /** When it was asked, as an ISO time. The page says it, so it is never invented. */
  asked: string
}

/** Where one server's cache lives. */
export function cachePath(home: string, name: string): string {
  return join(home, 'mcp', `${name}.json`)
}

/**
 * What is in a cache file, or null.
 *
 * Anything unfamiliar is left out rather than trusted: this is a file on
 * disk holding a third party's words, and a shape nothing here recognises
 * reads as no cache, exactly as `installedPieces` leaves out what it does
 * not know.
 */
export function parseCache(text: string): CachedServer | null {
  let read: unknown
  try {
    read = JSON.parse(text)
  } catch {
    return null
  }
  if (!read || typeof read !== 'object') return null
  const one = read as Record<string, unknown>
  const about = one.about as Record<string, unknown> | undefined
  const asked = typeof one.asked === 'string' ? one.asked : null
  if (!asked || !Array.isArray(one.tools)) return null
  const tools = one.tools.filter(
    (tool): tool is OfferedTool =>
      !!tool &&
      typeof tool === 'object' &&
      typeof (tool as OfferedTool).name === 'string' &&
      typeof (tool as OfferedTool).description === 'string' &&
      !!(tool as OfferedTool).input &&
      typeof (tool as OfferedTool).input === 'object',
  )
  return {
    about: {
      title: typeof about?.title === 'string' ? about.title : '',
      version: typeof about?.version === 'string' ? about.version : '',
    },
    tools,
    asked,
  }
}

/** What a server offered last time, or null when nobody has asked yet. Never throws. */
export function readCache(home: string, name: string): CachedServer | null {
  try {
    return parseCache(readFileSync(cachePath(home, name), 'utf8'))
  } catch {
    // No cache is the normal case on a fresh machine, not an error.
    return null
  }
}

/**
 * Write down what a server just said it offers. Only ever called with a real
 * answer, so there is nothing here that could write an empty list over a good
 * one by accident. Never throws: a home that cannot be written is a server
 * that has to be asked again next time, not a window that refuses to open.
 */
export function writeCache(home: string, name: string, cached: CachedServer): void {
  try {
    mkdirSync(join(home, 'mcp'), { recursive: true, mode: 0o700 })
    writeFileSync(cachePath(home, name), `${JSON.stringify(cached, null, 2)}\n`, { mode: 0o600 })
  } catch {
    // Nothing above this can do anything about it, and a cache is a cache.
  }
}
