import { describe, expect, it, vi } from 'vitest';

import type { IMHost } from '@cindy/im';
import type { WechatCredentials, WechatTransport } from '@cindy/wechat-ilink';

import type { DbClient } from '../../../localDb/client/DbClient';
import { __testing, sessionIdFor, WechatIM, type WechatIMDeps } from '../WechatIM';

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

  it('uses the shared empty-output copy after filtering the final text', () => {
    expect(__testing.normalizeFinalOutputText('')).toBe('✅ (本轮无文本输出)');
    expect(__testing.normalizeFinalOutputText('hello')).toBe('hello');
  });

  it('returns to needs_reauth when cancelling an authorization for an existing binding', () => {
    expect(__testing.authorizationCancelPhase(false, true)).toBe('needs_reauth');
    expect(__testing.authorizationCancelPhase(false, false)).toBe('disconnected');
    expect(__testing.authorizationCancelPhase(true, true)).toBe('connected');
  });

  it('fails closed before authorization when the signed compatibility policy disables it', async () => {
    const createTransport = vi.fn();
    const im = new WechatIM(
      deps({
        createTransport,
        isCompatibilityDisabled: () => true,
      }),
    );

    await expect(im.authorize()).rejects.toThrow('WECHAT_DISABLED_BY_POLICY');
    expect(im.getState()).toMatchObject({
      phase: 'disabled_by_policy',
      bound: false,
    });
    expect(createTransport).not.toHaveBeenCalled();
  });

  it('applies and clears a runtime compatibility disable without starting a transport', async () => {
    let disabled = false;
    const im = new WechatIM(
      deps({
        isCompatibilityDisabled: () => disabled,
      }),
    );

    disabled = true;
    await im.setCompatibilityDisabled(true);
    expect(im.getState()).toMatchObject({ phase: 'disabled_by_policy', bound: false });

    disabled = false;
    await im.setCompatibilityDisabled(false);
    expect(im.getState()).toMatchObject({ phase: 'disconnected', bound: false });
  });

  it('drops late authorization credentials after a compatibility revision changes', async () => {
    const testHost = host();
    let resolveCredentials!: (credentials: WechatCredentials) => void;
    const waitAuthorization = vi.fn(
      () =>
        new Promise<WechatCredentials>((resolve) => {
          resolveCredentials = resolve;
        }),
    );
    const authorizationTransport = {
      beginAuthorization: vi.fn(async () => ({
        id: 'challenge',
        qrCodeUrl: 'https://ilinkai.weixin.qq.com/qr/challenge',
        createdAt: 1,
      })),
      waitAuthorization,
    } as unknown as WechatTransport;
    const createTransport = vi.fn(() => authorizationTransport);
    const im = new WechatIM(deps({ host: testHost, createTransport }));

    await im.authorize();
    await vi.waitFor(() => expect(waitAuthorization).toHaveBeenCalledOnce());
    await im.setCompatibilityDisabled(true);
    resolveCredentials({
      token: 'late-token',
      botId: 'late-bot',
      userId: 'late-user',
      baseUrl: 'https://ilinkai.weixin.qq.com',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(createTransport).toHaveBeenCalledOnce();
    expect(testHost.secrets.write).not.toHaveBeenCalled();
    expect(im.getState()).toMatchObject({ phase: 'disabled_by_policy', bound: false });
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
    isCompatibilityDisabled: overrides.isCompatibilityDisabled ?? (() => false),
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
