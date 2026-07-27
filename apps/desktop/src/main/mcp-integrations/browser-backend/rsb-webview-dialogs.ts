import type { WebContents } from 'electron';

interface DialogLogger {
  warn(message: string, ...args: unknown[]): void;
}

interface ElectronDebugger {
  isAttached(): boolean;
  attach(protocolVersion?: string): void;
  detach(): void;
  sendCommand(method: string, commandParams?: Record<string, unknown>): Promise<unknown>;
  on(event: string, listener: (...args: unknown[]) => void): void;
  removeListener(event: string, listener: (...args: unknown[]) => void): void;
}

export interface BrowserPageDialog {
  id: string;
  type: string;
  message: string;
  defaultValue?: string;
  openedAt: string;
}

interface DialogState {
  debugger: ElectronDebugger;
  ownedAttachment: boolean;
  enabled: boolean;
  pending?: BrowserPageDialog;
  messageHandler: (...args: unknown[]) => void;
  detachHandler: (...args: unknown[]) => void;
  destroyedHandler: (...args: unknown[]) => void;
}

const DEFAULT_WAIT_MS = 10_000;
const MAX_WAIT_MS = 60_000;
const MAX_DIALOG_TEXT = 16_000;
const MAX_PROMPT_TEXT = 32_000;

let dialogSequence = 0;

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function boundedText(value: unknown, max = MAX_DIALOG_TEXT): string {
  return text(value).slice(0, max);
}

function boundedWait(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.min(MAX_WAIT_MS, Math.floor(value))
    : DEFAULT_WAIT_MS;
}

function debuggerFor(wc: WebContents): ElectronDebugger {
  const candidate = (wc as unknown as { debugger?: ElectronDebugger }).debugger;
  if (!candidate) throw new Error('webContents debugger is unavailable');
  return candidate;
}

/**
 * Tracks JavaScript modal prompts for each embedded page and responds through
 * the page debugger. The monitor releases only attachments it created.
 */
export class RsbWebviewDialogs {
  private readonly states = new Map<WebContents, DialogState>();

  constructor(private readonly logger: DialogLogger) {}

  async observe(wc: WebContents): Promise<void> {
    let state = this.states.get(wc);
    if (!state) {
      state = this.createState(wc);
      this.states.set(wc, state);
    }
    if (state.enabled && state.debugger.isAttached()) return;
    if (!state.debugger.isAttached()) {
      state.debugger.attach('1.3');
      state.ownedAttachment = true;
    }
    await state.debugger.sendCommand('Page.enable');
    state.enabled = true;
  }

  pending(wc: WebContents): BrowserPageDialog | undefined {
    const dialog = this.states.get(wc)?.pending;
    return dialog ? { ...dialog } : undefined;
  }

  async respond(
    wc: WebContents,
    options: {
      dialogId?: string;
      accept?: boolean;
      promptText?: string;
      timeoutMs?: number;
    },
  ): Promise<BrowserPageDialog & { accepted: boolean }> {
    if (options.dialogId && options.dialogId.length > 256) {
      throw new Error('dialogId is too long');
    }
    if (
      typeof options.promptText === 'string'
      && options.promptText.length > MAX_PROMPT_TEXT
    ) {
      throw new Error(`promptText exceeds ${MAX_PROMPT_TEXT} characters`);
    }
    await this.observe(wc);
    const state = this.states.get(wc);
    if (!state) throw new Error('page dialog monitor unavailable');
    const deadline = Date.now() + boundedWait(options.timeoutMs);
    let dialog: BrowserPageDialog | undefined;
    for (;;) {
      const current = state.pending;
      if (current && (!options.dialogId || current.id === options.dialogId)) {
        dialog = current;
        break;
      }
      if (current && options.dialogId && current.id !== options.dialogId) {
        throw new Error(`dialog ${options.dialogId} is no longer pending`);
      }
      if (Date.now() >= deadline) throw new Error('no page dialog is pending');
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    const accepted = options.accept === true;
    await state.debugger.sendCommand('Page.handleJavaScriptDialog', {
      accept: accepted,
      ...(accepted && typeof options.promptText === 'string'
        ? { promptText: options.promptText }
        : {}),
    });
    if (state.pending?.id === dialog.id) state.pending = undefined;
    return { ...dialog, accepted };
  }

  diagnostics(): { observedTabs: number; pendingDialogs: number } {
    let pendingDialogs = 0;
    for (const state of this.states.values()) {
      if (state.pending) pendingDialogs += 1;
    }
    return { observedTabs: this.states.size, pendingDialogs };
  }

  dispose(): void {
    for (const wc of [...this.states.keys()]) this.release(wc);
  }

  private createState(wc: WebContents): DialogState {
    const electronDebugger = debuggerFor(wc);
    const state: DialogState = {
      debugger: electronDebugger,
      ownedAttachment: false,
      enabled: false,
      messageHandler: () => {},
      detachHandler: () => {},
      destroyedHandler: () => {},
    };
    state.messageHandler = (...args: unknown[]) => {
      try {
        const method = text(args[1]);
        const params = args[2] && typeof args[2] === 'object'
          ? args[2] as Record<string, unknown>
          : {};
        if (method === 'Page.javascriptDialogOpening') {
          dialogSequence += 1;
          state.pending = {
            id: `page-dialog-${Date.now().toString(36)}-${dialogSequence.toString(36)}`,
            type: boundedText(params.type, 64) || 'alert',
            message: boundedText(params.message),
            ...(boundedText(params.defaultPrompt)
              ? { defaultValue: boundedText(params.defaultPrompt) }
              : {}),
            openedAt: new Date().toISOString(),
          };
        } else if (method === 'Page.javascriptDialogClosed') {
          state.pending = undefined;
        }
      } catch (err) {
        this.logger.warn('RSB page dialog event handler failed', err);
      }
    };
    state.detachHandler = () => {
      state.enabled = false;
      state.ownedAttachment = false;
    };
    state.destroyedHandler = () => this.release(wc);
    electronDebugger.on('message', state.messageHandler);
    electronDebugger.on('detach', state.detachHandler);
    (wc as unknown as {
      once?: (event: string, listener: (...args: unknown[]) => void) => void;
    }).once?.('destroyed', state.destroyedHandler);
    return state;
  }

  private release(wc: WebContents): void {
    const state = this.states.get(wc);
    if (!state) return;
    this.states.delete(wc);
    try {
      state.debugger.removeListener('message', state.messageHandler);
      state.debugger.removeListener('detach', state.detachHandler);
    } catch {
      // The guest may already be destroyed.
    }
    if (state.ownedAttachment) {
      try {
        if (state.debugger.isAttached()) state.debugger.detach();
      } catch {
        // Detach is best effort during teardown.
      }
    }
  }
}
