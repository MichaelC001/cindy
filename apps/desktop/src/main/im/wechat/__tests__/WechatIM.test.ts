import { describe, expect, it, vi } from 'vitest';

import type { IMHost } from '@cindy/im';

import type { DbClient } from '../../../localDb/client/DbClient';
import { sessionIdFor, WechatIM, type WechatIMDeps } from '../WechatIM';

describe('WechatIM host boundary', () => {
  it('derives a stable session id without exposing either platform identifier', () => {
    const first = sessionIdFor('bot-secret-id', 'peer-secret-id');
    expect(first).toBe(sessionIdFor('bot-secret-id', 'peer-secret-id'));
    expect(first).toMatch(/^wechat_[a-f0-9]{32}$/);
    expect(first).not.toContain('bot-secret-id');
    expect(first).not.toContain('peer-secret-id');
  });

  it('fails closed before starting authorization when safeStorage is unavailable', async () => {
    const createTransport = vi.fn();
    const im = new WechatIM(
      deps({
        host: host({ secretAvailable: false }),
        createTransport,
      }),
    );

    await expect(im.authorize()).rejects.toThrow('WECHAT_SAFE_STORAGE_UNAVAILABLE');
    expect(createTransport).not.toHaveBeenCalled();
  });

  it('never emulates rich cards for the chunked-text WeChat channel', async () => {
    const im = new WechatIM(deps());

    await expect(im.sendInteractiveCard()).rejects.toThrow('WECHAT_RICH_OUTPUT_UNSUPPORTED');
    await expect(im.updateInteractiveCard()).rejects.toThrow('WECHAT_RICH_OUTPUT_UNSUPPORTED');
    await expect(im.patchMarkdownCard()).rejects.toThrow('WECHAT_RICH_OUTPUT_UNSUPPORTED');
    await expect(im.startStreamingText('peer')).rejects.toThrow('WECHAT_RICH_OUTPUT_UNSUPPORTED');
  });
});

function deps(overrides: Partial<WechatIMDeps> & { host?: IMHost } = {}): WechatIMDeps {
  return {
    host: overrides.host ?? host(),
    getDbClient: overrides.getDbClient ?? (() => fakeDb()),
    createTransport:
      overrides.createTransport ??
      (() => {
        throw new Error('transport should not be created');
      }),
    openAuthorizationUrl: overrides.openAuthorizationUrl ?? vi.fn(),
    captureAccountGeneration: overrides.captureAccountGeneration ?? (() => 1),
    isAccountGenerationCurrent:
      overrides.isAccountGenerationCurrent ?? ((generation) => generation === 1),
    now: overrides.now ?? (() => 100),
  };
}

function host(options: { secretAvailable?: boolean } = {}): IMHost {
  return {
    secrets: {
      isAvailable: () => options.secretAvailable ?? true,
      read: vi.fn(() => null),
      write: vi.fn(() => true),
      remove: vi.fn(),
    },
    ipc: {
      handle: vi.fn(),
      broadcast: vi.fn(),
    },
    paths: {
      feishuMediaDir: 'unused',
    },
    httpPostForm: vi.fn(),
  };
}

function fakeDb(): DbClient {
  return {
    tx: vi.fn(),
    query: vi.fn(),
    queryOne: vi.fn(),
    exec: vi.fn(),
    drizzle: {} as DbClient['drizzle'],
    vecAvailable: false,
    dispose: vi.fn(),
  };
}
