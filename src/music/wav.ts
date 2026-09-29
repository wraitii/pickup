/** 16-bit PCM WAV. */
export function encodeWav(channels: Float32Array[], sampleRate: number): Blob {
  const frames = channels[0]?.length ?? 0
  if (!frames || !channels.length || channels.some(c => c.length !== frames)) throw new Error('Invalid audio channels')
  const bytes = frames * channels.length * 2
  const view = new DataView(new ArrayBuffer(44 + bytes))
  const str = (at: number, s: string) => [...s].forEach((ch, i) => view.setUint8(at + i, ch.charCodeAt(0)))
  str(0, 'RIFF')
  view.setUint32(4, 36 + bytes, true)
  str(8, 'WAVE')
  str(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, channels.length, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * channels.length * 2, true)
  view.setUint16(32, channels.length * 2, true)
  view.setUint16(34, 16, true)
  str(36, 'data')
  view.setUint32(40, bytes, true)
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels.length; c++) {
      const value = channels[c][i]
      const s = Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0
      view.setInt16(44 + (i * channels.length + c) * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true)
    }
  }
  return new Blob([view], { type: 'audio/wav' })
}

