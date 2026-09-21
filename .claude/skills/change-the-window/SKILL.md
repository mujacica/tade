---
name: change-the-window
description: Change what `tade app` shows, or which keys it claims — panes, the projects list, the orchestrator strip, dictation, focus rules. Use for any change to the window's behaviour or layout.
---

# Changing the window

`packages/app` is the window. It is deliberately split into small files, and the split is the point:

| File | Holds | Testable without |
|---|---|---|
| `model.ts` | What is shown, as data: panes, projects, focus, key meanings | a terminal |
| `frame.ts` | `Frame`: the shape of what the window is handed to draw, and nothing else | — (types only) |
| `view.ts` | `draw(state, frame) → { rows, hits }`, one row per line: the composition, and nothing else | a terminal |
| `view/` | One file per region — `top`, `sidebar`, `main`, `queue`, `plan`, `schedule`, `actions`, `strip`, `foot` — over three shared ones: `text` (width, words, moments, numbers), `rows` (a tab, a section, a scrollbar) and `lane`/`split`, which two regions each reach for | a terminal |
| `ui.ts` | `Row` (controls that know where they are clickable), `box`, `overlay` | a terminal |
| `hits.ts` | What is where on the screen, so a click can mean something | a terminal |
| `skin.ts` | The 256-colour palette and every control's look, plain and painted | a terminal |
| `panels.ts` | The `Panel` union, `PanelInputs`, and the two dispatches — `panelKey` and `panelClick` — and nothing else | a terminal |
| `panels/` | One folder per panel, its state and its drawing side by side: `settings`, `extensions`, `file`, `project`, `spend`, `menu`, `models`, `search`, and `small` for the ten that are one question each. Over three shared ones: `context` (`PanelContext`, `drawPanel`), `cells` (`cap`, `bar`, `pad`, the drawing every panel is built from) and `outcome` (`PanelOutcome`, what a press does) | a terminal |
| `spend.ts` | What the Spend panel shows, from `usage` events | a terminal |
| `projects.ts` | Recent projects, folder listing, `git init` for Open project | a real disk and git |
| `files.ts` | The FILES tree: order, what is hidden, which folders are open | a disk (it takes a lister) |
| `search.ts` | Search: reading a query, fuzzy matching, grouping results, tab completion, and the shortlist put to whoever reads a sentence | a disk or git |
| `finder.ts` | What search looks through: `git ls-files` and `git grep`, and parsing both | — (a real repo) |
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
| `wire/` | One file per subject the window wires up — `notes`, `checks`, `voice`, `images`, `settings`, `machine`, `window`, `search`, `schedules`, `queue` — each a small class over `context.ts`'s `Wiring` (the options, the state, `live`, the clock, the repaint), owning its own fields and taking what it needs of other subjects as named dependencies | a terminal, mostly |
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

## Controls and panels

- **Colour means something, or it is grey.** The footer keeps only Extensions, Settings and Mute,
  grey unless something wants you (amber: an extension to set up, sound that is off). Starting an
  agent and opening a project have their `+` where agents and projects are; search's key sits by
  the talk key. Don't colour a button for identity.
- **Build rows with `Row`, never by concatenating strings.** `new Row(width, skin, pointer)` then
  `.text()`, `.button()`, `.tab()`, `.keys()`, `.field()`, `.check()`… and `.right(r => …)` for the
  group pinned to the right edge. Each control records its own hit while it draws, measured before
  colour, so the hit map is the same with any skin. A row that does not fit drops its right group,
  then its tail — never its width.
- **Every control has the same width painted and plain.** Add a look to `skin.ts` for both `COLOUR`
  and `PLAIN`; `test/hits.test.ts` compares the hits of the two.
- **A button names an action; it never types a command.** Add the action to `App.run`. If it needs
  more than a click, it opens a panel, and **a new panel is a folder in `panels/`**: `state.ts` for
  what it holds and what a key or a click does to it (tested in `test/panels.test.ts`), `view.ts`
  for how it is drawn, its arm in the `Panel` union and in `panelKey`/`panelClick`, its entry in
  `drawPanel`, its slice of `PanelContext`, a scenario, and an app test that opens it through the
  whole window. Then carry it out in `App.submitPanel`, putting any failure back into the panel
  rather than behind it. A panel under about 250 lines all told joins `panels/small/` instead of
  taking a folder — and the dispatch stays a dispatch: what a key does to your panel is a function
  in your own file, never a branch written out in `panels.ts`.
- **Never offer a click where nothing is drawn.** The screens test fails on it — it found the task
  menu doing exactly that, and controls left clickable under a popup.
- **Items down the side are tabs** (`tabList`, `tabbed` in `view/rows.ts`): an agent is two rows — its
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
  (menu items, settings, models, a diff) goes through `Frame.panel`, filled in `App.panelFacts`, and
  anything its keys or clicks need goes through `PanelInputs` from `App.panelInputs`. **Add the fact
  to both, and add an app test that opens the panel through the whole window.** The screen tests build
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
- **A panel keeps its height while you use it.** Panels are centred, so one that grows by a row
  moves under the pointer and the next click lands on the row below. Reserve the space for a
  warning, and give a list a fixed number of rows — Open project did both after a double-click
  went into the wrong folder.
- **Footer buttons outlive footer hints.** A row that does not fit drops its right-hand group, so
  put buttons there only after measuring: say keys and positions only where there is room.
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
  (first, so everything drawn on top still wins) and handle the wheel in `App.pointer`: the sidebar
  keeps `state.scroll`, a panel's list moves its own index.
- **Anything that scrolls has a bar down its right** (`scrollbar.ts`, `barBeside` in `view/rows.ts`): a
  column the region gives up, a thumb saying how much is in view and where, and a
  `{ kind: 'scrollbar', area, total, shown }` hit on every row of it carrying what it was drawn
  from — so a drag becomes a line to scroll to (`grabBar`, `scrollBarTo`) without laying the region
  out again. Where the region is a lane, the *window* owns that column: take it off the size in
  `paneSize` / `captureTerminal` too, or the lane draws its last column under the bar.
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
- **Every panel scrolls under the wheel.** `draw` lays a scroll hit under each panel, and the wheel
  becomes ↑/↓ for it — so a list panel must keep its selection in view (window its rows around the
  index) and use the height it has, rather than a fixed handful of rows.
- **The orchestrator line is pi's own `Editor`** (cursor, wrapping, undo, paste markers), drawn by
  the app into `Frame.input` and boxed by `inputBox`. Keep `state.dictation` in step with it
  (`syncLine`) — everything else reads the dictation. Opening it never changes the panel's height.
  Each line it drew carries an `{ kind: 'input', line }` hit, and a click on one goes back to the
  editor as a click on its own row: it knows its padding and its wrapping, so it, not the window,
  works out which character you meant.
- **What you type to Tade is journaled** (`said` events) and comes back with ↑/↓ (the editor's
  history) and ctrl+r, only while the line is open — anywhere else those keys are the agent's.
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
  release (`Window.selection`); the terminal cannot, because the window reports the mouse.
- **Agent panes and terminals scroll back** through their lane's scrollback: the wheel sets
  `paneScroll`/`terminalScroll`, the tick captures that much further back, and typing returns to
  the newest line.
- **What drawing costs is tested** in `screens.test.ts` over every scenario. If a change makes a
  frame slow, cache what it formats (as the transcript and file viewer do) rather than raising it.
- **A setting is a row in `settingsOf`**, not a control in the view: give it a `kind`, a `means`
  sentence, and `live: false` if Tade only reads it at start — the panel draws the control and the
  *on restart* label from that.

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
6. If it puts something in front of you, the subject exposes its slice of `Frame`, `PanelContext`
   or `PanelInputs` as a method, and the hub in `app.ts` calls it in one line. Never read a
   subject's field from the hub — that is how `panelFacts` came to touch a dozen subjects, and
   folding those hubs over the subjects is what is left of `docs/modularity.md`.
7. If the wiring changed, cover it in the `test/wire/` file named for the subject it belongs to.
   Those run the window headlessly against a real workbench and a real repository:
   `windowUnderTest()` (`test/wire/harness.ts`) makes the repository, the home, the workbench and a
   fake terminal for every test, and `start()` opens the window over them. `App` takes its
   `terminal` and `speaker` as options, and `Terminal.start(onInput)` hands back the callback the
   TUI registers — so the fake terminal presses keys and keeps what was drawn instead of drawing it.
   Poll for what should appear (`until`): rendering is batched, so asserting on the very next line is
   a flake. A subject with no file yet gets one, named after it, rather than a test in a neighbour's.
8. If it can be clicked, give it a `Target` in `hits.ts` and handle it in `App.clicked` / `App.run`.
   Add or update a scenario, run `pnpm screens`, look, then accept the goldens.
9. `pnpm screens --assets`, so the README shows the window you just changed — see
   **redraw-the-pictures**.
10. `pnpm check`.

## Gotchas

- **Lanes are looked at one look at a time** (`App.tick` → `look`). Looks that overlap finish out of
  order, and a slow one finishing last puts back the screen a fast one replaced: a line blinking, one
  frame's text interleaved with the next. A driver's `capture` waits for a whole frame — the pty
  driver until its emulator has parsed what arrived and no synchronized update is half applied — and
  reads only the rows asked for: painting ten thousand lines of scrollback to keep forty was most of
  what echoing a keystroke cost, and a driver test holds it under a few milliseconds.

- `Component` requires `invalidate()` as well as `render(width)`; it is not optional. `handleMouse`
  is optional and receives coordinates *local to the component*; mouse reporting is on by default in
  `TuiAltScreen`.
- A `Drawn` region's hits are row-relative. Shift them as you append the region, never afterwards
  from a remembered offset.
- Constructor parameter properties are not erasable syntax: declare the field, then assign it.
- Run the suite on its own. A monorepo `tsc` alongside it starves the tests that spawn real git and
  PTY processes, and they time out looking exactly like a regression.
