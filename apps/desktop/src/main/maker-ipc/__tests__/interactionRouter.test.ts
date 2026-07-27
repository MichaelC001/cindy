import { describe, expect, it, vi } from 'vitest';
import type { InteractionDecision, InteractionRequest } from '@cindy/maker-core';

import {
  beginInteractionRoute,
  installDesktopInteractionHandler,
  type InteractionHandler,
} from '../interactionRouter';

function permission(requestId: string): InteractionRequest {
  return {
    kind: 'permission',
    requestId,
    toolName: 'Read',
    input: {},
  } as InteractionRequest;
}

function ask(requestId: string): InteractionRequest {
  return {
    kind: 'ask_user_question',
    requestId,
    questions: [{ question: 'Which?', options: [] }],
  } as InteractionRequest;
}

function makeSession() {
  let listener: InteractionHandler | null = null;
  const setInteractionListener = vi.fn((next: InteractionHandler | null) => {
    listener = next;
  });
  return {
    session: { id: 'session-1', setInteractionListener },
    setInteractionListener,
    dispatch: (request: InteractionRequest) => {
      if (!listener) throw new Error('listener not installed');
      return listener(request);
    },
  };
}

describe('session interaction router', () => {
  it('owns one listener and falls back to the Desktop handler', async () => {
    const harness = makeSession();
    const desktop = vi.fn(async (): Promise<InteractionDecision> => ({
      kind: 'permission',
      behavior: 'allow',
    }));

    installDesktopInteractionHandler(harness.session, desktop);
    installDesktopInteractionHandler(harness.session, desktop);

    await expect(harness.dispatch(permission('desktop-1'))).resolves.toMatchObject({
      behavior: 'allow',
    });
    expect(harness.setInteractionListener).toHaveBeenCalledTimes(1);
    expect(desktop).toHaveBeenCalledTimes(1);
  });

  it('routes only the admitted turn to its channel surface', async () => {
    const harness = makeSession();
    const desktop = vi.fn(async (): Promise<InteractionDecision> => ({
      kind: 'permission',
      behavior: 'deny',
      reason: 'desktop',
    }));
    const channel = vi.fn(async (): Promise<InteractionDecision> => ({
      kind: 'permission',
      behavior: 'allow',
    }));
    installDesktopInteractionHandler(harness.session, desktop);

    const lease = beginInteractionRoute(harness.session, {
      route: {
        sessionId: 'session-1',
        turnId: 'feishu-turn-1',
        origin: { kind: 'im', channel: 'feishu' },
        interactionSurface: 'channel-card',
      },
      handle: channel,
    });

    await expect(harness.dispatch(permission('channel-1'))).resolves.toMatchObject({
      behavior: 'allow',
    });
    lease.release();
    await expect(harness.dispatch(permission('desktop-2'))).resolves.toMatchObject({
      reason: 'desktop',
    });
    expect(channel).toHaveBeenCalledTimes(1);
    expect(desktop).toHaveBeenCalledTimes(1);
    expect(harness.setInteractionListener).toHaveBeenCalledTimes(1);
  });

  it('cancels pending requests with a kind-correct safe decision on release', async () => {
    const harness = makeSession();
    let keepPending!: () => void;
    const never = new Promise<void>((resolve) => {
      keepPending = resolve;
    });
    const onCancel = vi.fn();
    const states: string[] = [];
    const lease = beginInteractionRoute(harness.session, {
      route: {
        sessionId: 'session-1',
        turnId: 'slack-turn-1',
        origin: { kind: 'im', channel: 'slack' },
        interactionSurface: 'channel-card',
        onStateChange: (state) => states.push(state),
      },
      handle: async () => {
        await never;
        return { kind: 'ask_user_question', answers: { Which: 'late' } };
      },
      onCancel,
    });

    const decision = harness.dispatch(ask('ask-1'));
    await vi.waitFor(() => expect(states).toEqual(['waiting']));
    lease.release('turn_terminal');

    await expect(decision).resolves.toEqual({
      kind: 'ask_user_question',
      answers: {},
    });
    expect(onCancel).toHaveBeenCalledWith('ask-1', {
      kind: 'ask_user_question',
      answers: {},
    });
    expect(states).toEqual(['waiting', 'cancelled']);
    keepPending();
  });

  it('rejects overlapping routes before provider dispatch', () => {
    const harness = makeSession();
    const handle = vi.fn(async (): Promise<InteractionDecision> => ({
      kind: 'permission',
      behavior: 'allow',
    }));
    const first = beginInteractionRoute(harness.session, {
      route: {
        sessionId: 'session-1',
        turnId: 'turn-1',
        origin: { kind: 'hook', source: 'slack' },
        interactionSurface: 'channel-card',
      },
      handle,
    });

    expect(() =>
      beginInteractionRoute(harness.session, {
        route: {
          sessionId: 'session-1',
          turnId: 'turn-2',
          origin: { kind: 'im', channel: 'discord' },
          interactionSurface: 'channel-card',
        },
        handle,
      }),
    ).toThrow(/already active/);

    first.release();
  });
});
