import { describe, expect, it } from 'vitest';

import { __testing } from '../mediaStaging';
import { pcmS16leToWav } from '../silkWav';

describe('WeChat media staging validation', () => {
  it('detects supported image bytes instead of trusting platform metadata', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(__testing.detectWechatMedia({ kind: 'image' }, png)).toEqual({
      attachmentKind: 'image',
      fileName: 'wechat-image.png',
      mimeType: 'image/png',
      storage: 'cindy-media',
    });
    expect(__testing.detectWechatMedia({ kind: 'image' }, Buffer.from('not-image'))).toBeNull();
  });

  it('requires the declared voice encoding to match the downloaded bytes', () => {
    expect(
      __testing.detectWechatMedia({ kind: 'voice', voiceEncoding: 8 }, Buffer.from('OggSvoice')),
    ).toMatchObject({ mimeType: 'audio/ogg' });
    expect(
      __testing.detectWechatMedia({ kind: 'voice', voiceEncoding: 7 }, Buffer.from('OggSvoice')),
    ).toBeNull();
  });

  it('sanitizes platform filenames before creating owner-scoped paths', () => {
    expect(__testing.sanitizeAttachmentName('../../secret?.pdf', 'fallback.bin')).toBe(
      '.._.._secret_.pdf',
    );
    expect(__testing.sanitizeAttachmentName('... ', 'fallback.bin')).toBe('fallback.bin');
  });

  it('wraps worker-decoded mono PCM in a valid 24 kHz WAV container', () => {
    const wav = Buffer.from(pcmS16leToWav(Buffer.from([1, 0, 2, 0]), 24_000));
    expect(wav.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(wav.subarray(8, 12).toString('ascii')).toBe('WAVE');
    expect(wav.readUInt32LE(24)).toBe(24_000);
    expect(wav.readUInt16LE(22)).toBe(1);
    expect(wav.readUInt16LE(34)).toBe(16);
    expect(wav.subarray(44)).toEqual(Buffer.from([1, 0, 2, 0]));
  });
});
