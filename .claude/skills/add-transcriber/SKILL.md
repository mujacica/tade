---
name: add-transcriber
description: Add a speech-to-text engine or a microphone backend (whisper.cpp, an API, a streaming service), or change the Transcriber/Recorder ports. Use when Tade should listen in a new way.
---

# Adding a transcriber or a recorder

Two ports, deliberately separate, in `packages/voice/core/src/port.ts`:

| Port | Job | Implementations |
|---|---|---|
| `Recorder` | capture a microphone into a WAV file | `ffmpeg`, `scripted` |
| `Transcriber` | turn that file into words | `whisper-cpp`, `openai`, `groq`, `scripted` |

They are separate because they fail separately: a missing model and a missing microphone need
different sentences, and the same recorder feeds every engine.

## Steps

1. Implement the interface in `packages/voice/stt/src/<name>.ts`.
2. Add one entry to `transcribers` (or `recorders`) in `packages/voice/stt/src/index.ts`. That map is the
   only place a config name becomes an implementation.
3. Add the name to the `stt.driver` / `mic.driver` enum in `packages/core/src/config.ts`.
4. Call the conformance suite (`testTranscriber` from `@tade/voice-core/conformance`) in
   `packages/voice/stt/test/conformance.test.ts`:
   ```ts
   testTranscriber('my-engine', () => new MyTranscriber())
   ```
5. Make sure `tade voice` says what the engine needs when it is not ready.
6. `pnpm check`.

## Rules

- **`available()` is asked before anything is recorded**, and must never throw. A missing model or
  an unset API key is a sentence the user can act on — returning `{ ok: false, reason }` is how
  `tade voice` explains itself and how the window knows to fall back to a typed line. Discovering
  it *after* someone has spoken means losing what they said.
- **Never make a network call in `available()`.** It runs on every push-to-talk, and the test suite
  makes no network calls at all. Check for a key, a binary, a model file — not for a live service.
- **Declare `capabilities.local` honestly.** It is what tells the user whether their voice leaves
  the machine, and `tade voice` prints it.
- **Silence is not an error.** An empty recording returns `{ text: '' }`; the caller decides that
  nothing was said. Strip whatever noise annotations the engine emits for silence (`[BLANK_AUDIO]`),
  or they become utterances.
- **Honour `signal`.** Push-to-talk is cancellable and a transcription that outlives its window is
  a reply to something the user has moved on from.
- **Take `vocabulary` where the engine supports it.** Task and project names are exactly the words a
  general model gets wrong, and both whisper and the OpenAI-compatible endpoints accept a prompt.
- **The caller owns the clip.** `AudioClip.path` is deleted by whoever asked for the transcription,
  so never hand back a path you do not own — a fixture returning `/dev/null` looks fine until
  something tries to unlink it.

## Testing without a microphone

`ScriptedTranscriber` and `ScriptedRecorder` let the whole path above them — push-to-talk, the
grammar, the resolver, the window — run in CI with no audio hardware, no model and no network. Any
test that needs speech uses those; real engines are covered by the contract tests in the suite,
which skip their behaviour cases when `available()` says no.
