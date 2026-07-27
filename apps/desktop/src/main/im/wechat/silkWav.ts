export function pcmS16leToWav(pcm: Uint8Array, sampleRate: number): Uint8Array {
  if (pcm.byteLength === 0 || pcm.byteLength % 2 !== 0) {
    throw new Error('Invalid PCM payload.');
  }
  const result = Buffer.allocUnsafe(44 + pcm.byteLength);
  result.write('RIFF', 0, 'ascii');
  result.writeUInt32LE(36 + pcm.byteLength, 4);
  result.write('WAVE', 8, 'ascii');
  result.write('fmt ', 12, 'ascii');
  result.writeUInt32LE(16, 16);
  result.writeUInt16LE(1, 20);
  result.writeUInt16LE(1, 22);
  result.writeUInt32LE(sampleRate, 24);
  result.writeUInt32LE(sampleRate * 2, 28);
  result.writeUInt16LE(2, 32);
  result.writeUInt16LE(16, 34);
  result.write('data', 36, 'ascii');
  result.writeUInt32LE(pcm.byteLength, 40);
  result.set(pcm, 44);
  return result;
}
