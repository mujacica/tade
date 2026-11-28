// Another machine's agents, pressed from this door: the overview draws every
// machine's agents waiting on you (`pages/overview-figures.js`), and a press
// on one of another machine's goes there through this door's outbox
// (`pressed-there.ts`) — only the verbs that outbox takes, each refused here
// with the machine's name where it does not (ONE-AWAY-VIEW §2.4).

// A verb carried to another machine, and its fields there (`pressed-there.ts`):
// of the overview's presses (`QUICK` in `quick.js`), setting work aside is the
// one that outbox takes. Allowing a command and marking work finished are that
// machine's own to do, at its screen or by asking Tade.
const CARRIED = {
  park: (b) => ({ parked: b.parked }),
}

export const THERE_VERBS = Object.keys(CARRIED)

/** `ctx` with its acts carried to `machine` through this door; any other refused here. */
export function thereCtx(ctx, machine) {
  const ask = async (method, path, body) => {
    const verb = path.startsWith('/api/act/') ? path.slice(9) : ''
    const fields = method === 'POST' ? CARRIED[verb] : undefined
    if (fields === undefined) {
      return refusedThere(`${machine} takes that only at its own screen: ask Tade`)
    }
    const answer = await ctx.ask('POST', '/api/there/press', {
      machine,
      key: body.key,
      verb,
      task: body.task,
      ...fields(body),
    })
    if (answer.status !== 200 || answer.body?.ok === true) return answer
    return refusedThere(answer.body?.said ?? `${machine} did not do it`)
  }
  return { ...ctx, ask, machine }
}

const refusedThere = (said) => ({ status: 409, body: { error: 'there', said } })
