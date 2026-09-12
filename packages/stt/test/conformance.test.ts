import { testTranscriber } from '@wilco/driver-conformance'
import { OpenAiTranscriber, ScriptedTranscriber, WhisperCppTranscriber } from '../src/index.ts'

testTranscriber('scripted', () => new ScriptedTranscriber(['park the stripe one']))

// The real engines are exercised for the part of the contract that holds
// whether or not this machine can run them: that they say so plainly, and
// refuse clearly rather than failing halfway. The suite skips the behaviour
// tests when `available()` says no, which is exactly what it is there for.
testTranscriber('whisper-cpp', () => new WhisperCppTranscriber())
testTranscriber('openai', () => new OpenAiTranscriber({ env: {} }))
