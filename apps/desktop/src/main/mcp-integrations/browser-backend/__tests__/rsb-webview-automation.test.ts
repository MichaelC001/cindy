import { describe, expect, it, vi } from 'vitest';
import type { WebContents } from 'electron';

import { RsbWebviewAutomation } from '../rsb-webview-automation.js';

interface DebuggerHarness {
  wc: WebContents;
  sendCommand: ReturnType<typeof vi.fn>;
  executeJavaScript: ReturnType<typeof vi.fn>;
  attach: ReturnType<typeof vi.fn>;
  detach: ReturnType<typeof vi.fn>;
}

function debuggerHarness(
  handler: (method: string, params?: Record<string, unknown>) => unknown | Promise<unknown>,
  alreadyAttached = false,
): DebuggerHarness {
  let attached = alreadyAttached;
  const attach = vi.fn(() => {
    attached = true;
  });
  const detach = vi.fn(() => {
    attached = false;
  });
  const sendCommand = vi.fn(handler);
  const executeJavaScript = vi.fn(async () => ({ ok: true }));
  const wc = {
    getURL: () => 'https://example.test/form',
    executeJavaScript,
    debugger: {
      isAttached: vi.fn(() => attached),
      attach,
      detach,
      sendCommand,
    },
  } as unknown as WebContents;
  return { wc, sendCommand, executeJavaScript, attach, detach };
}

function automation(): RsbWebviewAutomation {
  return new RsbWebviewAutomation({ warn: vi.fn() });
}

const AX_TREE = {
  nodes: [
    {
      nodeId: 'root',
      role: { value: 'RootWebArea' },
      name: { value: 'Example' },
      backendDOMNodeId: 1,
      childIds: ['button', 'textbox'],
    },
    {
      nodeId: 'button',
      role: { value: 'button' },
      name: { value: 'Submit' },
      backendDOMNodeId: 2,
      childIds: [],
    },
    {
      nodeId: 'textbox',
      role: { value: 'textbox' },
      name: { value: 'Email' },
      value: { value: 'old@example.test' },
      backendDOMNodeId: 3,
      childIds: [],
    },
  ],
};

describe('RsbWebviewAutomation snapshot', () => {
  it('builds an AI role snapshot with actionable refs and releases its debugger', async () => {
    const harness = debuggerHarness(async (method) => {
      if (method === 'Accessibility.enable') return {};
      if (method === 'Accessibility.getFullAXTree') return AX_TREE;
      throw new Error(`unexpected command: ${method}`);
    });

    const result = await automation().snapshot('tab-1', harness.wc, {
      action: 'snapshot',
      interactive: true,
    });

    expect(result).toMatchObject({
      format: 'ai',
      targetId: 'tab-1',
      url: 'https://example.test/form',
      refs: {
        e1: { role: 'button', name: 'Submit', backendDOMNodeId: 2 },
        e2: { role: 'textbox', name: 'Email', backendDOMNodeId: 3 },
      },
      stats: { refs: 2, interactive: 2 },
    });
    expect(result.snapshot).toContain('- button "Submit" [ref=e1]');
    expect(result.snapshot).toContain('- textbox "Email" [ref=e2]');
    expect(harness.attach).toHaveBeenCalledWith('1.3');
    expect(harness.detach).toHaveBeenCalledTimes(1);
  });

  it('supports aria output, selector scoping and limits', async () => {
    const harness = debuggerHarness(async (method) => {
      if (method === 'Runtime.evaluate') return { result: { objectId: 'selector-object' } };
      if (method === 'DOM.describeNode') return { node: { backendNodeId: 2 } };
      if (method === 'Accessibility.enable') return {};
      if (method === 'Accessibility.getPartialAXTree') return AX_TREE;
      throw new Error(`unexpected command: ${method}`);
    });

    const result = await automation().snapshot('tab-1', harness.wc, {
      action: 'snapshot',
      snapshotFormat: 'aria',
      selector: '#form',
      limit: 1,
    });

    expect(result.format).toBe('aria');
    expect(result.nodes).toHaveLength(1);
    expect(harness.sendCommand).toHaveBeenCalledWith(
      'Accessibility.getPartialAXTree',
      { backendNodeId: 2, fetchRelatives: false },
    );
  });
});

describe('RsbWebviewAutomation act', () => {
  it('clicks a snapshot ref at the center of its DOM box', async () => {
    const instance = automation();
    let phase: 'snapshot' | 'click' = 'snapshot';
    const harness = debuggerHarness(async (method) => {
      if (phase === 'snapshot') {
        if (method === 'Accessibility.enable') return {};
        if (method === 'Accessibility.getFullAXTree') return AX_TREE;
      } else {
        if (method === 'DOM.resolveNode') return { object: { objectId: 'button-object' } };
        if (method === 'Runtime.callFunctionOn') return { result: { value: { ok: true } } };
        if (method === 'DOM.getBoxModel') {
          return { model: { content: [10, 20, 30, 20, 30, 40, 10, 40] } };
        }
      }
      throw new Error(`unexpected command during ${phase}: ${method}`);
    });
    await instance.snapshot('tab-1', harness.wc, {
      action: 'snapshot',
      interactive: true,
    });
    phase = 'click';
    harness.sendCommand.mockClear();

    const result = await instance.act('tab-1', harness.wc, {
      kind: 'click',
      ref: 'e1',
    });

    expect(result).toMatchObject({ tabId: 'tab-1', kind: 'click', x: 20, y: 30 });
    expect(harness.sendCommand).not.toHaveBeenCalledWith(
      'Input.dispatchMouseEvent',
      expect.anything(),
    );
    expect(harness.executeJavaScript).toHaveBeenCalledTimes(2);
    expect(harness.executeJavaScript.mock.calls[0][0]).toContain(
      '"method":"Input.dispatchMouseEvent","params":{"type":"mousePressed"',
    );
    expect(harness.executeJavaScript.mock.calls[0][1]).toBe(false);
    expect(harness.executeJavaScript.mock.calls[1][0]).toContain(
      '"method":"Input.dispatchMouseEvent","params":{"type":"mouseReleased"',
    );
    expect(harness.executeJavaScript.mock.calls[1][1]).toBe(true);
  });

  it('types into a selector and optionally submits', async () => {
    const harness = debuggerHarness(async (method) => {
      if (method === 'Runtime.evaluate') return { result: { objectId: 'input-object' } };
      if (method === 'DOM.describeNode') return { node: { backendNodeId: 5 } };
      if (method === 'Runtime.callFunctionOn') return { result: { value: { ok: true } } };
      throw new Error(`unexpected command: ${method}`);
    });

    const result = await automation().act('tab-1', harness.wc, {
      kind: 'type',
      selector: 'input[type=email]',
      text: 'hello@example.test',
      submit: true,
    });

    expect(result).toMatchObject({
      tabId: 'tab-1',
      kind: 'type',
      textLength: 18,
    });
    expect(harness.executeJavaScript).toHaveBeenCalledTimes(3);
    expect(harness.executeJavaScript.mock.calls[0][0]).toContain(
      '"method":"Input.insertText","params":{"text":"hello@example.test"}',
    );
    expect(harness.executeJavaScript.mock.calls[1][0]).toContain(
      '"method":"Input.dispatchKeyEvent","params":{"type":"keyDown","key":"Enter"',
    );
    expect(harness.sendCommand).not.toHaveBeenCalledWith(
      expect.stringMatching(/^Input\./),
      expect.anything(),
    );
  });

  it('dispatches coordinate clicks without requiring a snapshot', async () => {
    const harness = debuggerHarness(async (method) => {
      throw new Error(`unexpected command: ${method}`);
    });

    const result = await automation().act('tab-1', harness.wc, {
      kind: 'clickCoords',
      x: 12.5,
      y: 24,
      button: 'right',
    });

    expect(result).toMatchObject({ kind: 'clickCoords', x: 12.5, y: 24 });
    expect(harness.executeJavaScript.mock.calls[0][0]).toContain(
      '"method":"Input.dispatchMouseEvent","params":{"type":"mousePressed"',
    );
    expect(harness.executeJavaScript.mock.calls[0][0]).toContain(
      '"button":"right"',
    );
  });

  it('waits for page conditions inside the guest and returns observed state', async () => {
    const harness = debuggerHarness(async (method, params) => {
      if (method === 'Runtime.evaluate') {
        expect(params?.expression).toContain('"selector":"#ready"');
        return { result: { value: { url: 'https://example.test/form', readyState: 'complete' } } };
      }
      throw new Error(`unexpected command: ${method}`);
    });

    const result = await automation().act('tab-1', harness.wc, {
      kind: 'wait',
      selector: '#ready',
      loadState: 'load',
      timeoutMs: 500,
    });

    expect(result).toMatchObject({
      kind: 'wait',
      state: { url: 'https://example.test/form', readyState: 'complete' },
    });
  });

  it('rejects stale refs and still detaches the debugger', async () => {
    const harness = debuggerHarness(async () => {
      throw new Error('sendCommand should not run');
    });

    await expect(
      automation().act('tab-1', harness.wc, { kind: 'click', ref: 'e999' }),
    ).rejects.toThrow(/unknown or stale snapshot ref/);
    expect(harness.detach).toHaveBeenCalledTimes(1);
  });
});
