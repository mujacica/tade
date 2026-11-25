import type { WorkerCapabilities } from '@tade/harnesses-core'

// What OpenCode can be asked to do, declared once: its own file so the adapter
// is the protocol, and this is the promise about it. Each was seen in OpenCode
// 2.4.1 itself, in a lane, against a scripted model: Tade's plugin is inside
// its server, so almost everything said to the agent goes through OpenCode's
// own session API rather than its terminal.

export const OPENCODE_CAPABILITIES: WorkerCapabilities = {
  // Every permission OpenCode evaluates passes through the plugin's hook, and
  // under approvals the run's config makes every action ask, so a plugin that
  // could not load leaves OpenCode asking in its own terminal — never running
  // a call nobody was asked about.
  permissionGate: true,
  // `session.prompt` with `delivery: "steer"`, which OpenCode takes into the
  // turn that is running at its next step.
  steer: 'live',
  // The same, with `delivery: "queue"`: kept by OpenCode and run once the turn ends.
  queue: 'live',
  // `session.interrupt`, which stops the turn and keeps the session.
  abort: 'live',
  // `session.switchModel`, for this session only.
  model: 'live',
  thinking: 'none',
  thinkingLevels: [],
  // `session.update`, which the TUI shows at once.
  rename: 'live',
  images: 'path',
  visibleUi: true,
  // `-s` comes back to the session Tade made under the task's id.
  resume: true,
  // A session keeps the model it is on in OpenCode's own record.
  resumeKeeps: true,
  // Its conversation is OpenCode's record, written as it goes: a turn the
  // machine cut off ends failed or stopped, and the next thing said to it is
  // said in the same conversation.
  continues: true,
  done: true,
  nativeExtensions: false,
  // Handed over for the run in its config (`skills`), beside OpenCode's own.
  skills: true,
  tools: true,
  mcp: true,
  // A process per turn (`opencode run`) on the task's one session, with the
  // same plugin in each: the thing you talk to.
  headless: true,
  spend: { usd: 'estimate', tokens: true, limits: 'anytime' },
  accounts: true,
  // Headless, between turns: `session.compact` asked of a server of its own
  // (`SERVER`, `adapter.ts`), which stays until the compaction is done. In a
  // lane, the TUI's own /compact.
  compact: 'idle',
  pins: false,
  conversation: { replicate: false },
  why: {
    thinking:
      'thinks as its model’s variant says, and each model names its own: choose one with the model, as provider/model#variant',
    images: 'is shown a picture as a file it is told about, since its terminal cannot take one',
    nativeExtensions:
      'has no place for pi extensions: their tools and skills still reach it, their own code does not',
    spend:
      'says what each step cost as the endpoint reported it or as its own catalog prices it, and records a plan’s steps — ChatGPT, GitHub Copilot, OpenCode Go — as costing nothing, which Tade counts as a plan’s and never as money',
    limits:
      'can say how much of a plan is used only for OpenCode Go, signed in with an OpenCode account; it reads no ChatGPT or Copilot limits at all',
    compact:
      'compacts only between turns, and an agent in a lane only when /compact is typed into it',
    conversation:
      'keeps its conversation in its own database, which Tade cannot merge across machines, so each machine has its own',
  },
}
