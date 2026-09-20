## What they showed

A screenshot of the Settings panel (telemetry group, "Send to"):

- Labels are clipped and run straight into their control: `Crashes and warnin—● on`, `What happened arou—● on`, `How much of Tade i ‹ 0.1 ›`. The fixed `LABEL` pad plus the toggle glyph collide — the label is truncated mid-word with no ellipsis and there is no gap before the control.
- The group's `about`/`means` text on the right ("nothing is sent … a Sentry DSN, fro…") overlaps/overflows the panel edge and sits under the title.
- Toggles read as `—● on` — an ugly ad-hoc glyph, misaligned across rows (some have an extra dash, some don't).
- No hover feedback on toggles, steppers, or rows: nothing says these are clickable.

## Where it lives

- `packages/app/src/panel-view.ts` — `settings()` around line 1602, the per-kind `control()` around line 1800, `settingsDropdown()` ~1941. `LABEL`, `SIDE`, `pad()`, `fitTo()` are the layout primitives that are causing the clipping.
- `packages/app/src/ui.ts` — `Row`, `.toggle()`, `.button()`, `.field()`, hit targets, hover/focus (`withFocus`, `pointer`).
- `packages/app/src/skin.ts` — palette and tones.
- `packages/app/src/settings.ts` — the setting model (`title`, `means`, `type`, `live`).

## What done looks like

1. Toggles redesigned so they look deliberate and identical on every row, aligned in a column, readable in the current palette.
2. No overlaps anywhere in the panel at any terminal width: labels either wrap or truncate with an ellipsis and always keep a gap before their control; the `about`/`means` text stays inside the panel; the control column doesn't collide with `↻ on restart`.
3. Hovers implemented on everything clickable in Settings — toggles, steppers (`‹ ›`), rows, choice/model dropdowns, buttons — using the same hover treatment the rest of the window now uses (other agents added hover feedback in the bottom status strip; match it, don't invent a third style).
4. Golden screen tests: add/refresh scenarios so the settings panel is covered at a couple of widths, including a narrow one, and regenerate whatever `pnpm screens` produces if the README pictures include settings.

Also go through the whole panel, not just the telemetry group — the person said "rework settings … etc etc etc".

Many agents have reworked `packages/app` before you (palette, scrollbars, button end-caps removed, status-strip hovers, queue graph). **Pull/rebase first**, keep their work, and keep the style consistent with it. Run `pnpm check` on its own and commit only your files.
