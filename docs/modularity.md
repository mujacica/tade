# Making Tade modular — a plan

**Status: parked. Do not start it.** It waits on the features in flight finishing — as of writing,
25 open task folders, several of them editing the same files this plan moves. Picking it up early
means conflicting with every agent holding an edit to `app.ts`, which was touched in 92 of the last
200 commits. When the tree is quiet, start at slice 0 in §5.

Nothing here has been changed; this is what to do and in what order. Measured on `main` at
`292e57b`, 2026-09-21 — the counts age, the shape does not. Re-run the measurements in §1 before
starting, and if a number has moved a lot, read §2 again before trusting §5's ordering.

A note on where this lives: `CLAUDE.md` says there is no `docs/` folder and that adding one is
going backwards, because a plan that outlives its build becomes a second description of the system
that nothing keeps honest. This file is here by explicit decision, against that rule. It earns the
exception only while it stays a plan — **delete it when §5 is done**, and put anything worth keeping
into `.claude/skills/change-the-window` and the tests in §7, which are the things that cannot drift
from the code.

## The diagnosis, in one paragraph

Tade already decided where things go, and wrote it down. `.claude/skills/change-the-window`
says `app.ts` holds *"wiring only"*, and — twice — *"Put behaviour in `model.ts` and drawing in
`view.ts`. If `app.ts` grows a rule, it is in the wrong file and cannot be tested"* and *"5. Wire it
in `app.ts`. No rules here."* That rule drifted, and nothing was watching. So this is not a
redesign: it is restoring a layout the repo already believes in, and then making the drift
impossible to repeat. Which means **the enforcement in §7 is the deliverable, not the file moves.**
Without it the same file grows back and this document gets written a second time.

The second finding is harder and matters more than size. The existing split is **by layer** —
`model` (state) / `view` (draw) / `panels` (panel state) / `panel-view` (panel draw) / `app`
(wiring). Layers are why every feature is a five-file edit: 72 of the last 200 commits touched two
or more of those five files, 30 touched four or five. Splitting each layer into smaller layer files
would fix conflicts and navigation and leave that number exactly where it is. The fix for *that* is
to split **by subject inside each layer**, and where two layers are both pure, to put the subject's
two files next to each other. §3 does that.

## 1. Inventory

132,122 lines of `.ts` in 15 packages. `packages/app` is 47,431 of them — 36% of the repo.

| File | Lines | Shape | In last 200 commits |
|---|---:|---|---:|
| `packages/app/src/app.ts` | 8,295 | one class, 94 fields, 215 methods | **92** |
| `packages/app/src/view.ts` | 4,482 | `Frame` + `draw()` + 9 region renderers, pure | 73 |
| `packages/app/src/panel-view.ts` | 4,141 | one draw function per panel, pure | 40 |
| `packages/app/test/screens/scenarios.ts` | 3,333 | one array of 99 literals | 56 |
| `packages/app/src/panels.ts` | 3,061 | one type + state machine per panel, pure | 37 |
| `packages/app/test/app.test.ts` | 2,776 | 84 tests through a fake terminal | 68 |
| `packages/workbench/src/workbench.ts` | 2,372 | facade, 106 methods over 8 collaborators | 43 |
| `packages/app/src/model.ts` | 1,855 | ~90 small pure functions + `AppState` | 41 |
| `packages/harnesses/codex/src/adapter.ts` | 1,629 | one class implementing one port | — |
| `packages/harnesses/claude/src/adapter.ts` | 1,537 | one class implementing one port | — |
| `packages/extensions/core/src/host.ts` | 1,449 | `ExtensionHost`, 927 of it one class | — |
| `packages/app/test/view.test.ts` | 1,365 | 78 tests | 36 |
| `packages/extensions/jev/src/extension.ts` | 1,309 | one 1,016-line object literal | — |
| `packages/app/src/live.ts` | 1,195 | 4 pure folds + `Live` (830-line class) | 40 |
| `packages/core/src/settings.ts` | 1,114 | `settingsOf` is one 744-line table | — |

The eight biggest files are 30,315 lines — 23% of the repo.

**Two different kinds of big file are in that list, and they need different answers.**

*Big declarations* — one flat table enumerating things: `settingsOf` (744 lines of setting rows),
`jevExtension` (1,016 lines of tool definitions), `orchestratorTools` (692), `reviewExtension`
(850), `SCENARIOS` (99 literals). Long, flat, independent entries, no tangle. Size here is a
navigation cost, not a coupling cost, and splitting is mechanical and nearly risk-free.

*Big behaviour* — `App` (7,137 lines of class), `Workbench` (2,057 lines of methods), the two
harness adapters, `Live`. Only one of these is actually a problem, and it is `app.ts`.

### What is actually inside `app.ts`

The `App` class is lines 879–8016. 94 fields, 215 methods, 6,915 lines of method body; 279 lines of
module-level helpers sit below it. Every method assigned to a subject, nothing left over:

| Subject | Lines | % | The methods |
|---|---:|---:|---|
| actions | 718 | 10.4% | `run` (348), `submitPanel`, `savePrompt`, `applyPanel`, `openMenu`, `fromMenu` |
| extensions + MCP | 650 | 9.4% | `extensionViews`, `serverViews`, `fromExtensions`, `saveSetup`, `runExtension`, `openListRow`, … |
| agents | 644 | 9.3% | `newAgent`, `startTask`, `openAgent`, `closeAgent`, `fromTaskMenu`, `chooseModel`, `decide`, … |
| frame assembly | 566 | 8.2% | `frameFor` (150), `panelFacts` (78), `panelInputs` (39), `menuItemsFor` (82), room/size getters |
| lifecycle | 491 | 7.1% | `start`, `begin` (129), `tick`, `look`, `stop`, `draw`, `repaint`, `remember`, `recall` |
| typing + selection | 476 | 6.9% | `onInput` (179), `type`, `moveOrExtend`, `caretAt`, `submit`, `loadHistory` |
| orchestrator | 430 | 6.2% | `ask`, `say`, `tell`, `brief`, `show`, `reflect`, `thinkWith`, `onScreen` |
| lanes + terminals | 404 | 5.8% | `laneScreen`, `reslice`, `captureTerminal`, `watch`, `fitLane`, `openTerminal`, `voiceTerminals` |
| pointer | 402 | 5.8% | `pointer` (158), `clicked` (150), `dragSplit`, `halves` |
| files + git | 379 | 5.5% | `openFile`, `saveFile`, `openDiff`, `fromFileMenu`, `fromChangeMenu`, `switchBranch`, `discard` |
| queue | 346 | 5.0% | `queueTools` (229), `doAdvanceQueue`, `changeQueue`, `recordRulesMet` |
| search | 299 | 4.3% | `searchable`, `openSearch`, `searchEntries`, `lookInFiles`, `askWhatIsMeant`, `fromSearch` |
| schedules | 246 | 3.6% | `doLookWith` (104), `doRunSchedules`, `fire`, `scheduleViews`, `onSchedule` |
| the machine | 201 | 2.9% | `lookAtWhatIsInstalled`, `updateAction`, `accountAction`, `signInto`, `loadAccounts` |
| voice | 143 | 2.1% | `talkStart`, `talkStop`, `toggleMute`, `muteable`, `testMicrophone` |
| settings | 136 | 2.0% | `openSettings`, `settingRows`, `saveSetting`, `saveKey` |
| checks | 123 | 1.8% | `adoptChecks`, `runChecks`, `showCheck` |
| images + clipboard | 122 | 1.8% | `attachImages`, `giveImages`, `attachClipboard`, `lookAtClipboard`, `handOff` |
| open project | 99 | 1.4% | `openRowsFor`, `openProject` |
| notes | 40 | 0.6% | `openNote`, `fromNoteMenu`, `forgetNote` |

Twenty subjects, none over 11%. That is the shape of a file that grew by accretion rather than one
idea that got big.

## 2. Where the seams already are

**The field-ownership measurement is the whole argument.** Of the 94 fields on `App`, only **nine**
are touched by more than six methods:

```
141  state      114  opts       57  live       28  terminal    17  editor
 10  skin        10  anchor      8  stopped     7  tui
```

The other **85 fields are touched by six methods or fewer**, and they cluster by subject exactly as
the table above does — `updates`/`updatesBusy` only in the four machine methods, `grepped`/
`grepping`/`grepTimer` only in search, `recording`/`metering` only in voice, `fired`/`lookingWith`
only in schedules, `mcpShown`/`setupShown`/`setupChoices` only in extensions. So `App` is not a god
object with pervasive shared state. It is **twenty small objects sharing one `this`**, plus a
five-name context (`state`, `opts`, `live`, `now()`, `draw()`) that every one of them needs.

That is the cheap, safe seam, and it is most of the file.

**Already the right shape, merely in the wrong file:**

- **The nine `render*` regions in `view.ts`** share one signature —
  `(state, frame, width, [height], skin, pointer) → Drawn` — compose only through `draw()`'s
  `add()`, and are pure. (`renderSchedule`/`renderQueued` take the one extra argument they draw;
  `actionRows`/`checkRows` return `{text, hits}[]` rather than `Drawn`, which is why they belong in
  a region file rather than being regions themselves.) `plan-graph.ts`, `spend.ts`,
  `transcript-view.ts` and `scrollbar.ts` were already carved out this way — the precedent exists
  and worked. Cutting the rest is close to mechanical.
- **Every panel in `panels.ts` + `panel-view.ts`.** Each panel is already a complete unit: its
  type, its `xPanel()` constructor, its `xKey()`/`xClick()` transitions, and its `x(panel, ctx):
  Drawn`. `panelKey`/`panelClick`/`drawPanel` are three dispatch tables over them. Both files are
  verified pure — no `node:` imports, no clock reads.
- **`live.ts`'s folds.** `snapshotsFrom`, `changesFrom`, `commitsFrom`, `changedFrom`, `knownTasks`
  are already pure and already exported and already tested apart from the polling.
- **`model.ts` is not a problem at all.** 1,855 lines, largest function 80, and 155 of those lines
  are the `AppState` interface. A module of small pure functions that happens to be long.
- **`Workbench` is a facade over collaborators that are already split** (`log`, `registry`,
  `workers`, `driver`, `memory`, `kept`, `adapters`). Average method 19 lines. Most of it is
  one-line delegation, which is the facade doing its job.

**Tangled, and where the actual risk is:**

- **The three frame-assembly hubs.** `frameFor`, `panelFacts` and `panelInputs` each read fields
  from a dozen different subjects (`panelFacts` alone touches `models`, `harnessPieces`,
  `accountViews`, `updates`, `updatesBusy`, `offersByTask`, `branchRows`, `extensionShown`,
  `pickerModels`, `openCache`, `diff`, `grepping`). Every subject you move out needs its slice of
  `Frame`/`PanelContext`/`PanelInputs` handed back. These cannot be moved; they have to be
  **inverted** into a fold over contributors. That is the one piece of real design work.
- **`App.run` (348 lines).** A string-prefix `if` chain over ~40 action names, dispatching into
  every subject. It is the write-side twin of `frameFor`.
- **`onInput` (179) / `pointer` (158) / `clicked` (150).** One long decision each, over keyboard
  routing, wheel target and hit target. Mostly routing rather than subject work; they thin out once
  the subjects own their own handlers, but they need care: the routing order *is* the behaviour.
- **`view.ts` ↔ `panel-view.ts` is a cycle.** `view` imports `drawPanel` (a value); `panel-view`
  imports `Change` (a type). Type-only, so erased, so harmless at runtime — but there is no clean
  layering today. `live.ts` also reaches into `view.ts` for `ActionsView`, `Change`, `CheckView`,
  `CommitView`, `NoteShown`, and `hits.ts` reaches into `panels.ts` for `MenuSubject`. All of it is
  one cause: **`view.ts` holds the data contract and the drawing in the same file.** Lifting the
  contract out (§3) fixes all three edges at once.
- **`Live` (830-line class)** is fifteen independent `Map` caches with a TTL each, plus one
  `doRefresh`. Not tangled, but the caches have no shared shape; it wants a tiny cache helper more
  than it wants splitting.

**The 1,225-line trap.** Only 63 of the 215 `App` methods (1,225 lines) are free of `await`, the
workbench, the filesystem, the terminal and the clock. So the tempting story — "extract the pure rules to `model.ts`" — accounts for 18%
of the file and then stops. The other 5,690 lines are genuinely impure orchestration, and the win
there comes from **grouping the wiring by subject**, not from purifying it. Anyone who starts this
work expecting to find pure functions to lift out will extract about a fifth of the file and
conclude the rest is irreducible. It isn't; it's just not pure.

## 3. The target layout

Directories inside `packages/app/src`, so the existing `"./*": "./src/*.ts"` export map keeps
working and nothing outside the package changes. Dependencies point **down** this list only.

### 3.1 The contract, lifted out of the drawing

```
src/frame.ts          Frame, LaneView, Change, ActionsView, CheckView, CommitView,
                      NoteShown, Spend, ListRowView, ListSectionView, AgentOffers re-export.
                      Types only. No imports from view/, panels/, live.
```

This is the fix for all three bad edges: `live.ts` imports `frame.ts` instead of `view.ts`,
`panel-view` needs nothing from `view`, and the cycle is gone. Do this one first and alone (§5,
slice 0) — it is ~200 lines moved, touches five files' import blocks, and unlocks the rest.

### 3.2 The drawing — `view.ts` 4,482 → `view.ts` ~250 + 9 files

`draw()` stays in `view.ts` and stays the only export anybody calls. Each region becomes a file
exporting one function with today's signature, unchanged:

| File | Holds | ~Lines |
|---|---|---:|
| `view.ts` | `draw`, `renderApp`, `BUTTONS`, `splitView`, `besideFirst`/`belowFirst`, the composition | 250 |
| `view/top.ts` | `renderTop`, `toastFor`, `talkChip` | 200 |
| `view/sidebar.ts` | `renderSidebar`, `Section`, `headingFit`/`headingControls`/`headingWidth`, `noteFitting`, badges, `whereRows`, `fileRow`, `listSections`, `listRow`, `noteRow`, `changeRow` | 900 |
| `view/main.ts` | `renderMain`, `laneLines`, `blockAt`, `typingIn`, `underTargets`, `withApproval`, `renderWelcome`, `describeState` | 650 |
| `view/actions.ts` | `actionRows`, `commitRow`, `checkRows`, `toneFor`, `glyphFor` | 400 |
| `view/queue.ts` | `renderQueued`, `queueSection`, `queueRow`, `queueSpread`, `queueStems`, `queueLook`, `queueSays`, `queueFilters`, `queueWord`, `taskRow`, `edged` | 700 |
| `view/schedule.ts` | `renderSchedule`, `scheduleRow`, `scheduleMark`, `schedulesHere` | 250 |
| `view/plan.ts` | `renderPlan`, `planPicture`, `planBoxes`, `planTone`, `planPaint` (joins `plan-graph.ts`) | 200 |
| `view/strip.ts` | `renderStrip`, `inputRows`, `inputBox` | 320 |
| `view/foot.ts` | `renderFoot`, `bottomTabs`, `terminalBody`, `scrolledBar`, `levelMeter`, `laneLabels` | 400 |
| `view/rows.ts` | shared row builders: `tabList`, `tabbed`, `secondRow`, `barBeside`, `isScrolling`, `markTone`, `toneOf`, `doing` | 200 |
| `view/text.ts` | shared width/word helpers: `shortened` (used 29×), `wrapWords`, `cutAtWord`, `saidShort`, `tailOf`, `shortPath`, `wrapPath`, `capitalised`, `clock`, `clockOf`, `spell`, `tokens`, `dollars`, `shortModel` | 250 |

`view/rows.ts` and `view/text.ts` are not a dumping ground — they exist because the measurement
says these helpers are genuinely shared (`shortened` 29 uses, `tabbed` 7, `wrapWords` 6,
`barBeside` 6). A helper used in one region goes in that region's file.

### 3.3 The panels — one folder per panel, state and drawing together

`panels.ts` (3,061) and `panel-view.ts` (4,141) are both pure, so co-locating them costs nothing
and is the one change that reduces files-per-feature. A change to Settings becomes two adjacent
files instead of two shared 3–4k-line files.

```
src/panels.ts              the Panel union, PanelOutcome, PanelInputs,
                           panelKey/panelClick dispatch, matchingChoices. ~250 lines.
src/panels/context.ts      PanelContext, PanelDrawing, drawPanel dispatch,
                           sideWidth, formLayout, shared cells (pad, cap, fitTo, money). ~350
src/panels/settings/       state.ts (settingsKey, settingsClick, operate, visibleSettings,
                             accountActions, updateActions, writeOf, usesDropdown)  ~450
                           view.ts (settings, drawUpdates, control, settingsDropdown,
                             capture, badgeFor)                                     ~850
src/panels/extensions/     state.ts (extensionEntries, extensionsKey/Click,
                             extensionControls, setupKey/Press, toolSummary)        ~600
                           view.ts (extensions, extensionBody, extensionView,
                             extensionSetup, extensionsSize/Scrollable)             ~800
src/panels/spend/          state.ts (~60) · view.ts (spend, spendColumns, nameLines,
                             pricedFooter, SPEND_* )                                ~400
src/panels/file/           state.ts (filePanel, fileKey/Click, askKey, typingKey,
                             scrollFile, savedFile, fileMatches, atLine)            ~350
                           view.ts (fileView, fileBar, laidOver, colouredAt)        ~300
src/panels/project/        state.ts (openProjectPanel, openKey/Click, navigate,
                             goTo, nameFrom) · view.ts (openProject, crumbsOf)      ~400
src/panels/search/         state.ts · view.ts (search, resultRow)                   ~250
src/panels/models/         state.ts (modelPanel, modelChoices, modelKey,
                             priceCells, perMillion) · view.ts (models)             ~250
src/panels/menu/           state.ts (MenuSubject, every *MenuItems, menuPanel,
                             agentOffers) · view.ts (menu)                          ~500
src/panels/small.ts        confirm · confirmRemove · closeDone · quit · reload · find ·
                           branches · prompt · diff · keys — one type, its keys and its
                           drawing each, none over 120 lines, all in one file        ~700
```

`MenuSubject` moves to `panels/menu/state.ts`, and `hits.ts` imports it from there — still a type,
still erased, but now pointing at the thing that owns it rather than at the panel barrel.

`panels/small.ts` is deliberate. Ten panels at 40–120 lines each do not each want a folder; a
folder per panel below some size is indirection for its own sake. The threshold to apply: a panel
gets a folder when its state plus its drawing exceeds ~250 lines.

### 3.4 `app.ts` — 8,295 → ~600 + 20 subject modules

The shape. One narrow context, twenty subjects that own their own fields, and `App` reduced to
holding the context, the frame fold and the routing.

```ts
// src/wire/context.ts — what every subject may reach, and nothing more.
export interface Wiring {
  readonly opts: AppOptions          // client, config, home, cwd, extensions, report…
  readonly state: AppState           // read
  put(next: AppState): void          // write; the only writer
  readonly live: Live | null
  now(): number
  draw(): void
  note(err: unknown): void           // the `notice(this.state, why(err))` pattern, once
}
```

`opts.client` is read 102 times today, `opts.config` 57. Those stay reachable; what changes is that
a subject reaches them through a named interface instead of through `this`.

Each subject is a small class over `Wiring`, owning the fields the measurement showed are its
alone, and offering up to four things:

```ts
export interface Subject {
  /** Its slice of the frame, folded in by frameOf(). */
  facts?(width: number): Partial<Frame>
  /** Its slice of PanelContext / PanelInputs. */
  panel?(): Partial<PanelContext>
  inputs?(): Partial<PanelInputs>
  /** The action prefixes it answers, so run() is a table not an if-chain. */
  actions?(): Record<string, (rest: string) => Promise<void> | void>
}
```

| File | Owns (fields) | Lines |
|---|---|---:|
| `app.ts` | `App`: construct, `start`, `stop`, `wait`, `begin`, `tick`, `look`, `draw`, `repaint`, the `Wiring`, the subject list | ~600 |
| `wire/context.ts` | `Wiring`, `AppOptions`, `Thinker`, `WorkerImageFile` | ~150 |
| `wire/frame.ts` | `frameOf(subjects, state, live, width)` — folds `facts()`/`panel()`/`inputs()`. Replaces `frameFor`, `panelFacts`, `panelInputs`, `menuItemsFor` | ~250 |
| `wire/actions.ts` | `run(action)` as a prefix table built from the subjects' `actions()`; `submitPanel`/`applyPanel` dispatch | ~250 |
| `wire/keyboard.ts` | `onInput`, `type`, the selection and caret methods, `submit`, history — owns `editor`, `anchor`, `inputRows`, `history` | ~500 |
| `wire/mouse.ts` | `pointer`, `clicked`, `clickPanel`, `dragSplit`, `subjectOf`, `heldAgent`, `placeAt`, `ordered`/`selectedText`/`highlighted`, `Window` | ~600 |
| `wire/lanes.ts` | `laneScreen`, `reslice`, `laneRows`, `captureTerminal`, `watch`, `fitLane`, `paneSize`, `halves`, `openTerminal`, `openFind` — owns `paneView`, `terminalView`, `held`, `screen`, `splitScreen`, `terminalScreen`, `watching`, `fitted`, `findText` | ~550 |
| `wire/agents.ts` | start · open · close · remove · stop · name · harness · account · model · thinking · approvals — owns `opening`, `opened`, `naming`, `reopened`, `offersByTask`, `models`, `pickerModels`, `starting` | ~700 |
| `wire/orchestrator.ts` | `ask`, `say`, `tell`, `brief`, `show`, `reflect`, `thinkWith`, `onScreen`, `runCommand` — owns `thinker`, `sending`, `answering`, `speakingTurn`, `reflecting`, `borrowed` | ~450 |
| `wire/extensions.ts` | extension views, setup, watches, MCP servers, `heardByExtension`, `openListRow` — owns `setupShown`, `setupChoices`, `mcpShown`, `listSections`, `statuses`, `linkers`, `extensionShown`, `ranCount`, `asking`, `statusedAt` | ~700 |
| `wire/queue.ts` | `advanceQueue`, `doAdvanceQueue`, `queueTools`, `changeQueue`, `recordRulesMet` — owns `advancing`, `startingQueued`, `marking` | ~350 |
| `wire/schedules.ts` | `runSchedules`, `fire`, `lookWith`, `scheduleViews`, `onSchedule`, `ScheduleRequest`, `scheduleIdOf` — owns `scheduling`, `fired`, `lookingWith` | ~300 |
| `wire/files.ts` | open · save · diff · discard · reveal · branch switching · shell — owns `viewed`, `diff`, `branches`, `branchRows` | ~450 |
| `wire/search.ts` | `searchable`, `openSearch`, `searchEntries`, `lookInFiles`, `askWhatIsMeant`, `fromSearch` — owns `results`, `grepped`, `grepping`, `grepTimer`, `meant`, `asking*`, `searchFiles`, `terminalTexts` | ~350 |
| `wire/voice.ts` | `talkStart`, `talkStop`, `toggleMute`, `muteable`, `testMicrophone`, `spokenLine` — owns `voice`, `recording`, `metering` | ~200 |
| `wire/checks.ts` | `adoptChecks`, `runChecks`, `showCheck`, `reviewOf` — owns `runningChecks` | ~150 |
| `wire/machine.ts` | `lookAtWhatIsInstalled`, `updateAction`, `watchCommand`, accounts, `signInto` — owns `updates`, `updatesBusy`, `accounts`, `accountViews`, `credentials` | ~250 |
| `wire/settings.ts` | `openSettings`, `settingRows`, `saveSetting`, `saveKey`, `useConfig`, `configPath` | ~200 |
| `wire/images.ts` | `attachImages`, `giveImages`, `askWhereImagesGo`, clipboard, `handOff` — owns `clipboard` | ~180 |
| `wire/window.ts` | `remember`, `recall`, `layout`, `title`, `memoryFile`, room/size getters, `dateOf` — owns `remembered`, `restored`, `titled`, `titledAt` | ~250 |
| `wire/notes.ts` | `openNote`, `fromNoteMenu`, `forgetNote` | ~60 |

Dependencies: `app.ts` → `wire/*` → `wire/context.ts` → `frame.ts` → `model.ts`. No `wire/*` file
imports another; where two need the same thing it goes in `context.ts` or the subject that owns it
exposes it through `Wiring`. `wire/frame.ts` and `wire/actions.ts` know the `Subject` interface and
never a concrete subject.

**This is the `app.ts` invariant, stated so a test can check it:** `app.ts` imports `wire/*` and
nothing from `wire/*` imports `app.ts`. That is what "wiring only" means, made mechanical.

### 3.5 The tests

Split to mirror the source, no behaviour change:

- `test/app.test.ts` 2,776 → `test/wire/{boot,keyboard,mouse,agents,extensions,queue,files,voice}.test.ts`.
  Each needs the `FakeTerminal` + `screenOf` + `until` + `start()` harness, so that goes to
  `test/wire/harness.ts` first. **This also buys wall-clock**: 84 tests each booting a real
  workbench currently run in one forked worker; `pool: 'forks'` parallelises across files, so eight
  files run eight ways. This should make the suite faster, not slower.
- `test/screens/scenarios.ts` 3,333 → `scenarios/{agents,queue,schedules,extensions,settings,spend,files,search,panels}.ts`,
  each exporting an array; `scenarios.ts` becomes the concatenation. **Rewrites zero golden files** —
  `screens.test.ts` and `pictures.ts` both key on `scenario.name`, never on index or file. Worth
  saying out loud, because "the refactor that rewrote 200 goldens" is the thing to be afraid of
  here, and this one cannot.
- `test/view.test.ts`, `test/panels.test.ts` → alongside the modules they test.

### 3.6 Elsewhere in the repo

- **`packages/workbench/src/workbench.ts`**: move the five world-reading folds out —
  `lookAtCommits` (68), `lookAtChecks` (70), `reconcileSpend` (68), `lookAtWhatLanded`, and the
  keyed reconciliation in each — to `workbench/src/reconcile.ts`, where they can be tested as folds
  over a journal instead of through an open workbench. ~300 lines. **Leave the facade.** The other
  ~1,700 lines are the one object the CLI, the window and the orchestrator all call, average method
  19 lines, already delegating to eight split collaborators. Splitting a facade produces a facade
  plus files.
- **`packages/core/src/settings.ts`**: `settingsOf` is a 744-line table. Split by category into
  `settings/{agents,window,voice,queue,checks,telemetry,keys}.ts`, each exporting one
  `SettingGroup`, with `settingsOf` composing them. Mechanical; the payoff is that
  `.claude/skills/add-config-key` gets to say "add a row to *this* file".
- **`packages/extensions/jev/src/extension.ts`** (1,016-line literal) and
  **`packages/orchestrator/src/tools-extension.ts`** (692-line function): one file per tool,
  composed at the end. Also mechanical. Lower priority — these are declarations, and nobody is
  merge-conflicting over them.

## 4. What must not be broken

| Constraint | Where it bites | How to hold it |
|---|---|---|
| **99 golden screens × 2** (`.txt` layout, `.ansi` look) | any `view/` or `panels/` move | The goldens are the proof the move was behaviour-free. **A slice that rewrites a golden is a slice that did something else too** — revert and split it. Never `-u` during this work. |
| **Frame budget: `draw()` under 15ms**, every scenario (`screens.test.ts:28`) | `view/` split | Measured: 30 modules × 150 lines load 4ms slower than 1 × 4,500 (≈0.15ms per module), and nothing about the split adds work per frame. Keep `view/text.ts` helpers as plain functions, not methods. |
| **`scrollBy` under 0.5ms per notch** (`scroll.test.ts:161`) | nothing here touches it | — |
| **`pnpm test` under 30s, no network** | test splits | Splitting `app.test.ts` should *reduce* wall-clock (see §3.5). Never add a second `Workbench.open` per test where one `beforeEach` did. |
| **No build step** | every new file | `.ts` on every relative import, `import type` for types, no `enum`/`namespace`/constructor parameter properties — `erasableSyntaxOnly` is on, so `tsc` catches it. The subject classes must declare their fields then assign in the constructor. |
| **Pure stays pure** | `frame.ts`, `view/*`, `panels/*` | No `node:` import, no `Date.now()`, no `async` in any of them. All six pure files are clean today; §7 adds the test. |
| **Geometry contract**: `draw` returns exactly `height` rows of exactly `width` columns | `view/` split | Asserted per scenario already. Region files must keep returning `Drawn` with row-relative hits — **shift on append, never afterwards from a remembered offset.** |
| **Hits come from the drawing pass** | `view/`, `panels/` | Splitting must not introduce a second function that works out where something landed. |
| **`0600` on what Tade writes; secrets never drawn** | `wire/settings.ts`, `wire/machine.ts` | `saveKey` keeps going through `Secrets`; `writeSetting` keeps refusing secrets. |
| **`app.ts` is wiring** | the whole of §3.4 | The import test in §7. |
| **Four agents in one checkout** | every slice | See §5's note on ordering — this is the binding constraint on *when*, not *what*. |

One live find, and an argument for §7: `test/screens/__screens__/go-to-anything.{txt,ansi}` has no
scenario. A scenario was renamed and its goldens were left behind. Nothing notices, because nothing
checks that the goldens and the scenarios are in bijection. That is a four-line test.

## 5. The order of work

Every slice lands green alone and is revertable alone. Sizes are lines moved, not written — almost
none of this is new code.

**The scheduling constraint comes first.** `app.ts` was touched in 92 of the last 200 commits, and
25 task folders are open in this shared checkout right now. A slice that moves 5,000 lines of
`app.ts` will conflict with every agent holding an edit to it. So: **each slice is one sitting, one
commit, and the big ones need the file quiet.** Announce it, land it, move on. The order below is
also cheapest-first for exactly this reason — the early slices touch files with lower churn.

| # | Slice | Moves | Risk | Why here |
|---|---|---:|---|---|
| **0** | **`frame.ts`** — lift the data contract out of `view.ts`. Repoint `live.ts`, `panel-view.ts`, `panels.ts`, `app.ts`. | ~200 | very low | **Do this first.** Types only, zero runtime change, no golden can move. It kills the `view`↔`panel-view` cycle and the `live`→`view` edge, which every later slice would otherwise have to work around. One afternoon, and it is the smallest thing that makes the architecture legible. |
| 1 | **The modularity test and the budget table** (§7), set to today's numbers. | ~150 new | none | Before any file moves, so every slice after it has a number that must go down. A ratchet installed after the refactor protects nothing that happened before it. |
| 2 | `view/text.ts` + `view/rows.ts` — the shared helpers only. | ~450 | low | Unblocks every region file. Pure functions with pure callers; goldens prove it. |
| 3 | `view/` regions, **one per commit**: `top` → `foot` → `strip` → `schedule` → `plan` → `actions` → `queue` → `main` → `sidebar`. | ~4,000 | low | Nine commits. Smallest first so the pattern is settled before `renderSidebar` (238) and `renderMain` (317). `view.ts` ends at ~250 lines. |
| 4 | `test/screens/scenarios/` split. | ~3,300 | very low | Rewrites no goldens (§3.5). Pure data movement; do it while §3 is fresh so new scenarios land in the right file. |
| 5 | `panels/context.ts`, then one panel folder per commit: `small` → `search` → `models` → `menu` → `project` → `file` → `spend` → `extensions` → `settings`. | ~6,500 | low-med | Nine commits. Both halves of each panel are pure, so each commit is two files out of two files. Settings and Extensions last — they are the biggest and the most contended. |
| 6 | `test/wire/harness.ts` + split `app.test.ts` by subject. | ~2,800 | low | **Before** touching `app.ts`. The tests that will prove slices 7–9 have to exist in a shape that maps onto them first. |
| 7 | `wire/context.ts` + the **leaf** subjects, one per commit: `notes` → `checks` → `voice` → `images` → `settings` → `machine` → `window` → `search` → `schedules` → `queue`. | ~2,400 | **medium** | Ten commits, smallest first. Each is a class over `Wiring`, its own fields moved in, `App` keeping a one-line delegation. `facts()`/`panel()`/`inputs()` still called by hand from the old hubs — **inverting the hubs is slice 9, not this one.** |
| 8 | `wire/keyboard.ts`, `wire/mouse.ts`, `wire/lanes.ts`, `wire/files.ts`, `wire/agents.ts`, `wire/orchestrator.ts`, `wire/extensions.ts`. | ~3,900 | **medium-high** | Seven commits, the contended core. `keyboard` and `mouse` carry routing order as behaviour — read `onInput` top to bottom before moving a line of it, and lean on `test/wire/keyboard.test.ts` from slice 6. |
| 9 | **Invert the hubs**: `wire/frame.ts` folds `facts()`/`panel()`/`inputs()` over the subject list; `wire/actions.ts` builds `run` as a prefix table. Delete `frameFor`, `panelFacts`, `panelInputs`, `menuItemsFor`, the `run` if-chain. | ~1,100 | **high** | **Last, and deliberately.** This is the only slice with real design in it, and it is far easier once the twenty subjects already exist and already expose their slices by hand. Doing it first would mean designing the fold against twenty things that are still tangled. |
| 10 | Elsewhere: `workbench/reconcile.ts`, `core/settings/` by category. | ~1,050 | low | Independent of everything above; can be picked up by anyone at any point. |

Roughly 44 commits, of which 38 are mechanical. **Nothing after slice 1 is required** — stopping
after slice 5 leaves the drawing and the panels fixed and `app.ts` untouched, which is already most
of the merge-conflict pain gone, and the budget table in slice 1 keeps the ground won.

If only one slice ever happens, it is **slice 0** — it is two hours, it cannot break a golden, and
it turns a cyclic module graph into a layered one.

## 6. What to leave alone

- **`model.ts` (1,855).** ~90 pure functions, largest 80 lines, 155 lines of it the `AppState`
  interface, 69 tests beside it. Long is not the same as tangled. Splitting the queue functions out
  (`queueTree`, `queueRows`, `chainOf`, `planOf`, `shownBy`, `holdOf` — ~350 lines) is *defensible*
  because the queue is its own subject with its own view file, and it is the only part of this file
  I would ever touch. Everything else: leave it.
- **`Workbench`'s facade (~1,700 of 2,057 lines).** It exists so the CLI, the window and the
  orchestrator have one object. The one-line delegations are the point.
- **Both harness adapters (1,629 + 1,537).** One class each implementing one port, with a shared
  conformance suite proving they agree. This is what R1–R4 asked for and got. The duplication is
  real but tiny — `shellWord`, `modelName`, `toolName`, `promptWithImages` are byte-identical
  across Claude and Codex, 25 lines in total, and `runSocket`/`effortOf`/`firstWords`/
  `describeToolCall` only look similar. Hoisting 25 lines into `harnesses/core` would put shared
  code between two implementations of a port so that a change for one harness becomes a change to
  both. Not worth it.
- **`ExtensionHost` (927-line class).** It is the one thing that runs untrusted code with a timeout
  on every call, and every timeout, `AbortSignal` and `notReady` path is tested in
  `host.test.ts` (904 lines). The safety argument for keeping it readable in one place beats the
  size argument for splitting it.
- **`Live` (830-line class).** Fifteen TTL caches and one `doRefresh`. Its four folds are already
  extracted and already tested. If it bothers anyone, the answer is a six-line `cached(ttl, fn)`
  helper, not eight files.
- **`live.ts`'s polling, `deriveState`, `runtimeFrom`, `spendFrom`, `readyToStart`, `speakable`,
  `layoutPlan`, every port and every conformance suite.** These are the seams working. Nothing here
  goes near them.
- **The big declarations, except where §3.6 names them.** `reviewExtension` (850-line literal),
  `sentryExtension`, `CATALOGUE`: flat, independent, low-churn. Splitting them is cost with no
  named benefit.

Said plainly: of the 30,315 lines in the eight biggest files, about **25,000 move into smaller
files and about 5,000 stay exactly where they are** — and those 5,000 include two files a line
count alone would have condemned, `model.ts` entire and `workbench.ts` but for 300 lines. Beyond
the top eight, another ~6,000 lines across the harness adapters, `ExtensionHost`, `Live` and the
extension literals are in the leave-alone column for reasons that have nothing to do with their
size.

## 7. How it stays modular

The refactor is the easy half. Nothing above explains why `app.ts` reached 8,295 lines *given that
the skill already said it should be wiring only* — and the answer is that the rule was prose, and
prose does not fail a build. Four things, in the order they pay off:

### A. `test/modularity.test.ts` — a budget table that may only go down

In `test:smoke`, beside `lint-rules.test.ts` and `source.test.ts` where the repo already keeps its
rules about itself. One table, checked in:

```ts
// What each file is allowed to be. A number here may go DOWN in the commit that
// earns it, and never up. Adding a file to this table is how a file gets big;
// doing that in review is the conversation this test exists to force.
const BUDGET: Record<string, number> = {
  'packages/app/src/app.ts': 8_300,
  'packages/app/src/view.ts': 4_500,
  // …
}
const DEFAULT = 800   // anything not named
```

It asserts three things:

1. every `.ts` file under `packages/` is within its budget, or under `DEFAULT` if unnamed;
2. no file **exceeds** its budget — the failure says which file, by how much, and *"split it, or
   lower a number somewhere else and say why"*;
3. no file is more than 150 lines **under** its budget — the ratchet. This is the half that makes
   it work: without it the numbers stay at 2026 levels forever and the table becomes decoration.

`DEFAULT = 800` is the real rule. `app.ts` grew because there was no moment at which adding a
method to it was visibly a decision. With this, the 40th subject added to the window has to either
be a new file or an argued-for number.

### B. Two import rules, as tests in the same file

- **`app.ts` imports `wire/*`; no `wire/*` imports `app.ts`.** This is "`app.ts` is wiring only"
  made mechanical, and it is the single check that would have prevented all of this.
- **Pure files stay pure.** `frame.ts`, `model.ts`, `view.ts`, `view/*`, `panels.ts`, `panels/*`,
  `spend.ts`, `plan-graph.ts`, `scrollbar.ts`, `hits.ts`, `ui.ts`, `skin.ts`, `layout.ts`,
  `scroll.ts` may not contain `from 'node:`, `Date.now()`, `new Date()`, or `async`. All of them
  pass today — this pins a property the repo already has and nothing currently defends.

Both are string checks over `git ls-files`, like `source.test.ts`. Milliseconds.

### C. `screens.test.ts`: goldens and scenarios in bijection

Four lines, and it would have caught `go-to-anything` (§4). A golden with no scenario is dead
weight nobody will dare delete later; a scenario with no golden is a screen nobody is checking.

### D. The skill, brought back into line

`.claude/skills/change-the-window` is right about everything except where the files are. After each
slice, update its table in the same commit — a skill describing a layout the code no longer has is
worse than no skill, because agents follow it.

Three things to add to it:

- **The file table gains `view/`, `panels/<name>/` and `wire/`**, with the rule for each: *a new
  region of the screen is a file in `view/`; a new panel is a folder in `panels/`; a new subject
  the window wires up is a file in `wire/`, and `app.ts` gains one line.*
- **Two steps in "Steps"**: *"If it needs a private field, the field belongs to the subject in
  `wire/`, not to `App`"* and *"If it contributes to the frame, add `facts()` to that subject —
  never a new branch in `wire/frame.ts`."*
- **A `add-a-panel` recipe** (or a section here): the panel's folder, its two files, its entry in
  the `Panel` union and the two dispatch tables, its `PanelContext` slice, its scenario, and the
  app test that opens it through the whole window. That last one because the skill already warns
  that the Spend panel, the task menu and Settings each once shipped opening empty — the scenario
  tests build frames by hand and pass while the real window hands the panel nothing. A per-panel
  folder makes forgetting a slice *more* likely, not less, so the recipe has to close that.

### The honest limit

None of this stops somebody putting a rule in `wire/agents.ts` that belonged in `model.ts`. A line
count cannot tell logic from wiring. What it does is make the *moment* visible: a file crossing 800
lines is a conversation, and `app.ts` reaching 8,295 was never once a conversation. That is enough,
and anything stronger would be guessing at what the next feature needs.
