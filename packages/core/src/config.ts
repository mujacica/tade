import { z } from 'zod'
import { WebSurface } from './away.ts'
import { IntakeSurface } from './intake.ts'
import { PrepareConfigSchema } from './prepare.ts'
import { ModelPriceSchema } from './prices.ts'
import { GIVE_WAY_MAX } from './priority.ts'
import { PUSH_MODES } from './project.ts'

// Schema for ~/.tade/config.yaml. Objects are strict so a typo'd key is an
// error rather than a silently ignored setting.

// The drivers that exist. Names with no implementation behind them used to be
// listed here and validated clean, which reads as a promise.
const DriverId = z.enum(['pty', 'tmux'])
/** The harnesses an agent can run in: the registry in the workbench has one adapter for each. */
export const HARNESS_IDS = ['pi', 'claude-code', 'codex', 'acp'] as const
export type HarnessId = (typeof HARNESS_IDS)[number]
const Harness = z.enum(HARNESS_IDS)
const RouteName = z.string().regex(/^[a-z0-9][a-z0-9-]*$/)

/**
 * One way of running an agent. Model and provider are passed to the harness,
 * which owns credentials, so a subscription, an API key and a local endpoint
 * are all just different routes.
 */
/**
 * How hard an agent thinks before it answers, least to most. A harness takes
 * the nearest its model can do: a model that cannot think at all is `off`
 * whatever it is asked.
 */
export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
export type ThinkingLevel = (typeof THINKING_LEVELS)[number]

export const WorkerRoute = z.strictObject({
  harness: Harness.default('pi'),
  /** Harness provider name, e.g. `anthropic`, `openrouter`, `ollama`. */
  provider: z.string().optional(),
  /** Model id; may be `provider/id`. */
  model: z.string().optional(),
  /** How hard new agents think: the harness's own default when unset. */
  thinking: z.enum(THINKING_LEVELS).optional(),
  /**
   * What new agents start on in a harness other than the route's own. A model
   * chosen for a Claude Code agent is not one for pi's, and each harness names
   * its models its own way.
   */
  harnesses: z
    .partialRecord(
      Harness,
      z.strictObject({
        provider: z.string().optional(),
        model: z.string().optional(),
        thinking: z.enum(THINKING_LEVELS).optional(),
      }),
    )
    .optional(),
})
export type WorkerRoute = z.infer<typeof WorkerRoute>

/** What an account is called: a folder name, so nothing that needs quoting. */
export const AccountName = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]*$/)
  .refine((name) => name !== 'default', "'default' is each harness's own sign-in")

/**
 * An account a harness can run as, beside its own default: a second sign-in
 * kept apart from the first, so agents on both can work at once.
 */
export const Account = z.strictObject({
  harness: Harness,
  /** Signed in to a plan, in the harness's own sign-in; or paid for with an API key Tade keeps. */
  kind: z.enum(['subscription', 'api-key']).default('subscription'),
  /** Start it with your own settings, skills and plugins, rather than bare. */
  share: z.boolean().default(true),
  /**
   * For an `api-key` account: the key itself. The harness is given a command
   * that prints it rather than the key, so it is never in a launch line or in
   * anybody else's settings file — but it is here, in plain sight, where you
   * can check it against the one the console shows you.
   */
  key: z.string().optional(),
})
export type Account = z.infer<typeof Account>

/** Where agents do their work. */
export const AGENT_WORKSPACES = ['checkout', 'worktree'] as const
export type AgentWorkspace = (typeof AGENT_WORKSPACES)[number]

/** When an agent commits: everything when done, only its own files, as it goes, or never. */
export const COMMIT_RULES = ['when-done', 'own-files', 'as-you-go', 'never'] as const
export type CommitRule = (typeof COMMIT_RULES)[number]

/**
 * When Tade runs a project's checks on its own, and what a red one does.
 *
 * `before` is written as *what Tade does unasked*, because that is all it can
 * honestly promise: with `approvals.mode: 'policy'` a push an agent makes is
 * held while the checks run, and with the default `bypass` nothing can be
 * held at all — the agent is told the rule and Tade records what happened.
 * A person typing `git push` in a terminal is nobody's to hold.
 */
export const ChecksConfigSchema = z.strictObject({
  /** When Tade runs them unasked. `push` is the cheapest rule that catches what others would see. */
  before: z.enum(['off', 'commit', 'push', 'commit and push']).default('push'),
  /** What a failed required check does: hold it and hand back the tail, say so, or only write it down. */
  on_red: z.enum(['hold', 'tell', 'note']).default('hold'),
  /**
   * Run only these check ids; everything the project defines when empty. A
   * blunt narrowing, and not where the ACTIONS page writes what somebody said
   * about one check — that is `run_here`, which says the opposite of the
   * reading for the one check it names and goes on following the reading for
   * everything else, including whatever CI gains tomorrow.
   */
  only: z.array(z.string()).default([]),
  /**
   * Which of them Tade runs on *this* machine, by check id, over what the
   * project's own CI and commit hook say: `false` is one it does not run here,
   * `true` is one the reading gave up on and somebody wants anyway.
   *
   * Only what differs from the reading is written down, so a step added to CI
   * tomorrow is checked here tomorrow. Set from the ACTIONS page, and belongs
   * under `projects.<name>.checks` rather than here — a check id is one
   * project's own, and one written here applies to every project on the
   * machine.
   */
  run_here: z.record(z.string(), z.boolean()).default({}),
  /** How many of one run's checks may go side by side. One marked `alone` still runs by itself. */
  parallel: z.int().positive().default(2),
  /**
   * How many runs may hold this machine at once, across every project and
   * worktree — and a suite started from a shell waits for the same turn. The
   * machine's, so no project answers it (`ProjectConfigSchema.checks`).
   */
  suites: z.int().positive().default(1),
  /** How many finished runs a worktree keeps a record of. */
  keep: z.int().positive().default(200),
  /** Show what CI says about the same commit beside the local run. Inert without a forge. */
  ci: z.boolean().default(true),
})
export type ChecksConfig = z.infer<typeof ChecksConfigSchema>

export const ProjectConfigSchema = z.strictObject({
  root: z.string().min(1),
  /**
   * What to call it on screen, where that is not its name.
   *
   * **Its name is its id, and renaming is a label rather than an id.** The
   * name is in every task id (`tade/manage-projects`), in the `Tade-Task:`
   * trailer of every commit those agents made, in the folder each task keeps
   * its files in (`<home>/projects/<name>/tasks/`), and in every line of the
   * journal ever written about any of them. Nothing of that is Tade's to
   * rewrite: a trailer is on somebody else's machine the moment it is pushed, and the
   * journal is append-only on purpose. So a rename that changed the id would
   * orphan every task in it — which is worse than no rename at all — and this
   * is the whole of what one does instead: the tabs and the headings say this,
   * and every id stays exactly where it was.
   */
  title: z.string().min(1).optional(),
  brief: z.string().optional(),
  /**
   * Where this project's agents work, over `agents.workspace`. A repository
   * whose agents work on one thing at a time wants `checkout`; two unrelated
   * efforts in one repository want a `worktree` each — and on a machine with
   * both, both are true at once, which is why the answer is a project's and
   * not the machine's. Unset is the machine's answer, so a config written
   * before this key existed means exactly what it meant.
   */
  workspace: z.enum(AGENT_WORKSPACES).optional(),
  /** What reaches this project's remote, over `agents.push`; resolved by `pushFor`, which says where it cannot hold. */
  push: z.enum(PUSH_MODES).optional(),
  /** Names a route in `workers.routes`. */
  worker: RouteName.optional(),
  /** At most this many agents at once; as many as you start unless set. */
  max_parallel: z.int().positive().optional(),
  /**
   * How to check the work, for a project whose CI and commit hook cannot be
   * read. Everything else reads its checks out of what the project already
   * says — its workflows and its hook — so this is the whole of what anybody
   * writes down, and it is one line here rather than a file Tade puts in
   * somebody's repository.
   */
  test_command: z.string().min(1).optional(),
  /**
   * What this project may spend in a day. Checked before a run starts, with a
   * warning at 80%. Tokens are there for subscription providers, which report
   * no money at all.
   */
  budget: z
    .strictObject({
      usd_per_day: z.number().positive().optional(),
      tokens_per_day: z.int().positive().optional(),
    })
    .optional(),
  /** This project's own answer to any of the `checks` settings but `suites`, which is the machine's. */
  checks: ChecksConfigSchema.omit({ suites: true }).partial().optional(),
  /** What a new worktree is given before its agent starts, over what the project says (`prepare.ts`). */
  prepare: PrepareConfigSchema.optional(),
})

/**
 * The ways Tade can talk to a server, as a declaration names them.
 *
 * One list: the schema refuses anything else, and `tade mcp add` offers
 * exactly these — because a second copy of it somewhere would be the thing
 * that accepts a word the config then refuses to load. Which of them is
 * actually implemented is `MCP_TRANSPORTS` in the broker, which is a
 * different question: a name nothing implements yet is a server said to be
 * unreachable, not a config that will not load.
 */
export const MCP_TRANSPORT_NAMES = ['stdio', 'http', 'sse'] as const

/**
 * One MCP server, as a person declares it.
 *
 * Strict, because the schema is the only reader: a typo has to be an error at
 * `tade config --check` and never a setting silently ignored. What is left
 * out the catalogue fills in — `packages/mcp/core/src/catalogue.ts` ships the
 * ones Tade knows about, listed and off — and whether the merged declaration
 * can actually work is `declared()`'s to say, in words, because the catalogue
 * is code and the schema cannot see it.
 */
const McpServerSchema = z.strictObject({
  /**
   * Whether this server is on. Off for every one of them, the popular ones
   * included: a server is somebody else's code with tools your agents will
   * call. It connects the next time Tade starts; turning it off is at once.
   */
  enabled: z.boolean().optional(),
  /**
   * How Tade talks to it: `stdio` starts a program and talks over its pipes,
   * `http` and `sse` reach one that is already running, here or somewhere else.
   */
  transport: z.enum(MCP_TRANSPORT_NAMES).optional(),
  /**
   * The program Tade starts, for a `stdio` server. Tade never installs it:
   * one that is not there is listed as needing setting up, with the line to run.
   */
  command: z.string().min(1).optional(),
  /** What that program is started with. `${project}` is the project's root. */
  args: z.array(z.string()).optional(),
  /** Where an `http` or `sse` server answers. */
  url: z.string().min(1).optional(),
  /**
   * Environment the started program gets. Never a credential: those are kept
   * where credentials are kept and are never written here.
   */
  env: z.record(z.string(), z.string()).optional(),
  /** Headers sent with every request. Never a credential, for the same reason. */
  header: z.record(z.string(), z.string()).optional(),
  /**
   * How its credential reaches it: as an environment variable of the program
   * Tade starts, as `Authorization: Bearer`, or as a header you name.
   */
  auth: z.enum(['none', 'env', 'bearer', 'header']).optional(),
  /** The variable or header the credential goes in, for `env` and `header`. */
  auth_name: z.string().min(1).optional(),
  /**
   * The environment variable your key is already in, when it is not the one
   * Tade looks in. Whatever is set there wins over what you pasted.
   */
  key_env: z.string().min(1).optional(),
  /**
   * Offer only these of its tools to your agents, by the name Tade gives
   * them. Empty offers all — which is what a server you trust gets and one
   * you are trying does not.
   */
  tools: z.array(z.string()).optional(),
  /**
   * One of it for this window, or one per project, started in that project's
   * own directory. Never one per agent: that is a process per agent, and a
   * third party's handle on a worktree Tade's gate cannot see into.
   */
  scope: z.enum(['window', 'project']).optional(),
  /** What you turned it on for, in a line. The popular ones come with their own words. */
  about: z.string().optional(),
})

/** Whether a pattern compiles, so a typo is caught at `--check` time. */
function isPattern(source: string): boolean {
  try {
    new RegExp(source)
    return true
  } catch {
    return false
  }
}

/** The editors Tade knows how to open a file at a line in. */
export const EDITORS = [
  'code',
  'cursor',
  'windsurf',
  'zed',
  'idea',
  'subl',
  'nvim',
  'vim',
  'emacs',
  'system',
] as const

export type EditorName = (typeof EDITORS)[number]

/** How often the window asks what is current, and how long each answer stands. */
export const UPDATE_CHECKS = ['daily', 'weekly', 'never'] as const

export type UpdateCheck = (typeof UPDATE_CHECKS)[number]

/** How long an answer about what is current stands before the window asks again. Null is never. */
export function updateCheckEvery(check: UpdateCheck): number | null {
  if (check === 'never') return null
  return (check === 'weekly' ? 7 : 1) * 24 * 60 * 60 * 1000
}

/** Who answers when queued work is held: the person, asked by the orchestrator, or the orchestrator. */
export const QUEUE_HOLDS = ['ask', 'orchestrator'] as const

export type QueueHolds = (typeof QUEUE_HOLDS)[number]

export const ConfigSchema = z
  .strictObject({
    workspace: z
      .strictObject({
        driver: DriverId.default('pty'),
        /**
         * Where lanes go when the driver above cannot be provided — tmux asked
         * for on a machine without tmux. Reported loudly when it happens,
         * because agents that quietly stop outliving the window is exactly the
         * kind of thing you find out about at the worst moment. Set it to the
         * same value as `driver` to refuse instead.
         */
        fallback: DriverId.default('pty'),
        adopt: z.boolean().default(true),
      })
      .prefault({}),
    /** What each driver is made with, by its name in the workbench's registry. Read on open. */
    drivers: z
      .strictObject({
        pty: z
          .strictObject({
            /**
             * Lines each lane keeps to scroll back through. Every line is memory
             * for as long as the lane lives, in every lane, and fewer is history
             * nobody gets back — so lowering it is a person's call, and it
             * stays where it always was. Capped at ten times that, past which
             * thirteen full lanes stop being a cost and start being the machine.
             */
            scrollback: z.int().positive().max(100_000).default(10_000),
          })
          .prefault({}),
      })
      .prefault({}),
    orchestrator: z
      .strictObject({
        harness: Harness.default('pi'),
        // The harness renders either its own terminal UI or a machine protocol,
        // never both; Tade renders the orchestrator itself so voice and chat can
        // share one session.
        provider: z.string().optional(),
        model: z.string().optional(),
        /** How hard it thinks before it answers; the harness's own default when unset. */
        thinking: z.enum(THINKING_LEVELS).optional(),
        extensions: z.string().default('~/.tade/extensions'),
        /**
         * Look back at a task once it has finished, and write down a lesson if
         * there is one. Costs a turn per finished task; set false if you would
         * rather propose lessons yourself.
         */
        reflect: z.boolean().default(true),
        /** How full its context may get, in percent, before Tade compacts it between turns; 0 never. */
        compact_at: z.int().min(0).max(100).default(80),
      })
      .prefault({}),
    workers: z
      .strictObject({
        /** Which route to use when a project doesn't name one. */
        default: RouteName.default('default'),
        // prefault, not default: the fallback is an input to parse, so the
        // built-in route picks up the harness default like any other route.
        routes: z.record(RouteName, WorkerRoute).prefault({ default: {} }),
        /**
         * Which account new agents of each harness run as. Absent, the
         * harness's own sign-in — what you would get running it yourself.
         */
        accounts: z.partialRecord(Harness, AccountName).default({}),
      })
      .prefault({}),
    /** Accounts beyond each harness's own sign-in, by name. */
    accounts: z.record(AccountName, Account).default({}),
    approvals: z
      .strictObject({
        // Default: never interrupt. Tade still classifies and records every
        // tool call, so the journal stays honest even when nothing is gated.
        mode: z.enum(['bypass', 'policy']).default('bypass'),
        /** Tools that never ask, when mode is `policy`. */
        auto_allow: z.array(z.string()).default([]),
        /**
         * Your own rules, for the things only you know are dangerous here.
         * They can only make Tade stricter — there is no `auto` to write, and
         * where one disagrees with a built-in the stricter wins. Loosening is
         * `auto_allow`, which names exact tools on purpose.
         */
        rules: z
          .array(
            z.strictObject({
              /** A regular expression, matched against the command. */
              match: z.string().min(1).refine(isPattern, 'not a usable regular expression'),
              tier: z.enum(['soft', 'hard']),
              /** One clause to say out loud. */
              reason: z.string().optional(),
            }),
          )
          .default([]),
      })
      .prefault({}),
    // Only keys that drive something. A setting Tade accepts and ignores is
    // worse than one it doesn't have, because it reads like a promise.
    surfaces: z
      .strictObject({
        voice: z
          .strictObject({
            /** How speech becomes text. */
            stt: z
              .strictObject({
                // Local by default: what you say to your own machine about
                // your own code should not have to leave it.
                driver: z
                  .enum(['whisper-cpp', 'openai', 'groq', 'scripted'])
                  .default('whisper-cpp'),
                /** Path to a local model, where the engine needs one. */
                model: z.string().optional(),
                base_url: z.string().optional(),
                /** Keys are read from the environment, never stored here. */
                api_key_env: z.string().optional(),
                language: z.string().optional(),
                binary: z.string().optional(),
              })
              .prefault({}),
            /**
             * What Tade is willing to interrupt you for. The engine decides
             * per event; these are the two parts that are personal rather
             * than structural.
             */
            attention: z
              .strictObject({
                /** Spoken interruptions per hour. Beyond it, things wait. */
                budget: z.int().nonnegative().optional(),
                /** Local quiet hours, like `22:00-08:00`. Omit for none. */
                quiet: z.string().optional(),
              })
              .prefault({}),
            /**
             * The key you hold to talk, and whether holding it is how.
             * Validated where it can be understood — as a key the terminal can
             * send that does not type a character — by the window that reads it.
             */
            talk: z
              .strictObject({
                key: z.string().min(1).default('ctrl+space'),
                /** hold where the terminal reports releases; toggle everywhere. */
                mode: z.enum(['hold', 'toggle']).default('hold'),
              })
              .prefault({}),
            /** Say replies and news out loud. Off keeps the earcons and the text. */
            speak: z.boolean().default(true),
            /**
             * Nothing is said and nothing sounds: no speech, no earcons. The text stays.
             * On until somebody unmutes it: a Tade nobody has heard yet starts quiet.
             */
            muted: z.boolean().default(true),
            /** Where the speech comes from. */
            mic: z
              .strictObject({
                driver: z.enum(['ffmpeg', 'scripted']).default('ffmpeg'),
                /** Input device, in the backend's own terms. */
                device: z.string().optional(),
              })
              .prefault({}),
          })
          .prefault({}),
        /** The box `ctrl+k` opens, and what it is allowed to know. */
        search: z
          .strictObject({
            /**
             * Whether what is happening — what each agent is doing, what it was
             * asked for in their own words, what queued work waits on, your
             * notes — is put in front of whoever reads a sentence typed into
             * search.
             *
             * On, because without it the question is "which of these names did
             * you mean" and the answer to "the agent on test coverage" is not a
             * name. Off, search is what it always was: letters matched against
             * what Tade has, which never leaves the machine — and the letters
             * still read what is happening either way, because matching it here
             * sends nothing anywhere.
             *
             * Said where somebody is deciding, not only here: on the field
             * where the key that would read it is pasted, and in the README.
             */
            context: z.boolean().default(true),
          })
          .prefault({}),
        /**
         * The away view: Tade's own pages, served from this machine to a device
         * you paired, so "is anything waiting for me" has an answer from a
         * phone. Its keys are in `away.ts`, beside the sentences that have to
         * be said about each of them, and `surfaceOf` (`@tade/web`'s
         * `surface.ts`) is the one reader.
         */
        web: WebSurface,
        intake: IntakeSurface,
        /**
         * How the window is divided. Sizes are wishes: a sidebar wider than
         * the terminal leaves nothing to watch, so they are fitted rather than
         * obeyed. Which pane you were on is remembered separately, in
         * `<home>/window.json`, because that is the part people notice.
         */
        window: z
          .strictObject({
            sidebar_width: z.int().positive().optional(),
            strip_height: z.int().positive().optional(),
            /**
             * Where a file opens when you click it. Unset means: the editor
             * whose terminal Tade is running in, then $VISUAL or $EDITOR,
             * then whatever the system opens that kind of file with.
             */
            editor: z.enum(EDITORS).optional(),
            /**
             * How often the window asks what is current — the npm registry,
             * Homebrew, Tade's own git remote — and puts a chip in the strip
             * when something can move forward. `never` asks nothing on a
             * clock; Settings › Updates still asks when its button is pressed.
             */
            check_updates: z.enum(UPDATE_CHECKS).default('daily'),
            /**
             * The keys the window keeps for itself, by what they do. Anything
             * not here goes to the agent or terminal you are typing at. A key
             * with shift, or ctrl with a digit or m, reaches Tade only where
             * the terminal speaks the Kitty keyboard protocol.
             */
            keys: z
              .strictObject({
                search: z.string().min(1).default('ctrl+k'),
                next_agent: z.string().min(1).default('tab'),
                previous_agent: z.string().min(1).default('shift+tab'),
                orchestrator: z.string().min(1).default('ctrl+/'),
                next_waiting: z.string().min(1).default('ctrl+q'),
                new_agent: z.string().min(1).default('ctrl+n'),
                new_terminal: z.string().min(1).default('ctrl+t'),
                open_project: z.string().min(1).default('ctrl+o'),
                mute: z.string().min(1).default('ctrl+m'),
                extensions: z.string().min(1).default('ctrl+shift+e'),
                settings: z.string().min(1).default('ctrl+,'),
                fill_bottom: z.string().min(1).default('ctrl+shift+f'),
                keys_sheet: z.string().min(1).default('f1'),
                reload: z.string().min(1).default('ctrl+shift+r'),
                approve: z.string().min(1).default('a'),
                deny: z.string().min(1).default('d'),
                /** Held with 1–9: the agent in that place in the sidebar. `off` for none. */
                agent_by_number: z.string().min(1).default('ctrl'),
                /** Held with 1–9: the project in that place along the top. `off` for none. */
                project_by_number: z.string().min(1).default('ctrl+shift'),
              })
              .prefault({}),
          })
          .prefault({}),
      })
      .prefault({}),
    /** How agents work in a project, and what they are told about committing. */
    agents: z
      .strictObject({
        /**
         * `checkout`: every agent works in the project's own checkout, on the
         * branch it is on, at the same time. `worktree`: each gets a git
         * worktree of its own, and a branch named for its work.
         *
         * The answer for a project that has not given its own
         * (`projects.<name>.workspace`), which is what `workspaceFor` reads.
         */
        workspace: z.enum(AGENT_WORKSPACES).default('checkout'),
        /** When agents commit, and what. */
        commit: z.enum(COMMIT_RULES).default('own-files'),
        /**
         * What they do with it once it is green, for a project that has not
         * said (`pushFor`).
         *
         * **No default here, deliberately**, which is the one place this key
         * differs from its neighbours: what "nothing set" means depends on
         * where the agents work (`pushDefault`), and a schema default would
         * make a person's `never` and a file that never mentioned pushing the
         * same answer. The resolution is `pushFor`'s and nowhere else's.
         */
        push: z.enum(PUSH_MODES).optional(),
        /** Anything else every agent should be told, in your words. */
        instructions: z.string().optional(),
        /**
         * Hold the machine awake while Tade is open, so a sleep never takes
         * the agents' turns down with it (`KEEP_AWAKE_MEANS`, `sleep.ts`).
         *
         * Off by default, and that is the decision rather than the absence of
         * one: an anti-sleep hold is somebody deciding their laptop should not
         * sleep, not a thing to turn on for them because it suits the agents.
         * Off, the other half still holds — an agent a sleep cut off is told
         * to carry on when the machine wakes.
         */
        keep_awake: z.boolean().default(false),
        /**
         * Start agents and check runs this many steps below the window's own
         * OS priority (POSIX `nice`), so a keystroke does not wait behind a
         * `tsc`. 0 is off. Off by default because lowering a check suite is
         * not free: a check with a timeout can go from slow to `timed out`.
         * `priority.ts` carries the rest of the argument.
         */
        give_way: z.number().int().min(0).max(GIVE_WAY_MAX).default(0),
      })
      .prefault({}),
    /**
     * Where Tade's own trouble goes: its crashes, the warnings it writes down,
     * what its agents spent. Nothing is sent until a DSN is set, and what is
     * sent is the shape of what happened — never your code, what you said, or
     * what an agent wrote. It is your own Sentry project, so the Sentry
     * extension can watch it and hand its own bugs to an agent.
     */
    telemetry: z
      .strictObject({
        /** Which reporter: `sentry`, or `none` to send nothing whatever else says. */
        driver: z.enum(['sentry', 'none']).default('sentry'),
        /**
         * The Sentry project to send to, as a DSN. Empty — the default — sends
         * nothing at all, and `$TADE_TELEMETRY_DSN` is what is used then: this
         * is the setting, the variable is the fallback under it, so a DSN
         * typed into Settings is never a setting Tade accepts and ignores.
         *
         * An ordinary string and not a credential. A DSN is an ingest
         * endpoint — it is published in the JavaScript of every page Sentry
         * watches, and grants only the right to send events to one project —
         * so it lives here, in the file, where it can be read back and
         * checked. Sentry's auth token is the credential, and is not here.
         */
        dsn: z.string().default(''),
        /** Crashes, and the warnings Tade writes down, as issues to fix. */
        errors: z.boolean().default(true),
        /** What happened around them — tasks, runs, the queue — as logs. */
        logs: z.boolean().default(true),
        /** Tokens, money and how many agents are running, as metrics. */
        metrics: z.boolean().default(true),
        /**
         * How much of what Tade itself does is timed, from 0 to 1: opening the
         * window, a slow look at the tasks. Agents' turns are timed whatever
         * this says, because there are few of them and each one matters.
         */
        traces: z.number().min(0).max(1).default(0.1),
        /**
         * Time what agents do as the work of a model — turns, the tools they
         * call, what they cost — which is what Sentry draws its agent
         * monitoring from.
         */
        agents: z.boolean().default(true),
        /** Which Tade this is, in Sentry's environment filter. */
        environment: z.string().default('laptop'),
      })
      .prefault({}),
    /**
     * What the journal keeps.
     *
     * `events.jsonl` is the truth and everything folds over all of it, so what
     * it costs to read is what everything costs. Almost all of it is a byte
     * count per lane — a sample of output that still sits in the lane's
     * scrollback, that nothing reads back, and that was 86% of the lines of a
     * 54 MB journal after eleven days. As much of that as fits is kept, newest
     * first, and the rest is dropped; nothing else ever is, because nothing
     * else can be asked again.
     */
    journal: z
      .strictObject({
        /**
         * How big `events.jsonl` may get. Under it, nothing is read and
         * nothing is written: the whole check is one `stat` on open. Over it,
         * the next window open drops the oldest sampled byte counts until it
         * fits again — and only those, because a commit, a check run, a turn's
         * cost and everything else are the only record there is of themselves.
         */
        max_mb: z.int().positive().default(16),
      })
      .prefault({}),
    /**
     * What the documents folder keeps.
     *
     * A document a task produced outlives its task, so something has to say
     * when one is not needed any more — and it is never a clock alone. On
     * every open, a document somebody decided about at least this long ago,
     * whose follow-up has all finished, is deleted and the deletion written to
     * the journal (`documentsToCompact`). One nobody decided about is kept
     * however old it gets: only a person deletes that.
     */
    documents: z
      .strictObject({
        keep_days: z.int().positive().default(30),
      })
      .prefault({}),
    /**
     * Who decides about held queued work. Words in what the orchestrator is
     * told — its prompt and each hold (`heldMessage`) — and never a gate: what
     * it may do to the queue is the same either way. The orchestrator unless
     * somebody says otherwise, because the person asked for that on every
     * machine: a hold put to them was a hold they had already said was not
     * theirs, and `ask` is there for whoever wants it back.
     */
    queue: z
      .strictObject({
        holds: z.enum(QUEUE_HOLDS).default('orchestrator'),
      })
      .prefault({}),
    /** When a project's own checks run, and what a red one does. */
    checks: ChecksConfigSchema.prefault({}),
    /**
     * What a model costs per million tokens, for anybody on a rate Tade does
     * not ship. Read only where the harness that spent it prices nothing, keyed
     * by the model's own name with no routing in front of it, and never
     * fetched — `core/src/prices.ts` is the table, its date and the reasoning.
     */
    prices: z.record(z.string().min(1), ModelPriceSchema).default({}),
    projects: z.record(z.string().regex(/^[a-z0-9][a-z0-9-]*$/), ProjectConfigSchema).default({}),
    /**
     * The MCP servers this machine is set up to reach, by name. One that
     * somebody turns on becomes an extension whose tools are that server's
     * tools, and every harness and the orchestrator are handed those the way
     * they are already handed Tade's own — so there is one table, one
     * namespace and one gate, and no harness is given a config of its own.
     *
     * Everything here is off until a person says otherwise, the ones the
     * catalogue ships included: a server is somebody else's code with tools
     * your agents will call, and an agent or the orchestrator may propose one
     * but never turn one on.
     */
    mcp: z
      .strictObject({
        servers: z
          .record(z.string().regex(/^[a-z0-9][a-z0-9-]{0,15}$/), McpServerSchema)
          .default({}),
      })
      .prefault({}),
    /**
     * Settings for each extension, by its name. Which keys mean something is
     * the extension's to say, so they are checked against what it declares
     * when it loads — a key it does not read is reported, never silently kept.
     * `enabled: false` turns one off.
     */
    extensions: z
      .record(
        z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
        z.looseObject({ enabled: z.boolean().optional() }),
      )
      .default({}),
  })
  // A route name that doesn't exist is a typo that would otherwise surface as a
  // failed spawn much later, so catch it at `tade config --check` time.
  .superRefine((config, ctx) => {
    const routes = Object.keys(config.workers.routes)
    const single = routes.length === 1
    if (!routes.includes(config.workers.default) && !single) {
      ctx.addIssue({
        code: 'custom',
        path: ['workers', 'default'],
        message: `unknown route "${config.workers.default}" (have: ${routes.join(', ') || 'none'})`,
      })
    }
    for (const [harness, name] of Object.entries(config.workers.accounts)) {
      const account = name ? config.accounts[name] : undefined
      if (!account) {
        ctx.addIssue({
          code: 'custom',
          path: ['workers', 'accounts', harness],
          message: `no account called "${name}" (have: ${Object.keys(config.accounts).join(', ') || 'none'})`,
        })
      } else if (account.harness !== harness) {
        ctx.addIssue({
          code: 'custom',
          path: ['workers', 'accounts', harness],
          message: `"${name}" is a ${account.harness} account, not ${harness}'s`,
        })
      }
    }
    for (const [name, project] of Object.entries(config.projects)) {
      if (project.worker && !routes.includes(project.worker)) {
        ctx.addIssue({
          code: 'custom',
          path: ['projects', name, 'worker'],
          message: `unknown route "${project.worker}" (have: ${routes.join(', ') || 'none'})`,
        })
      }
    }
  })

export type Config = z.infer<typeof ConfigSchema>
export type ProjectConfig = z.infer<typeof ProjectConfigSchema>
