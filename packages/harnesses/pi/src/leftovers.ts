// pi's copy of what an agent may report it found and did not fix:
// `tade_leftovers`, and the `leftovers` field of `tade_done`.
//
// The one copy is `@tade/harnesses-core/agent-tools`, which every other
// harness's tool server imports. pi loads its supervision extension under its
// own module resolution, so `tade.ts` imports nothing of Tade's — only files
// beside it that import nothing either, like this one — and this copy is held
// to that one, word for word, by `test/extension-tools.test.ts`.

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

/** The tool an agent reports with before it finishes, run in Tade like an extension's. */
export const LEFTOVERS_TOOL = {
  name: 'tade_leftovers',
  label: 'Leftovers',
  description:
    'Report what you found wrong and did not fix — outside your task, or left on purpose — instead of only mentioning it: each one is put to the orchestrator, which decides whether it gets fixed, and nothing starts on it until then. Use it when you find something you will not fix; when you finish, tade_done takes the same list as leftovers.',
  parameters: {
    type: 'object',
    properties: { items: LEFTOVER_ITEMS },
    required: ['items'],
    additionalProperties: false,
  },
} as const
