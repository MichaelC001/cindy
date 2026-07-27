import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebContents } from 'electron';

import { RsbWebviewArtifacts } from '../rsb-webview-artifacts.js';

function artifactHarness() {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  const session = {
    on: (event: string, listener: (...args: unknown[]) => void) => {
      const group = listeners.get(event) ?? new Set();
      group.add(listener);
      listeners.set(event, group);
    },
    removeListener: (event: string, listener: (...args: unknown[]) => void) => {
      listeners.get(event)?.delete(listener);
    },
  };
  const wc = { session } as unknown as WebContents;
  const emitDownload = (item: ReturnType<typeof downloadItem>) => {
    for (const listener of listeners.get('will-download') ?? []) {
      listener({}, item, wc);
    }
  };
  return { wc, emitDownload };
}

function downloadItem(finalState: 'completed' | 'cancelled' | 'interrupted') {
  let savePath = '';
  let doneListener: ((...args: unknown[]) => void) | undefined;
  return {
    getFilename: () => '../unsafe?.txt',
    getURL: () => 'https://example.test/download',
    getMimeType: () => 'text/plain',
    getTotalBytes: () => 5,
    getReceivedBytes: () => 5,
    setSavePath: vi.fn((value: string) => {
      savePath = value;
      fs.writeFileSync(value, 'hello');
    }),
    cancel: vi.fn(),
    once: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      if (event === 'done') doneListener = listener;
    }),
    finish: () => doneListener?.({}, finalState),
    savedPath: () => savePath,
  };
}

let root = '';

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-browser-artifact-test-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('RsbWebviewArtifacts', () => {
  it('stores a completed download in an isolated directory with a safe name', async () => {
    const harness = artifactHarness();
    const item = downloadItem('completed');
    const artifacts = new RsbWebviewArtifacts(() => root, { warn: vi.fn() });

    const result = await artifacts.capture(
      harness.wc,
      { sessionId: 'session/one', timeoutMs: 1000 },
      async () => {
        harness.emitDownload(item);
        setTimeout(() => item.finish(), 0);
        return 'clicked';
      },
    );

    expect(result.value).toBe('clicked');
    expect(result.downloads).toEqual([
      expect.objectContaining({
        fileName: 'unsafe.txt',
        state: 'completed',
        bytes: 5,
      }),
    ]);
    expect(result.downloads[0].path).toBe(item.savedPath());
    expect(fs.readFileSync(item.savedPath(), 'utf8')).toBe('hello');
  });

  it('removes partial files after a cancelled download', async () => {
    const harness = artifactHarness();
    const item = downloadItem('cancelled');
    const artifacts = new RsbWebviewArtifacts(() => root, { warn: vi.fn() });

    const result = await artifacts.capture(
      harness.wc,
      { sessionId: 'session-two', timeoutMs: 1000 },
      async () => {
        harness.emitDownload(item);
        setTimeout(() => item.finish(), 0);
      },
    );

    expect(result.downloads[0]).toMatchObject({ state: 'cancelled' });
    expect(result.downloads[0].path).toBeUndefined();
    expect(fs.existsSync(item.savedPath())).toBe(false);
  });

  it('does not intercept downloads outside an active agent action', async () => {
    const harness = artifactHarness();
    const artifacts = new RsbWebviewArtifacts(() => root, { warn: vi.fn() });
    await artifacts.capture(harness.wc, { sessionId: 'session-three' }, async () => undefined);

    const item = downloadItem('completed');
    harness.emitDownload(item);

    expect(item.setSavePath).not.toHaveBeenCalled();
  });
});
