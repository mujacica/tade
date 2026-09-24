import { testRecorder, testTranscriber } from '@tade/voice-core/conformance'
import {
  FfmpegRecorder,
  OpenAiTranscriber,
  ScriptedRecorder,
  ScriptedTranscriber,
  WhisperCppTranscriber,
} from '../src/index.ts'
import { fakeCapture } from './fake-audio.ts'

// Every implementation of both ports, against the shared suites.
//
// Each real engine is registered twice, and the pair is the point. Once as it
// comes, declared as reaching the machine, which holds it to what it says
// about itself and how it refuses — the half that is true on a machine with
// nothing installed and on one with everything. And once through its own seam,
// which holds the same class to the whole contract without opening a
// microphone or spending a minute on a model.
//
// That second registration is why the seams exist. Before them this suite
// skipped the behaviour tests wherever the tool was missing — and on a machine
// that really had whisper.cpp and a model it did not skip them, it ran the
// model against four hundred milliseconds of silence on every `pnpm check`.

testTranscriber('scripted', () => new ScriptedTranscriber(['park the stripe one']))

testTranscriber('whisper-cpp', () => new WhisperCppTranscriber(), { reachesTheMachine: true })
testTranscriber('openai', () => new OpenAiTranscriber({ env: {} }), { reachesTheMachine: true })

// The same two classes, reached through the seam rather than the tool.
testTranscriber(
  'whisper-cpp (its model faked)',
  () =>
    new WhisperCppTranscriber({
      binary: process.execPath,
      model: process.execPath,
      run: async () => undefined,
    }),
)

testTranscriber(
  'openai (its endpoint faked)',
  () =>
    new OpenAiTranscriber({
      apiKey: 'k',
      fetch: async () => new Response(JSON.stringify({ text: '' }), { status: 200 }),
    }),
)

testRecorder('scripted', () => new ScriptedRecorder())

testRecorder('ffmpeg', () => new FfmpegRecorder(), { reachesTheMachine: true })

testRecorder('ffmpeg (its device faked)', () => {
  const { spawn } = fakeCapture()
  return new FfmpegRecorder({ binary: process.execPath, platform: 'darwin', spawn })
})
