// What an agent may report it found and did not fix, as every harness's tool
// server offers it: `tade_leftovers`, and the `leftovers` field of `tade_done`.
//
// One copy, imported by the servers Claude Code, Codex and ACP agents start —
// which is why this file imports nothing: it is loaded at the start of every
// agent's session, before anything else is. pi's supervision extension may
// import nothing of Tade's at all, so it keeps its own copy, held to this one
// by its test (`harnesses/pi/test/extension-tools.test.ts`).
//
// Both ways go to the same door in the window (`workbench/src/leftovers.ts`):
// `tade_done` sends its `leftovers` there first, as a call to `tade_leftovers`,
// so a report that is refused is said before anything is finished.

/** One thing found and not fixed, as the model fills it in. */
export const LEFTOVER_ITEMS = {
  type: 'array',
  description:
    'Each thing you found wrong and did not fix — outside your task, or left on purpose — so it is not lost in your last message. Leave it out when there is nothing.',
  maxItems: 10,
  items: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'What is wrong, in one line.' },
      where: {
        type: 'string',
        description:
          'Where it is: a file and line, like src/listen.ts:42, or the command that shows it.',
      },
      why: { type: 'string', description: 'Why you left it rather than fixing it.' },
      sure: {
        type: 'string',
        enum: ['certain', 'likely', 'unsure'],
        description: 'How sure you are that it is real.',
      },
    },
    required: ['title', 'where', 'why', 'sure'],
    additionalProperties: false,
  },
} as const

/** The tool an agent reports with before it finishes. */
export const LEFTOVERS_TOOL = {
  name: 'tade_leftovers',
  description:
    'Report what you found wrong and did not fix — outside your task, or left on purpose — instead of only mentioning it: each one is put to the orchestrator, which decides whether it gets fixed, and nothing starts on it until then. Use it when you find something you will not fix; when you finish, tade_done takes the same list as leftovers.',
  parameters: {
    type: 'object',
    properties: { items: LEFTOVER_ITEMS },
    required: ['items'],
    additionalProperties: false,
  },
} as const
