import type { OrchestratorTool } from './tools-extension.ts'

// Another machine's orchestrator, reached from this one's (REMOTE-TADE.md
// §9.4): one tool that passes a sentence on, over the owner channel this
// machine holds there, and one that moves work from here to there (§9.2) —
// and no other door to that machine's work.
//
// Beside `tools-extension.ts` rather than in it, for `tools-machine.ts`'s
// reasons: that file is at its budget, and this is the one tool whose effect is
// on another machine — a boundary worth reading in one place. The boundary
// itself is in two places, neither of them here: `origin.ts` has it `local`,
// so a turn that came from a paired device never reaches it, and the window
// refuses it unless a line of the person's names that machine
// (`REMOTE_TELL_REACH`). What is here is the half a model reads, with every
// limit in the words of its refusal.
//
// Like everything pi loads, this file imports nothing from the Tade workspace:
// `rpc` is handed in.

const object = (
  properties: Record<string, unknown>,
  required: string[] = [],
): Record<string, unknown> => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
})

const string = (description: string) => ({ type: 'string', description })

/**
 * The parameter every reading tool takes to ask another machine instead of
 * this one (`tade_status`, `tade_documents`, `tade_intake`, `tade_intake_show`,
 * and every extension tool that only reads, `tools-listed.ts`).
 */
export const ON_MACHINE = string(
  'another machine to ask instead of this one, by the name it has here (`vps`); leave it out for this machine',
)

export function remoteTools(
  rpc: (method: string, params: Record<string, unknown>) => Promise<unknown>,
): OrchestratorTool[] {
  return [
    {
      name: 'tade_remote_tell',
      label: 'tade: remote tell',
      description:
        'Pass a sentence to another machine’s orchestrator: a Tade on a machine this one is linked to as its owner, each named under "Other machines" in what you are told with every message. Use it when the person asks for something to be done on that machine — start or plan work there, steer, park or stop one of its agents: your tools that read (`tade_status`, `tade_documents`, `tade_intake`, `tade_intake_show`, and an extension’s tools that only read, such as Sentry’s) take a `machine` to answer about it, nothing else of yours reaches it, and its projects are not projects here even where one has the same name. Say what they asked, in their words, with what that orchestrator needs to act on it; it acts there with that machine’s own tools, and answers in its own conversation, which the person reads on that machine’s tab in this window — you are not given its answer, so tell them it went and where to look. Refused unless a line of theirs names that machine — pass that line, word for word, in `asked` — and refused while its link is down, while its orchestrator is answering something else, and where talking to it from another screen is off there. Never reached from a turn that came from a paired device.',
      parameters: object(
        {
          machine: string('the machine, by the name it has here: `vps`'),
          said: string('what to pass on, as the person would put it to that machine'),
          asked: string(
            'what the person said that asked for this, word for word. Tade checks it against what they actually said and that it names the machine, so pass their sentence and never your own summary of it',
          ),
        },
        ['machine', 'said', 'asked'],
      ),
      run: async (p) =>
        rpc('remote/tell', {
          machine: String(p.machine ?? ''),
          said: String(p.said ?? ''),
          asked: String(p.asked ?? ''),
        }),
    },
    {
      name: 'tade_task_move',
      label: 'tade: task move',
      description:
        'Move work from this machine to another one it is linked to (named under "Other machines"): queued work here starts there instead, in that machine’s project that is the same repository, with the person’s words, what its agent will be told, its context file, links and done rule, and is removed from this queue once that machine has it. Use it when they ask for work here to go there — "start that on the vps", "move the queued docs work to the vps". Only work that can leave moves: not parked, not waiting on anything and nothing waiting on it, because no wait crosses machines — the refusal says which. Nothing of the conversation moves: the agent there starts fresh, from the task’s words and context. Refused unless a line of theirs names that machine — pass that line, word for word, in `asked` — and while its link is down. For work already running there, or anything else to be done there, use tade_remote_tell.',
      parameters: object(
        {
          task: string('the task here, like docs/landing-page'),
          machine: string('the machine, by the name it has here: `vps`'),
          asked: string(
            'what the person said that asked for this, word for word. Tade checks it against what they actually said and that it names the machine, so pass their sentence and never your own summary of it',
          ),
        },
        ['task', 'machine', 'asked'],
      ),
      run: async (p) =>
        rpc('remote/move', {
          task: String(p.task ?? ''),
          machine: String(p.machine ?? ''),
          asked: String(p.asked ?? ''),
        }),
    },
  ]
}
