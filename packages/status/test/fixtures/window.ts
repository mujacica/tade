import { ConfigSchema } from '@tade/core'
import { lookInChild } from '../../src/forked.ts'

// A window, as far as its status child can tell: it holds one, has it look
// once, says which process looked, and then waits to be killed. What the test
// does to it next is the point — a window killed outright runs no exit path.

const look = lookInChild()
const answer = await look.collect({
  config: ConfigSchema.parse({ workspace: { adopt: false } }),
  now: Date.now(),
  home: process.argv[2] ?? '/nowhere',
  tadeHome: process.argv[2] ?? '/nowhere',
  pr: false,
  lanes: {},
})
process.stdout.write(`${answer.known ? answer.spent.pid : `unknown: ${answer.why}`}\n`)
setInterval(() => {}, 60_000)
