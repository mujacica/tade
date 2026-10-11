import { appendFileSync } from 'node:fs'

// A stand-in for `child.ts` that misbehaves on purpose, so the window's half
// can be held to what it does when its child does not do what it should.
//
//   node fake-child.ts <how> <log> [ms]
//
// Every start and every ask is a line in <log>, so a test counts forks and
// looks by what happened rather than by how long it waited.
//
//   answer   answers every ask with an empty workspace
//   slow     the same, <ms> late
//   hang     hears every ask and answers none
//   silent   never says it is ready
//   crash    falls over before it can listen
//   die      exits the moment it is asked
//   garbage  answers with something that is not a workspace
//   noise    says something that is not an answer at all

const [how = 'answer', log = '', late = '0'] = process.argv.slice(2)
const note = (line: string) => {
  if (log) appendFileSync(log, `${line}\n`)
}
const send = (message: unknown) => process.send?.(message)

note(`boot ${process.pid}`)
process.on('disconnect', () => process.exit(0))

const answer = (id: number) => ({
  id,
  answer: {
    known: true,
    workspace: {
      generatedAt: new Date().toISOString(),
      projects: [],
      elsewhere: [],
      toolServers: { looked: true, alive: 0 },
      warnings: [],
    },
    spent: { spawns: 0, rss: process.memoryUsage.rss(), pid: process.pid },
  },
})

if (how === 'crash') {
  process.stderr.write('starting up\n')
  throw new Error('the child fell over')
}

if (how === 'silent') {
  setInterval(() => {}, 60_000)
} else {
  process.on('message', (message) => {
    const id = (message as { id: number }).id
    note(`ask ${id}`)
    if (how === 'hang') return
    if (how === 'die') process.exit(3)
    if (how === 'garbage') send({ id, answer: { known: true, workspace: 'nothing to see' } })
    else if (how === 'noise') send('hello')
    else if (how === 'slow') setTimeout(() => send(answer(id)), Number(late))
    else send(answer(id))
  })
  send({ ready: true })
}
