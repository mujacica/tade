import { spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { GCProfiler } from 'node:v8'
import { ConfigSchema } from '@tade/core'
import { mkrepo, tmp } from '../../../test/fixtures/mkrepo.ts'
import type { StatusCollector } from '../src/collector.ts'
import { makeCollector } from '../src/collectors.ts'
import { gitLoad } from '../src/git.ts'

// What a window's look at status costs the window, in this process and in a
// child of its own.
//
//   node packages/status/scripts/look-cost.ts                 13 worktrees, 30 beats
//   node packages/status/scripts/look-cost.ts --worktrees 6
//   node packages/status/scripts/look-cost.ts --beats 60
//   node packages/status/scripts/look-cost.ts --adopt         read this machine's transcripts too
//
// Each way is run in a fresh Node of its own, so neither inherits the other's
// heap, and each reports what *the window* paid: the git processes it started,
// the bytes it allocated (every byte a GC found dead, plus what is still held),
// how big it grew, and — for the child — how big the child is. Milliseconds are
// printed and are about this machine on this day; the spawns and the bytes are
// what carry.

const here = fileURLToPath(import.meta.url)
const flag = (name: string, fallback: number) => {
  const at = process.argv.indexOf(`--${name}`)
  return at >= 0 ? Number(process.argv[at + 1]) : fallback
}

interface Measured {
  way: string
  coldMs: number
  warmMs: number
  windowSpawns: number
  lookSpawns: number
  allocatedMb: number
  rssGrowthMb: number
  childRssMb: number | null
}

if (process.argv[2] === '--way') {
  process.stdout.write(`${JSON.stringify(await measure(process.argv[3] ?? 'here'))}\n`)
} else {
  const rows = ['here', 'child'].map((way) => {
    const ran = spawnSync(
      process.execPath,
      ['--expose-gc', here, '--way', way, ...process.argv.slice(2)],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'inherit'],
      },
    )
    return JSON.parse(ran.stdout.trim().split('\n').at(-1) ?? '{}') as Measured
  })
  const mb = (n: number | null) => (n === null ? '—' : `${n.toFixed(1)} MB`)
  console.log(
    `${flag('worktrees', 13)} worktrees, ${flag('beats', 30)} beats${process.argv.includes('--adopt') ? ', adopting' : ''}\n`,
  )
  console.log(
    [
      'way    cold ms  warm ms  window git  look git/beat  window allocated  window rss +  child rss',
      ...rows.map((r) =>
        [
          r.way.padEnd(5),
          String(Math.round(r.coldMs)).padStart(8),
          String(Math.round(r.warmMs)).padStart(8),
          String(r.windowSpawns).padStart(11),
          r.lookSpawns.toFixed(1).padStart(14),
          mb(r.allocatedMb).padStart(17),
          mb(r.rssGrowthMb).padStart(13),
          mb(r.childRssMb).padStart(10),
        ].join(' '),
      ),
    ].join('\n'),
  )
}

async function measure(way: string): Promise<Measured> {
  const worktrees = flag('worktrees', 13)
  const beats = flag('beats', 30)
  const adopt = process.argv.includes('--adopt')
  const r = mkrepo()
  for (let i = 0; i < worktrees; i++) {
    const wt = r.addTask(`t${i}`, { project: 'app' })
    if (i % 2 === 0) r.commit(`work ${i}`, { [`f${i}.ts`]: 'x\n' }, wt)
  }
  const config = ConfigSchema.parse({ workspace: { adopt }, projects: { app: { root: r.root } } })
  const home = adopt ? homedir() : tmp('tade-look-cost-')
  const look: StatusCollector = makeCollector(way)
  const ask = () => ({ config, now: Date.now(), home, tadeHome: r.home, pr: false, lanes: {} })

  // The child boots before the first beat, as it does in a window; so does
  // this process's own share of loading the look.
  if (way === 'child') await new Promise((resolve) => setTimeout(resolve, 1_000))
  const gc = (globalThis as { gc?: () => void }).gc
  gc?.()
  const rssBefore = process.memoryUsage.rss()
  const gitBefore = gitLoad().started
  const profiler = new GCProfiler()
  profiler.start()
  const usedAtStart = process.memoryUsage().heapUsed

  let t = performance.now()
  const cold = await look.collect(ask())
  const coldMs = performance.now() - t
  let lookSpawns = 0
  let childRss: number | null = null
  t = performance.now()
  for (let i = 0; i < beats; i++) {
    const answer = await look.collect(ask())
    if (answer.known) {
      lookSpawns += answer.spent.spawns
      if (answer.spent.pid !== process.pid) childRss = answer.spent.rss
    }
  }
  const warmMs = (performance.now() - t) / beats
  const usedAtEnd = process.memoryUsage().heapUsed
  const profile = profiler.stop()
  const rssAfter = process.memoryUsage.rss()
  await look.close()
  if (!cold.known) throw new Error(cold.why)

  // Allocated: what each collection found dead, plus what is still held. A
  // collection's `before` less the last one's `after` is what was made between
  // them.
  let allocated = 0
  let last = usedAtStart
  for (const one of profile?.statistics ?? []) {
    allocated += one.beforeGC.heapStatistics.usedHeapSize - last
    last = one.afterGC.heapStatistics.usedHeapSize
  }
  allocated += usedAtEnd - last

  return {
    way,
    coldMs,
    warmMs,
    windowSpawns: gitLoad().started - gitBefore,
    lookSpawns: lookSpawns / beats,
    allocatedMb: allocated / 1e6,
    rssGrowthMb: (rssAfter - rssBefore) / 1e6,
    childRssMb: childRss === null ? null : childRss / 1e6,
  }
}
