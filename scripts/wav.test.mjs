import assert from 'node:assert/strict'
import { test } from 'node:test'
import { encodeWav } from '../src/music/wav.ts'

test('WAV headers and interleaved stereo PCM preserve channel order', async () => {
  const blob = encodeWav([new Float32Array([-1, 0, 1]), new Float32Array([1, .5, -2])], 44100)
  const buffer = await blob.arrayBuffer()
  const view = new DataView(buffer)
  const tag = at => new TextDecoder().decode(buffer.slice(at, at + 4))
  assert.equal(blob.type, 'audio/wav')
  assert.equal(tag(0), 'RIFF')
  assert.equal(tag(8), 'WAVE')
  assert.equal(tag(36), 'data')
  assert.equal(view.getUint32(4, true), buffer.byteLength - 8)
  assert.equal(view.getUint16(22, true), 2)
  assert.equal(view.getUint32(24, true), 44100)
  assert.equal(view.getUint32(28, true), 176400)
  assert.equal(view.getUint16(32, true), 4)
  assert.equal(view.getUint16(34, true), 16)
  assert.equal(view.getUint32(40, true), 12)
  assert.deepEqual(Array.from({length: 6}, (_, i) => view.getInt16(44 + i * 2, true)), [-32768, 32767, 0, 16383, 32767, -32768])
})

test('mono recordings remain supported and invalid channel lengths are rejected', async () => {
  const view = new DataView(await encodeWav([new Float32Array([.5])], 48000).arrayBuffer())
  assert.equal(view.getUint16(22, true), 1)
  assert.equal(view.getUint32(28, true), 96000)
  assert.equal(view.getInt16(44, true), 16383)
  assert.throws(() => encodeWav([], 44100))
  assert.throws(() => encodeWav([new Float32Array(2), new Float32Array(1)], 44100))
})
