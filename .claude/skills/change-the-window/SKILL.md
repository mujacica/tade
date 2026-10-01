---
name: change-the-window
description: Change what `tade app` shows, or which keys it claims — panes, the projects list, the orchestrator strip, the line you type on, panels, focus rules, scrolling and the wheel, selecting and copying text, a lane that draws its own screen, the drawing of the queue and a plan, and search. Use for any change to the window's behaviour or layout, and when something on screen scrolls, selects, clicks, folds, remembers or gives up room wrongly.
---

# Changing the window

`packages/app` is the window. It is deliberately split into small files, and the split is the point:

| File | Holds | Testable without |
|---|---|---|
| `model.ts` | What is shown, as data: panes, projects, focus, key meanings | a terminal |
| `layout.ts` | How the window is divided, and where you were in each project when you closed it (`Spot`, `whereYouWere`, `standingIn`, `worthKeeping`) | a terminal |
| `keys.ts` | Which keystrokes the window claims and what it calls them | a terminal |
| `split.ts` | A pane cut in two: which lane the second half draws, which half types | a terminal |
| `frame.ts` | `Frame`: the shape of what the window is handed to draw, and nothing else | — (types only) |
| `view.ts` | `draw(state, frame) → { rows, hits }`, one row per line: the composition, and nothing else | a terminal |
| `view/` | One file per region — `top`, `sidebar`, `main`, `queue`, `plan`, `schedule`, `actions`, `strip`, `foot` — over four shared ones: `text` (width, words, moments, numbers), `rows` (a tab, a section, a scrollbar, a mark's tone), `list` (a row an extension keeps, in two rows: the side and the ACTIONS page both draw one) and `lane`/`split`, which two regions each reach for | a terminal |
| `ui.ts` | `Row` (controls that know where they are clickable), `box`, `overlay` | a terminal |
| `hits.ts` | What is where on the screen, so a click can mean something (`scrollAt`, `extentOf`, `selectableText`) | a terminal |
| `pointer.ts` | What a press, a drag, a release and a notch mean at the cell they landed on | a terminal |
| `scroll.ts` | What a notch is worth (`Wheel`, the ramp), how far a region reaches (`reachOf`), and the lines a lane's screen is cut out of (`HeldLines`, `cutFrom`, `keeping`) | a terminal |
| `scrollbar.ts` | The bar down the right of anything that scrolls, and the one along the bottom of anything wider than its pane (`barAcross`) | a terminal |
| `selection.ts` | `Region`: what a drawing says it drew, so a selection is anchored in lines and not in rows (`cellsIn`, `spanText`) | a terminal |
| `input.ts` | What is selected in the line you type on and in the file you have open — one model for both (`spanOf`, `wordAt`, `clickedSpan`, `putCaret`, `cutSpan`, `rowStarts`) | a terminal |
| `skin.ts` | The 256-colour palette and every control's look, plain and painted | a terminal |
| `panels.ts` | The `Panel` union, `PanelInputs`, and the two dispatches — `panelKey` and `panelClick` — and nothing else | a terminal |
| `panels/` | One folder per panel, its state and its drawing side by side: `settings`, `extensions`, `file`, `project`, `spend`, `menu`, `models`, `search`, `summary` (one row of a list, in full), and `small` for the ten that are one question each. Over four shared ones: `context` (`PanelContext`, `drawPanel`), `frame` (`panelSize`, `column`, `beside`, `bar`, `rowLook`, `searchRow` — the shell every panel is drawn in), `cells` (`cap`, `pad`, `wrapTo`, the text every panel is built from) and `outcome` (`PanelOutcome`, what a press does) | a terminal |
| `spend.ts` | What the Spend panel shows, from `usage` events, and which window a day is (`sinceOf`) | a terminal |
| `queue-view.ts` | What the SMART QUEUE shows (`QueueView`, `shownBy`) and nothing about what is in it | a terminal |
| `queue.ts` | What the queue says in words, including what an empty list says (`queueEmptySays`) | a terminal |
| `plan-graph.ts` | A plan as boxes and lines: a column per step of the resolved tree (`drawPlan`, `treeStems`, `drawWhy`) | a terminal |
| `projects.ts` | Recent projects, folder listing, `git init` for Open project | a real disk and git |
| `files.ts` | The FILES tree: order, what is hidden, which folders are open | a disk (it takes a lister) |
| `search.ts` | Search: reading a query, fuzzy matching, grouping results, tab completion, and the shortlist put to whoever reads a sentence | a disk or git |
| `finder.ts` | What search looks through: `git ls-files` and `git grep`, and parsing both | — (a real repo) |
| `happening.ts` | What is happening about each thing search can go to (`happeningOn`, `happeningIn`) | a terminal |
| `highlight.ts` | Code coloured in 256 colours from highlight.js, line by line | a terminal |
| `viewer.ts` | Reading a file to show (size cap, binary), Markdown laid out, finding in it and typing into it | a terminal (not a disk) |
| `editor.ts` | Which editor opens a file, with what arguments; what on screen is a link | a terminal |
| `diff.ts` | A unified diff as drawable lines | a terminal |
| `router.ts` | Whether a keystroke is for the agent or for Tade | a terminal |
| `transcript.ts` | The conversation with the orchestrator as entries, folded from what it does | a terminal |
| `transcript-view.ts` | That conversation laid out to a width: wrapped, formatted, spinning | a terminal |
| `images.ts` | Pictures: recognising a dropped path, reading the clipboard, reading bytes | a terminal |
| `links.ts` | A row of someone else's text with its links and file references clickable | a terminal |
| `live.ts` | Where the facts come from: status, lanes, approvals, the journal | a workbench (the fold is pure) |
| `wire/` | One file per subject the window wires up — `agents`, `routes`, `lanes`, `keyboard`, `mouse`, `files`, `orchestrator`, `extensions`, `queue`, `schedules`, `search`, `settings`, `machine`, `projects`, `spend`, `checks`, `voice`, `images`, `notes`, `window` — each a small class over `context.ts`'s `Wiring` (the options, the state, `live`, the clock, the repaint), owning its own fields and taking what it needs of other subjects as named dependencies | a terminal, mostly |
| `wire/context.ts` | What a subject may reach (`Wiring`), and what it offers back (`Subject`: `facts`, `panel`, `inputs`, `actions`, `menus`, `submits`, `prompts`) | — |
| `wire/frame.ts` | `frameOf` — the frame, folded out of the subjects that own each piece of it; `panelInputsOf` beside it | — |
| `wire/actions.ts` | `Router`: a button's name, a menu's kind, a panel's answer and a slash command, each looked up in the table the subjects fill in | a terminal |
| `pace.ts` | How often the window looks, and how soon after a lane prints it looks again | — |
| `title.ts` | What the terminal window calls itself | — |
| `inbox.ts` | What Tade tells the orchestrator without being asked, and where you are when you ask (`whereYouAre`) | — |
| `settings.ts` | Reading and writing a setting from the window, through core's one writer | a real disk |
| `app.ts` | Wiring only: pi-tui, the voice surface, the workbench, and the list of subjects | — |
| `screen.ts` | The screen Tade asks you things on: setup, settings, any command that needs a form | a terminal (rendering is pure) |

**Work happens in the window.** A command that does something — start, stop or open an agent — takes
the rest of the line as what it is for (`/new fix the double charge`) and acts,
leaving you looking at the result. It must not throw the screen away for a form: that is a strange
thing for a window whose whole job is showing you what is running. Only the two commands that edit
configuration borrow the terminal: `App.onScreen` stops the window, runs a `runScreen` flow, and
starts it again — because two things drawing at once is the bug this design exists to avoid.
Anything that goes wrong in there is shown *on that screen* and waited on (`ui.pause`): a window that
redraws over the explanation is a window that ate it.

**The window opens before anything slow does.** The orchestrator is a model in another process; it is
started after `App.start` and handed over with `attachThinker`. Never make the first frame wait on
something that talks to a network.

Put behaviour in `model.ts` and drawing in `view/`. If `app.ts` grows a rule, it is in the wrong
file and cannot be tested.

**A region's file is a leaf, and `view.ts` is the only thing that composes them.** A helper one
region uses lives in that region's file; one two regions reach for goes to `view/text.ts`,
`view/rows.ts`, `view/lane.ts` or `view/split.ts`, never left where the first of the two happened
to need it — that is how the drawing became one 4,185-line file, and it is what would put two
regions in a cycle now.

## Conventions

- **The geometry contract.** `draw` returns exactly `height` rows, each exactly `width` visible
  columns. A row that is off by one corrupts the whole screen, so every view test asserts it with
  `visibleWidth` at several window sizes, tiny ones included.
- **Measure with `visibleWidth` / `truncateToWidth`** from pi-tui, never `String.length`: lane
  screens carry ANSI, and `length` counts escape bytes as characters.
- **Tail, don't clip.** A pi-tui stack allocates height and then cuts children off *at the bottom*,
  which would show the top of an agent's screen and hide its newest output. The window composes its
  own rows and keeps the last N itself. Do the same for anything that grows.
- **Claim as few keys as possible.** Whatever the window does not claim is typed straight into the
  focused agent, so its own keybindings keep working. **Never claim a printable character** — that
  is why push-to-talk is `ctrl+space` and not `space`: you have to be able to type a space.
- **Key names are decided in `keys.ts`, meanings in `model.ts`.** `appKey(data, ctx)` turns bytes
  into a name; `keyAction(key, state)` decides what it means. Keeping them apart is what lets talk be
  hold-to-talk on one terminal and a toggle on another without the model knowing.
- **Hold-to-talk needs key releases**, which only some terminals report. Check
  `terminal.kittyProtocolActive` and degrade to a toggle; never assume releases arrive.
- **`addInputListener` runs before the focused component**, and returning `{ consume: true }` stops
  the keystroke there. Returning `undefined` lets it through to the agent — that is the default.
- **Nothing steals the screen while you are typing.** A pane may raise itself only for a `blocking`
  event, and only after `FOCUS_GUARD_MS` of no input. Route new auto-focus rules through
  `shouldRaise` rather than adding a second path.
- **Focus survives a refresh.** Status is polled constantly; `withTasks` keeps your place and only
  moves focus when the task is gone.
- **A project is a place you come back to, so where you were in it is remembered per project.**
  Clicking an agent, going to another project and coming back put you at the top of the list, which is
  somebody else's idea of where you were — the selection was one *window's* where it is one *project's*.
  So a `Spot` (`layout.ts`) is the agent in front and the tab below it, kept by project in `spots`. The
  agent goes to `window.json` with the rest of the view, because coming back to it tomorrow is the same
  courtesy as a second later; the tab does not, and `worthKeeping` is where that is decided — a terminal
  is a lane of the window's own, and under a driver whose lanes cannot outlive it (`detach: false`, which
  the default `pty` is) closing Tade ends it, so a tab written down is one nothing could ever go back to.
  Two doors and one rule: `whereYouWere` folds in the project you are standing in, since that spot is the
  focus and the tab themselves and is kept nowhere else — read wherever a project is left, its tab
  (`selectProject`), tabbing out of it (`focusBy`), the beat every state passes through (`withTasks`),
  which is what catches a jump that went through neither door, and the write on the way out of the
  window. `standingIn` is the other, and everything it cannot find falls back the way the window fell
  back before any of this, which is what stops a remembered place ever being worse than no memory: an
  agent that finished, was stopped or went with its task, and a plan or schedule that stays behind in the
  project it is of, all come back to the first agent, exactly as a project nobody has been in opens on
  it — only one with no agents at all comes back to the orchestrator. Arriving is `focusTask`, so coming
  back to an agent is the same act as clicking it. **The tab below had the same bug from the other side**,
  and it was the worse one: the panel went on showing the terminal of the project you came *from*, under a
  row of this project's tabs with none of them lit.
- **Rows and hits come from one pass.** `draw` returns both. A second function working out where
  things ended up is a second layout to keep in step, and the first symptom of it drifting is a
  button that does what the one above it says. `chips()` lays a row of tabs or buttons out and
  reports where each landed; positions are computed from the labels, so painting cannot move them.
- **Every clickable thing is something you could have typed.** A click resolves to a `Target` and
  ends up in the same `act()` / `focusTask` path as the keyboard. The mouse is a shortcut into the
  commands, never a second way of driving Tade.
- **Colour is decoration.** Every row must read correctly without it: `skinFor` returns the identity
  functions for `NO_COLOR`, a dumb terminal or a pipe, and tests render with the plain skin.
- **What an agent is doing is one rule: `markOf`.** Seven marks — working (a spinner), idle, needs
  you, failed, done, not running, parked — each its own shape from `glyph`, its colour from
  `MARK_TONES`. Draw an agent's state anywhere through those; a second mapping from state to colour
  is how every agent once wore the same dot. Whether an agent's turn is running comes from what it
  said (`turn_started`, `idle`), never from its lane, whose screen changes either way.
- **Work you start for someone is shown in the conversation.** An extension's action, the brief, a
  failure of the orchestrator: add it to `state.transcript` (`ran`, `said`, `suggest`, `problem` in
  `transcript.ts`) rather than as a `notice`, which the next notice overwrites and which has no room
  for the reason.
- **Every exchange shows its reasoning** (`→ verb · task · "why"`). A wrong guess must be visible and
  correctable, never silently obeyed.
- **A surface is options and values; the explanation lives where somebody asks for it.** Every drawn
  surface — a settings group, a sidebar section, a panel, a footer — is a heading and then controls,
  and no paragraph. A control whose name says what it is gets no sentence under it; where the
  *consequence* is not guessable from the name, one short line, and only for the thing you are on. A
  caveat true under *every* row of a page is a mark or a clause (`~`, `over 3 runs`, `on this
  machine, not CI's matrix`), never a footnote read four hundred times. Cutting a line from the
  drawing does not cut it from the program: a setting's `means` is still what the search box matches
  on and what `tade config` prints, `runtimeSays` still says the whole of it in `tade spend`, a
  group's `about` is still searchable, and the panel that asks before an act is still where that
  act's cost is spelled out. So the test of a line is not whether it is true — they were all true —
  but whether *this* is the surface somebody would be reading it on.
- **Nothing the window runs waits on a child process.** It draws four times a second and answers keys
  in between, on one thread: a program it waits on stops both, and no key ends that wait. Saving a
  key used to be `execFileSync('security', …)`, read again on *every frame* while the page was open,
  so a keychain that wanted a word about it stopped the whole window and the only way out was killing
  Tade. Everything in the packages the window loads spawns asynchronously and every wait has a
  deadline — including the one nobody thinks of as a wait, an extension's `ready()`, which is somebody
  else's code awaited from the Settings page and which the host holds to one with `inTime`
  (`extensions/core/src/host.ts`). A standalone script the window never imports is its own process and
  may be simple; it is named in `test/modularity.test.ts`, which holds the rest to it.
- **What the window polls is cheap and shared.** One `ps` for the whole process table, cached between
  askers; anything on a timer or drawn every frame has a performance test. If a change makes a frame
  slow, cache what it formats (as the transcript and the file viewer do) rather than raising the
  number the test holds.

## Scrolling, and what a notch is worth

- **Everything that scrolls scrolls the same way.** One move (`scrollBy` in `model.ts`) and one setter
  (`atOffset`, the other half of `model.ts`'s `offsetOf`): the wheel, a key and a drag on the bar each work out the
  offset they mean and land there, so none of them can disagree about where the end is. Seven surfaces
  with five ideas of the end is what "not smooth" was — three of them counted on past the last line
  there was, so a flick off the end bought a handful of notches that did nothing on the way back. A
  region that goes through those two answers all three the day it is added; one that keeps an index of
  its own answers one of them.
- **Nothing lays a region out again to answer a notch.** How far a region goes is read off its own bar:
  the `scrollbar` hit already carries `total` and `shown` because a drag needs them (`reachOf`).
  Counting a conversation instead cost two milliseconds a notch.
- **How much is in view is the rows the region drew, never the room it was given.** A pane is the one
  place the two differ — an approval card sits at the bottom of the agent's own screen and takes five
  rows off it (`rowsRead` and `carded` in `view/lane.ts`, read by the drawing *and* by the look). Sized
  from the pane instead, a screen with more lines in it than fit reported everything in view and
  answered the wheel with nothing at all, and only while the agent was waiting on you — which is what
  made it look intermittent.
- **What a notch is worth is a ramp, never a step** (`scroll.ts`). A terminal reports a notch and never
  says whether the hand is on a wheel or a trackpad, so the rate is read. A step put the line at
  `RUN_MS`, so an ordinary mouse wheel fell on the trackpad side of it and moved one row a detent while
  the same wheel turned slowly moved three: four notches of one even turn came out `3, 1, 1, 1`.
  Between `DRAG_MS` (a finger travelling) and `RUN_MS` (a detent on its own) it slides, and what
  rounding leaves over is carried to the next notch (`Wheel`), so a run of them is even and adds up to
  exactly what the hand asked for. A terminal grid moves by whole cells and that is the ceiling: even,
  in step and predictable, never sub-cell.
- **The wheel is swallowed wherever it lands, scrollable or not.** Tade draws exactly one screen and
  never scrolls one, so a notch handed back is the terminal library moving a viewport of its own,
  which is the window sliding under you.

## Selecting text

- **A selection is bounded to the region it was started in.** The window is regions side by side, not
  one flow of text, so a selection that took whole rows between its two ends took whatever else was
  drawn on them: dragging over an agent came back with the sidebar's queue and its agents down the
  left of every line but the first and the last. Which columns those are is read off the map
  (`scrollAt`, then `extentOf` across), like everything else about where something ended up.
- **And it is anchored in the region's lines, never in the rows it was made on.** A region scrolls, so
  an offset into the rows on screen means nothing the moment those rows go — which is what "selecting
  over more than a page does not work" was: press, scroll, and the selection was made of cells that no
  longer pointed at anything. So the drawing declares what it drew (`Drawn.regions`, a `Region` in
  `selection.ts`: the region's own lines, which of them landed on its first row, and which rows those
  are), for the same reason it declares the hits. The ends are lines of that region, projected back
  onto whatever is drawn now (`cellsIn`), an end that has scrolled out of view taken at the edge it
  went past; and what is copied comes out of the lines rather than off the screen (`spanText`), so it
  is the whole span and not the part still visible.
- **Three regions have one** — the conversation, the agent's screen and the terminal. The
  conversation's lines are its own; a lane's are the scrollback the window is holding (`Frame.held`),
  which is honest about the limit: **as far back as Tade has read, and no further.** Everywhere else —
  the side, a panel, the ACTIONS page — a selection is still the rows it was made on, because none of
  those is a thing people drag over pages of.
- **The far end of a *live* drag is deliberately not anchored.** It follows the pointer, so content
  moving under a hand that is holding still is what **extends** the selection — which is what makes the
  wheel during a drag, and the scroll at an edge (`drag-region`, on a timer like the file's), do what a
  terminal does. It is fixed where the drag is let go, so nothing slides afterwards.
- **A link is a control and text, and which it was is only knowable on the way up.** Everything else a
  click presses is something the window drew; a link or a file reference is a *reading* of somebody
  else's words (`selectableText`), so a press on one starts a selection like a press on the words
  around it, and only a press that never moved opens it — a line with a URL in it was otherwise a line
  no selection could be started at. `www.` counts as a link and is opened over https, which is also
  what stops the path pattern claiming it as a file nobody has; a bare `example.com` does not, because
  nothing tells it from `report.md`. Where it opens is the one seam that reaches the machine
  (`AppOptions.open`), so a test is handed an opener that records the command instead of running it.
- **The line you type on and the file you have open select out of one model, because two would drift.**
  A word is the same run of letters in a file as on the line, shift and an arrow reach the same way,
  and what a second press takes is not something anybody should have to learn twice — so `input.ts`
  answers for both (`spanOf`, `wordAt`, `clickedSpan`, `lineKey`, and its own `offsetOf`/`placeOf` into
  the text) and only who is pressed
  on behalf of differs. At pi's editor every change is made by **pressing the keys a person would
  press** (`putCaret`, `cutSpan`), never by reaching into the editor's state: slower, and right about
  everything reaching in would have to be taught — a grapheme of four code points, a paste collapsed to
  one marker, a line that wraps. The drawing is the editor's too; the selection is laid over the rows
  it drew, placed in the text by matching them (`rowStarts`), because a second description of how it
  wraps would be right until the day it was not.
- **The viewer's `Edited` is Tade's own, so the press it needs lives in it** (`cutSelection`, beside
  `back` and `joinUp`): a selection taken out is one operation, not one press per character, because
  the presses copy the file's lines and four thousand of them was six hundred milliseconds. A test
  holds it to what those presses say, case for case, so the two can never differ about what one press
  takes. Only the anchor is kept (`FilePanel.anchor`) — the other end is the caret the edit already
  holds, so the two can never disagree about where the selection reaches — and it is laid over what the
  viewer drew, in its cells (`onLine`, `laidOver`), never in a second reading of how the body slid.

## Lanes that draw their own screen

A program on the alternate screen — Claude Code, an editor a shell was pointed at — keeps no
scrollback for anybody else to move, and draws its own controls where nothing in a capture says which
cell is one. Both facts are **declared by the driver, per lane**, never guessed from what was launched:
a shell with `vim` open in it is the same situation as an agent that draws its own conversation.

- **Whose the scrolling is, is `LaneScreen.scrolling`** — `window`, `lane`, `nobody`. `lane` means the
  program also asked for the mouse, so the notch goes to it (`wheel` on the driver, behind
  `capabilities.pointer`) and it scrolls its own conversation; `nobody` means it took the screen and
  wants no mouse, and then nothing moves, honestly. Before this, turning the wheel over one did nothing
  at all and drew a bar with no thumb. The bytes are the program's own encoding and never a guess
  (`wheelBytes`, `drivers/core/src/wheel.ts`): a report in the wrong one is not a scroll that misses,
  it is characters typed into it.
- **Such a lane gets a mark down its side rather than a bar.** A bar is drawn from three numbers — how
  much there is, how much is in view, where in it you are — and the window has none of them. Drawn as
  one anyway, `lines` is the height of the screen and the screen is what is in view, so it came out an
  empty track that looks exactly like a bar that is broken; with an approval card over the pane the two
  differed by five rows and a thumb appeared, saying something true about the capture and nothing about
  where the program is in its conversation. So `gutterBeside` (`view/rows.ts`) reads
  `LaneScreen.scrolling` and draws the column from it: the bar where the scrolling is the window's, a
  dashed rule the whole height (`skin.scrollElsewhere`) where it is the lane's — never a thumb, because
  a thumb is never the whole track — and the plain track where it is nobody's. Neither mark is ever
  given a hit, so neither lights and neither can be dragged, and `reachOf` finds nowhere to go, which
  is what keeps the keys honest too: a handle that moves nothing is worse than no handle.
- **Tade keeps the cells it drew and the lane gets the cells it drew.** The only way to press the close
  on Claude Code's files-changed panel is for the bytes to reach the program — but then Tade cannot
  also use those cells for click-to-focus, drag-to-select and its reading of the paths in the text, and
  a click that goes to the wrong one feels broken in both directions. What Tade drew is the header, the
  column down the side, the approval card, the divider, the tabs; what the lane drew is its screen,
  `place` and `link` included. So on such a lane Tade's own recognition of a path *steps aside* rather
  than winning the cell (`laneLines` in `view/main.ts` is handed `null` for its linkers, which is not
  `[]`): a path that lights up under the pointer and then hands the click to the program is a worse lie
  than not offering it. A pane that has not got the keyboard still answers a click the way it always
  has, by taking it — which is what makes sure one click always lands in Tade and nobody can be shut
  out of their own window.
- **Two declared facts and no guess.** It has to have taken the screen (`LaneScreen.scrolling`),
  because only then are the rows the window drew the rows the program thinks it has; and it has to have
  asked for the mouse (`LaneScreen.pointing` — `nobody`, `press`, `drag`), which is apart from
  `scrolling` because one lane answers the two differently. `drag` is what decides **how you select**:
  a program that asked about movement selects for itself and copies the way it copies, and one that
  asked only about presses keeps Tade's drag — which is why the level is a level and not a flag. A
  program that asked to be told about movement with no button held is `drag` too; the window never
  sends that, because the pointer crosses a pane far faster than the window draws and its own hover is
  made of those same moves.
- **`pointedIn` and `screenRows`** (`view/lane.ts`, beside `rowsRead`) are the one reading of all of
  it, because the rows a region draws are not the rows the program has: a lane is made the size of its
  pane and then read back in what is left, so under an approval card drawn row 0 is row five of the
  lane, and a press told otherwise lands five rows above what was pressed. Nothing is remembered about
  what the program did with it; what it draws in answer is read on the next look, as the wheel's is.
- **A lane's screen is read once and cut, not read again per notch.** A capture costs what it asks for,
  so reading `rows + scroll` lines back on every look cost a millisecond per two hundred lines
  scrolled, four times a second, for lines that had not changed since the agent printed them.
  Scrollback above the live screen cannot change — an agent appends, it never rewrites — so the lines
  are held with how deep the lane was when they were read (`HeldLines`) and the screen is cut out of
  them (`cutFrom`); only the bottom is asked for again. That is also what puts the text and the bar
  beside it on the same frame: the wheel cuts, where it used to move a number and leave the text until
  the next look. **A cut that reached is the whole answer** — what a notch changed is where the window
  is looking, not what the lane holds, so there is nothing to ask the driver at all (`reslice` says
  whether it reached; only false asks for a look). Asking anyway cost a screen read a notch in every
  lane in front of you: 81 ms of a 735 ms flick spent being told that nothing had changed.
- **Lines are only held where the scrolling is the window's** (`keeping`), because that is the only
  place the fact they rest on is true. A program on the alternate screen repaints every row in place
  and never gets any deeper, so the depth the held lines are keyed by never moves: every look found the
  lines it already had, and the pane froze on the first screen it ever read. That is what "the Claude
  pane does not scroll" was once the notch was reaching the program — it scrolled, and the window went
  on drawing a photograph of it. Nothing is lost by not holding them: such a lane has no scrollback to
  ask for, so a capture is one screen.

## Controls and panels

- **Colour means something, or it is grey.** The footer keeps only Extensions, Settings, Mute and
  the anti-sleep hold, grey unless something wants you (amber: an extension to set up; red: sound
  to cut off, or sleep being held off right now). What each one says and wears is one function
  (`labelled`, `view/foot.ts`) — a label and a colour decided in two places say two things — and
  the rule it applies is that **the colour is what pressing it does**. `go`, the green half of the
  pair, is the press the window would *like* next: mute's way back is one, and an anti-sleep hold
  is not, so it sits grey until it is held and red while it is. Starting an agent and opening a
  project have their `+` where agents and projects are; search's key sits by the talk key. Don't
  colour a button for identity.
- **A voice says words, and only the front of them.** Everything the window speaks goes through
  `speakable` (`core/src/speech.ts`) first: a code fence waits for its other half and is then dropped, a
  path is said as its file, and no ear ever hears a backtick. An answer from the model is summarised
  (`spokenSummary`) — a few sentences of the finding, then "the rest is on screen", because it is, and
  reading a whole answer out is how people learn to stop listening. And **mute is now**: the sentence
  being said is cut off where it is (`Speaker.stop`) and what was queued behind it is dropped
  (`VoiceSurface.silence`), because the moment you press it is the moment you needed it. Neither is the
  window's own arithmetic — add to those rather than trimming a string before you hand it over.
- **Build rows with `Row`, never by concatenating strings.** `new Row(width, skin, pointer)` then
  `.text()`, `.button()`, `.tab()`, `.keys()`, `.field()`, `.check()`… and `.right(r => …)` for the
  group pinned to the right edge. Each control records its own hit while it draws, measured before
  colour, so the hit map is the same with any skin. A row that does not fit drops its right group,
  then its tail — never its width.
- **Every control has the same width painted and plain.** Add a look to `skin.ts` for both `COLOUR`
  and `PLAIN`; `test/hits.test.ts` compares the hits of the two.
- **A button names an action; it never types a command.** Add the action to the `actions()` table of
  the subject that answers it, never to a hub. If it needs more than a click, it opens a panel, and
  **a new panel is a folder in `panels/`**: `state.ts` for what it holds and what a key or a click
  does to it (tested in `test/panels.test.ts`), `view.ts` for how it is drawn, its arm in the `Panel`
  union and in `panelKey`/`panelClick`, its entry in `drawPanel`, its slice of `PanelContext`, a
  scenario, and an app test that opens it through the whole window. Then carry it out in that
  subject's `submits()` table, putting any failure back into the panel rather than behind it. A panel under about 250 lines all told joins `panels/small/` instead of
  taking a folder — and the dispatch stays a dispatch: what a key does to your panel is a function
  in your own file, never a branch written out in `panels.ts`.
- **Every panel is drawn in the same shell** (`panels/frame.ts`), and a panel that grows its own
  answer to any of these four questions is the bug this file exists to stop: nine panels grew nine
  answers to them, and only one of the nine was ever right. How big it is, is
  `panelSize` — the room there is, up to a `max` worth being wide, never over the strip at the foot,
  and a `needs` only where the body is fixed the whole time the panel is open (a menu); one whose
  body changes under you — a list being filtered, a form whose category switches — takes the window, or
  it moves between the click that chose a row and the click that presses it. Never a number somebody
  typed, which is what capped Settings at twenty-eight rows however tall the terminal was. How its body scrolls and
  where its bar goes, is `column` — the head above, the body with `bar` beside it, the two rows at
  the foot pinned under it — and the body keeps `scroll` in the panel's own state plus `following`
  wherever it has a selection to follow, because `atOffset` turns that off when the wheel or the bar
  moves it: the keyboard moving brings the body back to the row it is on, and scrolling yourself leaves
  the keyboard where it was. The two rows at the foot are what it last said, then the keys with its
  buttons. Two panels side by side is `beside`. How a row looks is `rowLook`: the marker says where
  the keyboard is, the lighter ground says what the mouse is over, and they are never the same thing —
  a menu drawing the pointed item as *chosen* made the keyboard appear to move when only the mouse had.
  A search box is `searchRow`. Nothing cuts its own rows with `slice` to fit: `rows.slice(0, room)` is
  what took the setup page's own Save button off the bottom, and a cap with `+7 more` under it is what
  the Spend table said instead of scrolling — three times on one page.
- **Never offer a click where nothing is drawn.** The screens test fails on it — it found the task
  menu doing exactly that, and controls left clickable under a popup.
- **Items down the side are tabs** (`tabList`, `tabbed` in `view/rows.ts`), and **every one of them
  is two rows**: a name and what it *is* on top, what it *counts* under it (`view/list.ts` for the
  rows an extension keeps, drawn there because the ACTIONS page draws one too). One row made the two
  halves fight for the columns a name needs, and the name is the one that cannot be abbreviated
  without lying — `#418  …     draft ✗ checks` is what a review looked like in a side twenty-eight
  wide. So a row's name is guaranteed its columns and what is pinned at the right gives ground at its
  own *left* end, because the edge is where the eye lands and the last mark is the one worth keeping.
  An agent is two rows — its
  name, and what it is doing under it (`doing`) — and a note is two rows only where its words run
  on, broken where they would break with its buttons showing; a row of room between tabs, a margin
  and an end on each side (`skin.item`). One row read as a line and three rows of ground as a slab;
  two was chosen by looking at all three drawn. The one you are on has an accent for its left end and
  a ground; the one under the pointer a lighter ground; the rest nothing — in the same columns and
  the same rows, so lighting one moves nothing. A ground is a cell's background, never rows of
  half-block characters: a terminal draws a glyph inside the font's height, and with lines spaced out
  they leave dark hairlines. An item's name is `shortened` with `…` before whatever is at its end,
  and its buttons are quiet glyphs (`Row.icon`: `×`, `≡`) that appear under the pointer and light in
  turn — `×` in red — never pushed off the edge by a long name.
- **`×` on an agent closes it**: stopped and taken off the list (`closeAgent`). It asks first only
  when that would lose something — a worktree of its own with work not merged. Stopping without
  removing is in its menu. Closing every agent that has finished at once is the cleanup beside
  AGENTS (`close-done`), which always asks and names what it would close — a button that empties
  the list without a word is one nobody presses twice.
- **The row along the top is one ladder, both ends of it.** `view/top.ts` draws the wordmark, a tab
  per project and the `+` at the left, and what wants you, what is working, search and the talk key
  at the right — and `LADDER` is the single ordered list of how much of each is drawn, richest
  first, with both ends measured (a probe `Row` per end, the left memoised per detail level) before
  a step is taken. Two ladders would fit the two ends of one row against each other. Adding
  anything here means adding a field to `Fits` and a step to `LADDER`, never a width check of your
  own. Two ladders would fit the two ends of one row against each other, so both ends are steps of
  this one: the tabs from counts to marks to the one that matters most to nothing, the total from
  words to figures to nothing. The talk key is the one thing that may never be given up.
- **A project tab says what is happening in its project, and a figure that cannot be placed is not
  drawn.** Two projects and two plain names said nothing at all — which of them the spinner at the
  right belonged to, least of all — so each tab carries the marks the agent list carries
  (`projectStandings`, `view/top.ts`): what wants you, what failed, what is working, what is queued,
  what is sitting there, in that order, and `✓` where something finished and nothing is left, which is
  the whole of "is everything I asked for done in there?" answered without going there. It is a fold
  over the panes on every look and a tally nobody keeps — status is a query, and a count held anywhere
  would be wrong the moment an agent finished. The marks go *inside* the tab, which costs them their
  colour, because whose a mark is, is the entire point and a glyph outside the block belongs to the tab
  on its left as much as the one on its right; every mark has a shape of its own (`markGlyph`, beside
  `glyph`) for the same reason. The figures at the right stay everybody's — `next-waiting` goes to the
  agent that wants you wherever it is — so with more than one project open they say whose in a clause:
  the project where everything counted is in one, and how many otherwise, the way `over 3 runs` makes a
  figure readable. That clause is **not** a step of the ladder: a total is drawn with it or it is not
  drawn, and short of room what a narrow window gives up is the total, since the tabs are still counting
  an inch to the left.
- **A section's heading holds a set of controls, and the main one is a button.** `Section.actions`
  (`view/rows.ts`, fitted in `view/sidebar.ts`), the button last: the small ones are chips (`Row.chip`, `skin.chip`) — the same
  block two columns narrower, so they read as the same set without reading as wide as the `+`.
  Short of columns a heading gives up its count first (the list under it is the count), then the
  small controls, the one nearest the button first (`headingFit`) — but where there is no button
  that reason is gone and the order flips, the count outlasting every control, because a folded
  section is its heading and nothing else. A destructive one is red only under the pointer, as
  `Row.icon` is. A control with nothing to act on is not drawn: the eye and the cleanup appear
  when an agent has finished, and the eye stays while it is hiding one. It is `actions`, a list,
  and it is worth checking you wrote the `s`: spread conditionally into the literal — the idiom
  everywhere here — a key `Section` does not have is not a type error, it is a control nobody
  ever sees, which is how the SMART QUEUE's `plan` and the whole plan view behind it went
  unreachable for as long as they existed. `test/dead-keys.test.ts` asks that question of every
  spread in the repository now; a golden screen only answers it for what is already drawn.
- **A section with nothing in it folds itself away; it never goes missing.** `Section.quiet` says
  the section has nothing to list, and `sectionOpen` reads it: quiet is shut unless you opened it,
  everything else is open unless you folded it. A folded heading still says something — its count,
  or its `note`, or the `brief` where a narrow side has no room for the note — because a heading
  that says only its own name is the section not being there, which is what the SMART QUEUE used
  to do. Folding and opening are a choice (`toggleSection`, remembered in `window.json` as `folded`
  and `opened`), and only what differs from what the section does on its own is written down.
- **Agents are dragged into order** (`dragAgent`, `dropAgent`, `inOrder`), by project, and the order
  is remembered in `window.json`. The window takes hold with `heldAgent`, reading every agent's row
  once when pressed: the list redraws in its new order as it is dragged, and measuring against that
  would move the place being aimed at. Tab and the agent numbers follow the same order.
- **A panel draws only from its `PanelContext`.** Anything it needs that the app state does not hold
  (settings, models, a diff) goes through `Frame.panel`, answered by the owning subject's `panel()`,
  and anything its keys or clicks need goes through `PanelInputs` from its `inputs()`. Menu items are
  the one exception: they belong to no subject, so `frameOf` and `panelInputsOf` fold them out of
  `menus()` themselves. **Add the fact to both, and add an app test that opens the panel through the
  whole window.** The screen tests build
  frames by hand, so they will pass while the real window hands the panel nothing — which is how the
  Spend panel, the task menu and Settings all once opened empty.
- **Something that opens out of a panel and may pass its edge is a popup**: return it from
  `drawPanel` in `popups`, placed relative to the panel. `draw` lays popups over the panel and makes
  whatever they cover unclickable.
- **Say "agent", not "task", on screen.** People think of the thing down the side as an agent
  doing some work; the code calls the worktree a task because that is what the domain model is.
  Labels, notices and menu items use the first word; identifiers keep the second.
- **Don't ask when a sensible default exists.** **+ New agent** makes `agent-N` and opens pi at once
  rather than opening a form — the agent's own prompt is where you say what it is for. A panel is
  for a question only you can answer.
- **A project existing is not somebody asking for an agent.** Adding one, and opening the window on
  one, start nothing: a project with no agents draws the empty screen (`view/empty.ts`), which is a
  place rather than a gap. Adding one used to make `agent-1` so there was somewhere to type, before
  that screen existed — and it was never used, because it stood for nobody's work. An agent comes
  from a task, from **+ New agent**, or from the orchestrator. The one thing opening *does* start is
  what was working when Tade closed (`reopenLost`), which was interrupted rather than taken away.
- **A panel keeps its height while you use it.** Panels are centred, so one that grows by a row
  moves under the pointer and the next click lands on the row below. Reserve the space for a
  warning, and give a list a fixed number of rows — Open project did both after a double-click
  went into the wrong folder.
- **Footer buttons outlive footer hints.** A row that does not fit drops its right-hand group, so
  put buttons there only after measuring: say keys and positions only where there is room. Measure
  before you add one — a fourth button moved every width at which the strip gives a figure up by
  its own 14 columns (`plan-strip.test.ts`), and under about 68 columns the figures go entirely.
  That is the intended order, not a regression: a figure here is one click away on the page it
  opens, and a control that is not drawn cannot be reached at all.
- **Don't import a library's types if they bring the DOM.** highlight.js's definitions pull in the
  browser's lib and change `ReadableStream` in unrelated packages; `highlight.ts` loads it with
  `createRequire` behind a small interface of its own.
- **A menu is a subject and its items.** `MenuSubject` says what was right-clicked (an agent, a
  file, a changed file, the branch); `*MenuItems` in `panels/menu/state.ts` list what can be done,
  with `off` saying why not; `App.fromMenu` carries each out. A row with a menu shows `≡` under the pointer as a
  `{ kind: 'menu', subject }` hit, and `subjectOf` maps a right-click to the same subject.
- **An agent's screen is read from the bottom.** pi draws from the top of its terminal and stops at
  its prompt, so `renderMain` drops trailing blank rows of an `agent` lane and pads above. Never do
  that to a shell: full-screen programs count rows.
- **Redraw on output, not on a timer.** `App.watch` subscribes to the lane in front of you and asks
  for a look 16 ms after it prints; the quarter-second tick is only the fallback. Polling alone made
  every keystroke wait for the next tick.
- **The keyboard has three places to go.** A panel, when one is open; the orchestrator's line, when
  `dictation` is not null; otherwise `state.keyboard` — the agent pane or the terminal in front.
  `keyAction` claims almost nothing while a terminal has it: a shell needs tab and ctrl+c. Moving
  the keyboard is always a click (`pane`, `terminal`, `bottom-tab` targets), never a key a shell
  would want.
- **Terminals live in the workbench, not the window.** `Workbench.openTerminal`, `runInTerminal`,
  `readTerminal`, `searchTerminal`… are what the window, the orchestrator's tools (`ToolHost`) and
  voice (`VoiceTerminals`) all call. The window only draws the tabs it is told about by `Live`, so a
  terminal the orchestrator opened appears the same way one you clicked open does.
- **A divider is a hit, dragged.** Lay a `{ kind: 'divider', edge }` under the line; `Window` takes
  the pointer's capture on press so every movement is a `drag`, and `resizeTo` turns a cell into a
  size. `draw` clamps it through `resolveLayout`, and `App.remember` keeps it.
- **Lists that can outgrow the screen scroll.** Lay a `{ kind: 'scroll', area }` hit under the rows
  (first, so everything drawn on top still wins), add the area to `ScrollArea`, and let the wheel, the
  keys and the bar all land through `scrollBy` / `atOffset` — see **Scrolling**. An index of your own
  is a fifth idea of where the end is.
- **Anything that scrolls has a bar down its right** (`scrollbar.ts`, `barBeside` in `view/rows.ts`): a
  column the region gives up, a thumb saying how much is in view and where, and a
  `{ kind: 'scrollbar', area, total, shown }` hit on every row of it carrying what it was drawn
  from — so a drag becomes a line to scroll to (`grabBar`, `scrollBarTo`) without laying the region
  out again. Anything *wider* than its pane gets the same bar lying along the bottom (`barAcross`),
  drawn only where there is somewhere to go: one on a pane that fits costs a row to say there is more
  when there is not. Where the region is a lane, the *window* owns that column: take it off the size in
  `paneSize` / `captureTerminal` too, or the lane draws its last column under the bar — and reach for
  `gutterBeside` rather than `barBeside`, because whose the scrolling is decides whether a bar is
  honest at all (see **Lanes that draw their own screen**).
- **The cursor is the window's to draw.** A capture is text; where typing lands comes from the
  driver (`Live.screen`, `Frame.paneScreen` / `terminal.view`) and is laid on the cell as a block
  (`blockAt`, `skin.cursor`) on whichever of the pane and the terminal has the keyboard — and never
  on a screen scrolled back from it, where the cursor is not.
- **A file is read in the window, and typed into a little.** The viewer finds (`ctrl+f`) and goes to
  a line (`ctrl+g`) in one bar that takes a row of the body, so the panel keeps its height; clicking
  the text puts a caret in it (`{ kind: 'caret', line }`, the column from how far along the hit the
  click landed) and `ctrl+s` writes it back. It is for the short edit, never a replacement for the
  editor the button beside it opens: a file only part-read or binary is not typeable at all
  (`editable`), and a save is refused outright when the file moved on disk underneath — agents are
  editing these files while you read them. An `Edited` remembers where each line came from, so a
  line nobody touched keeps the colour the whole-file pass gave it and only the line you changed is
  coloured again: colouring a megabyte on every keystroke is tens of milliseconds.
- **Extensions reach the window through the host, never by name.** Their status items come from
  `ExtensionHost.statuses()` (polled in `tick`, never awaited by a frame) into `Frame.statuses`; a
  click opens the `extension-view` panel on `host.view()`. Add a hook to the extension port rather
  than a special case for one extension here.
- **A page an extension writes may have tabs and a window, and both are declared.** An extension's `view`
  is somebody else's document, so what shape it has is the extension's to say (`viewTabs`,
  `viewWindowed`) and the window draws the tab row and the window row from *that answer* — never from
  anything read off the text, and never on a page that offers neither, which is drawn exactly as every
  page was before either existed. The keys are the Spend panel's, because a page with tabs and a window
  is the same thing twice and nobody should have to learn it in two places: `tab` moves through the tabs,
  ← → through the windows, and a page that offers one of them does not answer the other's keys at all.
  **What a day is, is the window's** — `sinceOf` (`spend.ts`), the same three windows the Spend page has,
  `today` by default — and what is handed over is the *moment* rather than the word, so nothing
  downstream can invent a second idea of a day; "this window" means one moment everywhere, which is why
  it is the window's own (`Wiring.openedAt`) and not a clock each subject reads in its own constructor. A
  tab pressed is a different page, so it is asked for then and there rather than on the next status beat,
  and the tab each extension was last on is remembered while the window is open — not across a close,
  because a tab written down is one an extension may have renamed.
- **Every panel scrolls under the wheel, as a region and not as a keypress.** `draw` lays a scroll hit
  under each panel (`panel`, and `panel-side` for the list down the side of one that has one), and the
  wheel, a key and a drag on its bar all land through `scrollBy` and `atOffset` with the rest. Settings
  is why this rule is written down: it had no offset at all, so the wheel over it was answered by
  *pressing its own down key* — a notch moved what is **chosen**, one setting at a time, jumping over
  the ones between — and it drew no bar, because nothing knew how long the form was. One bug, twice. A
  list panel must still keep its selection in view (window its rows around the index) and use the
  height it has, never a fixed handful of rows.
- **The orchestrator line is pi's own `Editor`** (cursor, wrapping, undo, paste markers), drawn by
  the app into `Frame.input` and boxed by `inputBox`. Keep `state.dictation` in step with it
  (`syncLine`) — everything else reads the dictation. Opening it never changes the panel's height.
  Each line it drew carries an `{ kind: 'input', line }` hit, and a click on one goes back to the
  editor as a click on its own row: it knows its padding and its wrapping, so it, not the window,
  works out which character you meant.
- **What you type to Tade is journaled** (`said` events) and comes back with ↑/↓ (the editor's
  history) and ctrl+r, only while the line is open — anywhere else those keys are the agent's.
- **What is on that line is the orchestrator's, not the focus's.** Moving to an agent, a terminal, a
  panel or a picture's question changes where the keyboard is and may never change what is half-written
  at Tade. So the text lives in `orchestratorDraft` whether or not the line is open, `dictation` being
  null says only that it is *closed*, and `leaveLine` and `openLine` (`model.ts`) are the only two
  doors: one keeps what was on it, the other puts it back. A rule that each of a dozen call sites has to
  remember is a rule half of them forgot, which is what "switching focus removes the things we typed"
  was. The editor is not emptied either — a closed line is simply not drawn (`input` in
  `wire/keyboard.ts`) — so the caret and the selection are where they were left too. A panel is the one
  text a click may throw away, because dismissing one is an act rather than a focus moving; the file you
  have open is not, and `panelDismiss` asks what escape asks before it loses an unsaved edit.
- **Escape stops what is thinking; ctrl+c throws away what you typed; neither ever does the other's
  job.** This is not Tade's invention — pi, Claude Code and Codex all answer these two keys this way,
  each interrupting the turn and each leaving the editor exactly as it was — and a window full of other
  people's panes is no place to invent a third convention. So escape never deletes a character: it stops
  the orchestrator's turn (`Orchestrator.interrupt`), leaving the session id, the conversation and
  everything already said alone, because the orchestrator is never introduced again and interrupting it
  may never be a way of restarting it. What a harness can do mid-turn is declared
  (`capabilities.abort`) and read through `offer()` (`thinkerOffers`); one that cannot says so in its own
  words rather than swallowing the key, which looks exactly like a stop that did not work. ctrl+c empties
  the line, the pictures going with it and a search part-way through, and with nothing left to throw away
  closes Tade — "clear input, then quit", which needs no timer, because the second press has nothing to
  clear however long you took over it. Because escape already closes panels, what it means is decided in
  one pure place (`escapeMeans`) and is always exactly **one** thing: a panel, then whatever else has the
  keyboard (pi interrupts its own agent on escape and a shell's editor wants it too), then a history
  search, then the turn, then stepping off the line — which only ever happens with nothing on it to lose.
- **Keys the window keeps are config** (`surfaces.window.keys`, listed once in `KEY_BINDINGS`):
  `appKey` names them, `keyAction` gives them meaning, the shortcuts sheet and Shortcuts settings read the
  same list. A new shortcut is a binding there, never a literal key in `app.ts`.
- **Splits are one helper** (`splitView`): an agent's pane (`state.splits`, a shell beside or below
  it) and the bottom panel (`state.terminalSplit`) both draw through it, and the app sizes both
  halves with `halves()` — the same arithmetic, or a lane is resized to a size it is not drawn at.
  `splitFocus` says which half typing goes to.
- **Anything you click is a button, not a glyph**: menus (`≡`, `▾`), close (`×`), a model or harness
  chip. A bare character is too small a target.
- **Cmd+V never reaches the window with a picture**: macOS terminals paste text, and a screenshot
  has none. So the orchestrator's line offers a picture it finds on the clipboard
  (`clipboardState`, only while the line is open, every few seconds), ctrl+v attaches it, and an
  empty paste — what some terminals send for a picture — is taken as ctrl+v. Tests pass a stub
  `clipboard`: a developer's clipboard is not a test's to read.
- **The mouse selects.** Dragging over anything that is not a control selects text and copies it on
  release; the terminal cannot, because the window reports the mouse. The rules are in **Selecting
  text** — a selection is bounded to its region's columns and anchored in its lines, never in the rows
  it was made on.
- **A region that scrolls says so, and gets selection across pages for free.** Return a `Region` in
  your drawing's `Drawn.regions` — the region's own lines, which of them landed on its first row,
  and where those rows are — and `view.ts` moves it with your rows the way it moves your hits. The
  selection is then anchored in your lines rather than in the rows on screen, so scrolling carries
  it, the wheel and a drag held off your edge extend it, and copying gives the pages of it that
  are off screen (`selection.ts`; the conversation does it in `view/strip.ts`, the two lane screens
  through `laneRegion`). A region that does not declare one still selects, only within a screen.
  Never work the numbers out a second time somewhere else: that is exactly the drift the hits
  avoid, and a region that says the wrong line copies the wrong words.
- **Agent panes and terminals scroll back** through their lane's scrollback: the wheel sets
  `paneScroll`/`terminalScroll`, the tick captures that much further back, and typing returns to
  the newest line.
- **What drawing costs is tested** in `screens.test.ts` over every scenario. If a change makes a
  frame slow, cache what it formats (as the transcript and file viewer do) rather than raising it.
- **A setting is a row in `settingsOf`**, not a control in the view: give it a `kind`, a `means`
  sentence, and `live: false` if Tade only reads it at start — the panel draws the control and the
  *on restart* label from that.
- **A name is the one column that cannot be abbreviated without lying**, so the Spend table is laid out
  from the room there is (`spendColumns`, `panels/spend/view.ts`): the figures take what a figure takes,
  the share meter gives ground first, and everything left is the name's. Past that it wraps (`nameLines`)
  and only then ellipsises — and everything cut is cut with `cap`, which says so. Two names that stop
  dead against the next column read as one unreadable row, which is how this was reported.
- **A figure that is not elapsed time says so, and says it the same way everywhere.** `13d 3h` off a
  machine that has been on since breakfast reads as a bug and is not one: twenty agents over an afternoon
  each ran for the whole of their own afternoon, and a run is wall clock from start to stop, so one that
  finished at noon and sat in its lane until the window closed counted the wait. Both are true and both
  are surprising, so both are said — `runtimeSays` in core is the one sentence, read by `tade spend`, with
  `workedSays` beside it for the other half — and the window may never *explain* it differently from
  them. `over 3 runs` is what makes such a figure readable, so it is drawn whenever the figure is and is
  never a step of a ladder that drops it. It sits on the line **under** the head's figures rather than
  beside them: the head carries two times where it carried one (`1h 32m working · 2h 5m open`), it has no
  columns to spare, and a clause one line lower is still read every time — a footnote at the foot of a
  page is what this may never become. The two words are the two the columns under them are headed with,
  so the page says which is which once and in a word.

## Drawing the queue and a plan

What waits on what, and what may start, is core's and the **change-the-queue** skill's. These are the
rules for *drawing* it, and they live here because `queue-view.ts`, `queue.ts` and `plan-graph.ts` are
the window's.

- **Looking at queued work is never starting it.** Clicking it opens what it is — the chain it is in
  drawn as boxes, every wait's reason, what its agent will be told, where it came from — and starting it
  is its own act (`Start now`, its menu, `tade_queue_change`), which goes through the queue so that what
  started it and why is written down.
- **`next` is the front of the resolved tree, not everything that happens to be waiting** (`shownBy`,
  `queue-view.ts`). The front is what starts as soon as what it waits on finishes: work behind one
  running agent is next and says how much is ahead of it, the second piece of a chain is not, and work
  that will not start by itself — held, paused — is not next either, it is *the reason* nothing is.
- **An empty list says which of those it is, in the words of the reason it actually is**
  (`queueEmptySays`, `queue.ts`). One sentence for every case reads as a bug the moment one of the
  cases is untrue, which is what sent somebody looking for this code. And what a *control* emptied,
  that control is the reason for — because it is the one thing that can be done about it, where
  `release-notes waits for a time` reads as stuck and is one press from being in the list.
- **What it shows is two questions, and so two controls** (`QueueView`). `all` and `next` are
  *positions* in that tree and are a scope, one of the pair always on; waiting for a clock is a *kind*
  of queued work, and is a switch beside them (`timed`). Drawn as a third exclusive choice it took the
  slot the ordinary case wanted, so "everything that is not on a clock" — much the commonest thing to
  want — had no button at all, and a fourth would have been a second spelling of `all` in every project
  with no schedules in it. Split, the missing view is `timed` off at either scope, and `next` with it on
  is the other thing three buttons could not say. So the switch is the **only** thing that hides a
  clock. It is one project's and outlives the window, like where you were standing and what you folded,
  and only a view that was narrowed is written down. **A control that is hiding something is always
  drawn**, however little else is in the section: a switch you cannot reach is work hidden with no way
  back to it.
- **The section itself is always in the side**, whether or not anything is in it, because a place you
  look is worth more than a row you save: with nothing queued it folds itself away (`sectionOpen`) and
  its heading says that same reason — the shorter way of saying it where a narrow side has no room for
  the sentence.
- **A column is a priority, and a pane out of room scrolls rather than folds.** Every drawing of the
  queue puts a piece in the column its depth in the resolved tree gives it (`treeStems`,
  `plan-graph.ts`), so work that can run side by side lines up under work that can run side by side,
  however long the chain is and whatever a filter leaves out. Folding the indent back at some level is
  the one thing that may never happen: it puts two pieces that cannot run together in one column, and
  the column is the whole of what the drawing says. So a deep chain reaches further right than its pane,
  and that is answered sideways — the side and the picture of a plan are laid out in the room they need
  and shown through the room there is (`slid`, `ui.ts`), with the bar lying along the bottom
  (`barAcross`). What is pinned at the right of a row stays pinned to the **pane** and not to what
  scrolls under it: a button a deep chain put out of reach is a button that is gone.
- **`drawPlan` never gives up and says a chain as a list of names** — the boxes and the arrows are what
  say what waits on what, and a list says none of it. Why a piece waits is drawn as that same tree
  (`drawWhy`), never as a list of edges sorted by name: the reasons hang off the waits they explain,
  wrapped rather than cut, and the lines that join them are the queue's own, because two drawings of
  one relationship drift apart.

## Search, and asking what a sentence meant

- **Search matches letters; asking is what happens when the letters are not enough.** `ctrl+k` is a
  pure ranking of what Tade already has (`searchResults`, `search.ts`), and that is what answers
  instantly and what answers when nobody is set up. A sentence is not letters to match, so when what was
  typed reads as one (`isSentence`) and no single row came back that is plainly the whole of it
  (`worthAsking`), a shortlist drawn in code (`shortlist`) goes to whoever offers to read one (`meant`
  on the extension port). Code does the recall, a judge does the precision, and what comes back is *rows
  added under `MIGHT MEAN`*, never a reordering of what is there: the same entries, doing what they
  always did when chosen. Only ids that were offered come back, nothing invented is shown, nothing is
  run, and an answer that arrives after the box changed is dropped — somebody is watching it, and a list
  that moves under their hands is worse than one that says nothing.
- **"Nothing matched at all" was the wrong bar**, and it is the shape of bug that hides in a rule that
  reads as careful: a sentence is long and a name is short, so what a sentence matches is never a name
  and is always letters scattered down some long label — every letter of `what the run` is in
  `Telemetry › What the brief counts`, in order, and means nothing by it. One of those was enough to
  silence the question for good: over the three-word sentences somebody would actually type, 418 were
  silenced that way. So what counts as an answer is every word of the sentence that carries meaning, in
  one row's own name, and **more than one of them** (`answered`, `wordsIn`) — one word found is a word
  found, and an agent called `coverage` answering "what is the coverage" is exactly the guess this was
  built to stop making. Asking alongside is safe for the reason it always was: what comes back only ever
  adds rows.
- **What search matches is what is happening, not only what things are called.** Every entry carries it
  (`SearchEntry.about`, composed by `happeningOn` and `happeningIn` in `happening.ts`): what the agent
  is doing, what it was asked for *verbatim*, what queued work waits on and why and what its agent will
  be told, how the checks stood at the commit in hand, and the notes about it. Derived on every look and
  never a store of its own — what an agent is doing changes while you type — and out of what the window
  has already polled, so it costs no disk, no git and no clock: the panes are status's last look, the
  work is a fold over the journal in memory, and the checks are `seenActions`, which answers and never
  goes looking.
- **The two halves match it differently, and that is the whole of why it does not flood.** A **name** is
  short, so letters in order are evidence. `about` is a paragraph, and letters in order through a
  paragraph are evidence of nothing — so the letters only ever find it as a **whole run**, ranked below
  every name match, with the line that said it shown as the row's `preview` so it says why it is there;
  and the **shortlist** counts a word said outright in it far above a name that merely spells that word,
  which is where `coverage` finding the agent raising it actually happens.
- **`about` is the half that leaves the machine**, which is exactly the text telemetry may never send.
  That is a trade somebody has to be able to see and undo, so the switch is the *window's*, not the
  extension's (`surfaces.search.context`) — a rule that lives in the code that reads the text bounds one
  reader, and a rule at the door bounds every reader. Off, each choice goes with its name and where it
  is and nothing else; the letters go on matching all of it either way, because matching it here sends
  nothing anywhere. On by default, said out loud where somebody is deciding.

## What the window says outside itself

Two things leave the window without anybody asking for them, and both are pure: facts in, one line
out, tested without a terminal.

- **The terminal's title is the window's alone** (`title.ts`, written by `wire/window.ts`). It used to
  be whatever ran in Tade's own process group last, so Terminal named the window after a child and it
  flickered between `pi < node /the/whole/path` and `osascript` all day. Everything Tade starts on a
  timer or in the background now runs detached — its own process group, so no child of ours can name
  the terminal after itself — and this is the only thing that writes a title. `windowTitle` composes
  it from the agents, the orchestrator and where you are (`⠹ tade · 2 working · 1 waiting — tade ›
  ui-chrome`), with `titleMark` in front turning while anything works, the way an agent's own mark
  does; the microphone wins it, then work, then a decision waiting, then a failure, then rest. The
  counts come from `markOf`, so the title and the sidebar can never say the same thing two ways, and
  **where you are is the first thing dropped** past `ROOM` — what is happening outlives what you are
  looking at. Written when it changes, which while anything works is every look, and otherwise
  re-asserted on the same slow beat as the repaint (`RETITLE_MS`), so a title something else took is
  taken back.
- **What Tade tells the orchestrator without being asked is `inbox.ts`.** News — an agent finished,
  one failed, the queue started one — waits and goes with the next thing somebody says (`withNews`),
  under the `THEIR_WORDS` heading, so the orchestrator can tell what was said *to* it from what it is
  being *told*, and record only the first as somebody's intent. Something that needs deciding cannot
  wait for you to speak and is told on its own, after whatever turn it is on.
- **Where you are goes above that heading, and that is not a layout choice.** With five projects open,
  "start an agent on the flaky test" is not a question anybody could answer, so `ask` appends one line
  (`whereYouAre`): the project and the agent in front of you, and how many projects are open. It is
  **Tade's** sentence, so putting it inside `What they said:` would record it as something the person
  said. Derived at the moment of asking, never stored, and deliberately not in the briefing — a
  briefing that says "you were in sentry" is wrong the instant somebody presses a tab, which is the
  same class of bug as a remembered branch. Null with one project and nothing focused, where there is
  nothing to disambiguate and a line saying so is noise.

## Checking it against a design

When a screen is designed first, compare it line for line rather than by eye: draw the scenario with
`stripTerminalSequences` and put it next to the mockup's text. Screenshots hide a column off here and
a word there; plain text does not.

## Keeping it looking right

The window is drawn from state by a pure function, so how it looks is tested like anything else:

1. **Golden screens.** `test/screens/scenarios/` holds named states drawn with fixed data, one
   file per subject and `fixtures.ts` for the world they share;
   `test/screens.test.ts` keeps each as plain text (the layout) and as exact ANSI (the look) under
   `test/screens/__screens__/`, and checks geometry and hit placement for every one. Add a scenario
   for any state worth protecting.
2. **Look at them.** `pnpm screens [out.html]` draws every scenario in colour on one page, and where
   a drawing no longer matches its golden file shows both, golden first. Look before accepting.
3. **Accept on purpose.** `pnpm vitest run packages/app -u` rewrites the goldens. Commit them with
   the change that made them, so the diff in review is the change in how Tade looks.
4. **Real input.** `test/wire/` runs the whole window against a real workbench and presses keys and
   clicks as a terminal sends them (`\x1b[<0;col;rowM`), finding labels on the rebuilt screen the
   way a person would. One file per subject — `keyboard`, `mouse`, `agents`, `queue`, … — over the
   fake terminal in `test/wire/harness.ts`.
5. **Redraw the README.** `images/` is generated from those same scenarios, so a change to how the
   window looks is a change to the README: `pnpm screens --assets`, and commit what it rewrites with
   the change that caused it. The **redraw-the-pictures** skill has the whole of it, including
   `pnpm screens --live`, which runs the real binary in a real terminal and photographs it — the one
   check the goldens cannot make, because they never go through a terminal.

## Steps

1. Add the state and its rules to `model.ts` as pure functions, with tests in `test/model.test.ts`.
2. Draw it in the `view/` file for the region it is in, and assert the geometry contract in
   `test/view.test.ts`. `view.ts` gains a line only if it is a whole new region.
3. If it needs a key, name it in `keys.ts` (test the real escape bytes — verify them against
   `parseKey` rather than writing them from memory) and give it meaning in `keyAction`.
4. If it needs a new fact, add it to `live.ts`; keep the fold from status/lanes/approvals pure and
   test that, not the polling.
5. Wire it in `app.ts`. No rules here — and **no fields**: if it needs one to remember something
   between two calls, that field belongs to a subject in `wire/`, not to `App`. A subject nobody
   has written yet is a new file there and one line in `App`'s constructor. What a subject needs
   of another goes in its own `Deps` interface, named for what it does, and `App` answers it with
   a one-line callback; a subject never reaches for the window.
6. If it puts something in front of you, the subject *declares* its slice — `facts(width)` for the
   frame, `panel(width)` for what the open panel needs to draw, `inputs()` for what a panel needs to
   answer a key — and `wire/frame.ts` folds it in. **Nothing in `app.ts` changes**, which is the
   whole point: `panelFacts` came to touch a dozen subjects because a hub had to be edited for every
   one of them. Guard on the panel kind rather than on the order of the list: a field belongs to
   exactly one subject, and two answering for one is a bug, not a fallback.
7. If the wiring changed, cover it in the `test/wire/` file named for the subject it belongs to.
   Those run the window headlessly against a real workbench and a real repository:
   `windowUnderTest()` (`test/wire/harness.ts`) makes the repository, the home, the workbench and a
   fake terminal for every test, and `start()` opens the window over them. `App` takes its
   `terminal` and `speaker` as options, and `Terminal.start(onInput)` hands back the callback the
   TUI registers — so the fake terminal presses keys and keeps what was drawn instead of drawing it.
   Poll for what should appear (`until`): rendering is batched, so asserting on the very next line is
   a flake. A subject with no file yet gets one, named after it, rather than a test in a neighbour's.
8. If it can be clicked, give it a `Target` in `hits.ts`; `wire/mouse.ts` turns the click into an
   action, and the action itself is a line in the owning subject's `actions()` table — a name, or a
   name ending in `:` which is handed whatever follows it. The same four tables answer everything
   else somebody can press: `menus()` for what a menu of some kind offers and what choosing one
   does, `submits()` for carrying a panel out, `prompts()` for a one-line panel by what it is for.
   Never an `if` in `wire/actions.ts` — that file does not change when a button is added.
   Add or update a scenario, run `pnpm screens`, look, then accept the goldens.
9. If it can outgrow its room, give it a `ScrollArea`, a `{ kind: 'scroll', area }` hit and a bar, and
   let the wheel, the keys and the drag all land through `scrollBy` / `atOffset` — never an offset of
   your own (**Scrolling**). If people will drag over pages of it, return a `Region` in your drawing's
   `Drawn.regions` so the selection is anchored in your lines (**Selecting text**). If it draws a lane,
   read `LaneScreen.scrolling` and `.pointing` rather than deciding for the program in it (**Lanes that
   draw their own screen**).
10. `pnpm screens --assets`, so the README shows the window you just changed — see
    **redraw-the-pictures**.
11. `pnpm check`.

## Gotchas

- **Lanes are looked at one look at a time** (`App.tick` → `look`). Looks that overlap finish out of
  order, and a slow one finishing last puts back the screen a fast one replaced: a line blinking, one
  frame's text interleaved with the next. A driver's `capture` waits for a whole frame — see
  **a capture is a whole frame** in `add-workspace-driver`, which is where tearing in a pane that
  draws its own screen is dealt with — and reads only the rows asked for: painting ten thousand
  lines of scrollback to keep forty was most of what echoing a keystroke cost, and a driver test
  holds it under a few milliseconds.

- `Component` requires `invalidate()` as well as `render(width)`; it is not optional. `handleMouse`
  is optional and receives coordinates *local to the component*; mouse reporting is on by default in
  `TuiAltScreen`.
- A `Drawn` region's hits are row-relative, and so is the `row` of a `Region` it declares. `view.ts`
  shifts both as it appends (`shiftRegions` beside the hits) — never afterwards from a remembered
  offset, and never twice.
- Constructor parameter properties are not erasable syntax: declare the field, then assign it.
- Run the suite on its own. A monorepo `tsc` alongside it starves the tests that spawn real git and
  PTY processes, and they time out looking exactly like a regression.
