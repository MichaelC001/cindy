import { createHash, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import {
  BaseIM,
  type IMCardActionEvent,
  type IMHost,
  type IMMessageEvent,
  type IMStatus,
  type RichChannelIM,
  type SendFileResult,
  type StreamingTextHandle,
} from '@cindy/im';
import {
  asWechatIlinkError,
  chunkWechatText,
  filterWechatMarkdown,
  WECHAT_MEDIA_MAX_BYTES,
  type WechatAuthorizationEvent,
  type WechatCredentials,
  type WechatInboundMessage,
  type WechatTransport,
} from '@cindy/wechat-ilink';

import type { ImSessionRepo } from '../shared/sessionRepo';
import type { ImOrchestratorConfig } from '../shared/types';
import type { ImFinalOutput } from '@cindy/im';
import type { ImTurnRunner } from '../shared/turnRunner';
import { createWechatTurnPermissionPolicy } from './permissionPolicy';
import { WechatTaskStore, type WechatActiveBinding, type WechatTask } from './taskStore';
import type { DbClient } from '../../localDb/client/DbClient';
import {
  removeUncommittedWechatFiles,
  removeReleasedWechatFiles,
  stageWechatTaskMedia,
  type WechatTaskAttachment,
} from './mediaStaging';

const CREDENTIAL_PREFIX = 'wechat_credentials_';
const DATA_KEY_NAME = 'wechat_data_key_v1';
const AUTH_BASE_URL = 'https://ilinkai.weixin.qq.com';
const EMPTY_POLL_DELAY_MS = 100;
const IDLE_PUMP_DELAY_MS = 200;
const RECONNECT_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000] as const;

export type WechatBotPhase =
  | 'disconnected'
  | 'authorizing'
  | 'waiting_confirmation'
  | 'connected'
  | 'reconnecting'
  | 'needs_reauth'
  | 'disabled_by_policy'
  | 'error';

export interface WechatBotState {
  phase: WechatBotPhase;
  bound: boolean;
  connectedAt?: number;
  lastInboundAt?: number;
  queuedTasks: number;
  errorCode?: string;
}

interface StoredWechatCredentials {
  botToken: string;
  ilinkBotId: string;
  userId: string;
  baseUrl: string;
  boundAt: number;
  bindingEpoch: string;
}

interface WechatTaskPayload {
  text: string;
  attachments: WechatTaskAttachment[];
  unsupportedMedia: string[];
}

interface ActiveTask {
  task: WechatTask;
  terminalCommitted: boolean;
}

interface TurnRuntime {
  runner: ImTurnRunner;
  repo: ImSessionRepo;
  config: ImOrchestratorConfig;
  resetSessionToDefaults(
    sessionId: string,
    config: ImOrchestratorConfig,
    prepared: Awaited<ReturnType<ImSessionRepo['prepareNewSession']>>,
  ): Promise<void>;
}

export interface WechatIMDeps {
  host: IMHost;
  getDbClient(): DbClient;
  createTransport(args: {
    credentials: StoredWechatCredentials | null;
    onAuthorizationEvent?: (event: WechatAuthorizationEvent) => void;
  }): WechatTransport;
  openAuthorizationUrl(url: string): Promise<void>;
  captureAccountGeneration(): number | null;
  isAccountGenerationCurrent(generation: number): boolean;
  now?: () => number;
}

/**
 * Main-process personal WeChat connector.
 *
 * The class implements the rich interface only because the existing shared
 * turn runner still carries legacy card methods in its adapter type. Its
 * output driver is always `chunked-text`; every card method fails loudly so a
 * future regression cannot silently send a fake card over personal WeChat.
 */
export class WechatIM extends BaseIM implements RichChannelIM {
  readonly #deps: WechatIMDeps;
  readonly #statusHandlers = new Set<(status: IMStatus) => void>();
  readonly #messageHandlers = new Set<(event: IMMessageEvent) => void>();
  readonly #activeTasks = new Map<string, ActiveTask>();
  #state: Omit<WechatBotState, 'bound'> = { phase: 'disconnected', queuedTasks: 0 };
  #hasBinding = false;
  #store: WechatTaskStore | null = null;
  #turnRuntime: TurnRuntime | null = null;
  #epoch: {
    binding: WechatActiveBinding;
    credentials: StoredWechatCredentials;
    transport: WechatTransport;
    abort: AbortController;
    drain: Promise<void>;
    generation: number;
  } | null = null;
  #authorizationAbort: AbortController | null = null;
  #pollBarrier: Promise<void> = Promise.resolve();

  constructor(deps: WechatIMDeps) {
    super('wechat', deps.host);
    this.#deps = deps;
  }

  attachTurnRuntime(runtime: TurnRuntime): void {
    if (this.#turnRuntime) throw new Error('WeChat turn runtime already attached.');
    this.#turnRuntime = runtime;
  }

  getState(): WechatBotState {
    return { ...this.#state, bound: this.#hasBinding };
  }

  async init(): Promise<void> {
    if (this.#store) return;
    const active = await this.#readActiveBindingWithoutKey();
    if (!active) {
      this.#hasBinding = false;
      this.#setState({ phase: 'disconnected', queuedTasks: 0 });
      return;
    }
    this.#hasBinding = true;
    const key = this.#readDataKey();
    const credentials = this.#readCredentials(active.bindingEpoch);
    if (!key || !credentials) {
      this.#setState({
        phase: 'needs_reauth',
        queuedTasks: 0,
        errorCode: 'credentials_missing',
      });
      return;
    }
    this.#store = new WechatTaskStore(this.#deps.getDbClient(), key);
    await this.#store.stopAll({
      bindingEpoch: active.bindingEpoch,
      now: this.#now(),
      errorCode: 'PROCESS_RESTARTED',
    });
    await this.#startEpoch(active, credentials);
  }

  async dispose(): Promise<void> {
    this.cancelAuthorization();
    await this.#stopEpoch();
    this.#store?.destroy();
    this.#store = null;
    this.#activeTasks.clear();
    this.#hasBinding = false;
    this.#setState({ phase: 'disconnected', queuedTasks: 0 });
  }

  registerIpc(): void {
    // Registered in Desktop Main with a trusted-renderer sender check.
  }

  async authorize(): Promise<{ started: true }> {
    if (!this.host.secrets.isAvailable()) {
      throw new Error('WECHAT_SAFE_STORAGE_UNAVAILABLE');
    }
    const generation = this.#deps.captureAccountGeneration();
    if (generation === null) throw new Error('WECHAT_ACCOUNT_SCOPE_CLOSED');
    this.cancelAuthorization();
    const abort = new AbortController();
    this.#authorizationAbort = abort;
    this.#setState({ ...this.#state, phase: 'authorizing', errorCode: undefined });
    const transport = this.#deps.createTransport({
      credentials: null,
      onAuthorizationEvent: (event) => {
        if (event.status === 'waiting' || event.status === 'scanned') {
          this.#setState({ ...this.#state, phase: 'waiting_confirmation' });
        } else if (event.status === 'qr-refreshed') {
          void this.#deps.openAuthorizationUrl(event.challenge.qrCodeUrl);
        }
      },
    });

    void (async () => {
      try {
        const challenge = await transport.beginAuthorization(abort.signal);
        if (!this.#isGenerationCurrent(generation)) return;
        this.#setState({ ...this.#state, phase: 'waiting_confirmation' });
        await this.#deps.openAuthorizationUrl(challenge.qrCodeUrl);
        const credentials = await transport.waitAuthorization(challenge, abort.signal);
        if (!this.#isGenerationCurrent(generation)) return;
        await this.#activateAuthorizedCredentials(credentials, generation);
      } catch (error) {
        const safe = asWechatIlinkError(error);
        if (safe.code !== 'ABORTED' && this.#isGenerationCurrent(generation)) {
          this.#setState({
            ...this.#state,
            phase: safe.code === 'AUTH_REPLACED' ? 'needs_reauth' : 'error',
            errorCode: safe.code.toLowerCase(),
          });
        }
      } finally {
        if (this.#authorizationAbort === abort) this.#authorizationAbort = null;
      }
    })();
    return { started: true };
  }

  cancelAuthorization(): void {
    this.#authorizationAbort?.abort();
    this.#authorizationAbort = null;
    if (this.#state.phase === 'authorizing' || this.#state.phase === 'waiting_confirmation') {
      this.#setState({ ...this.#state, phase: this.#epoch ? 'connected' : 'disconnected' });
    }
  }

  async unbind(): Promise<void> {
    const active = this.#epoch?.binding ?? (await this.#readActiveBindingWithoutKey());
    if (!active) {
      this.#setState({ phase: 'disconnected', queuedTasks: 0 });
      return;
    }
    const store = this.#store;
    if (!store) throw new Error('WECHAT_DATA_KEY_UNAVAILABLE');
    await store.closeBindingEpoch(active.bindingEpoch, this.#now());
    await this.#stopEpoch();
    const cleanup = await store.unbindCleanup(active.bindingEpoch);
    await removeReleasedWechatFiles(cleanup.filePaths);
    this.host.secrets.remove(`${CREDENTIAL_PREFIX}${active.bindingEpoch}`);
    this.host.secrets.remove(DATA_KEY_NAME);
    store.destroy();
    this.#store = null;
    this.#hasBinding = false;
    this.#setState({ phase: 'disconnected', queuedTasks: 0 });
  }

  onMessage(handler: (event: IMMessageEvent) => void): () => void {
    this.#messageHandlers.add(handler);
    return () => this.#messageHandlers.delete(handler);
  }

  onStatusChange(handler: (status: IMStatus) => void): () => void {
    this.#statusHandlers.add(handler);
    return () => this.#statusHandlers.delete(handler);
  }

  onCardAction(handler: (event: IMCardActionEvent) => void): () => void {
    void handler;
    return () => undefined;
  }

  getStatus(): IMStatus {
    if (this.#state.phase === 'connected') {
      return { kind: 'connected', appId: this.#epoch?.credentials.ilinkBotId ?? 'wechat' };
    }
    if (
      this.#state.phase === 'authorizing' ||
      this.#state.phase === 'waiting_confirmation' ||
      this.#state.phase === 'reconnecting'
    ) {
      return { kind: 'connecting' };
    }
    if (this.#state.phase === 'error' || this.#state.phase === 'needs_reauth') {
      return { kind: 'error', reason: this.#state.errorCode ?? 'wechat_error' };
    }
    return { kind: 'idle' };
  }

  async sendText(userId: string, text: string): Promise<{ messageId: string }> {
    const active = this.#activeTasks.get(userId);
    const epoch = this.#epoch;
    if (!active || !epoch) throw new Error('WECHAT_NO_ACTIVE_CONTEXT');
    const clientId = randomUUID();
    await epoch.transport.sendMessage(
      {
        peerId: userId,
        text,
        contextToken: active.task.contextToken,
        clientId,
      },
      epoch.abort.signal,
    );
    return { messageId: clientId };
  }

  sendMarkdownText(userId: string, markdown: string): Promise<{ messageId: string }> {
    return this.sendText(userId, filterWechatMarkdown(markdown));
  }

  async sendFile(userId: string, absPath: string, displayName?: string): Promise<SendFileResult> {
    const active = this.#activeTasks.get(userId);
    const epoch = this.#epoch;
    if (!active || !epoch) return { ok: false, reason: 'SEND_FAIL' };
    let uploadedSuccessfully = false;
    try {
      const local = await readOutboundWechatFile(absPath, displayName);
      const uploaded = await epoch.transport.uploadMedia(
        {
          peerId: userId,
          bytes: local.bytes,
          fileName: local.fileName,
          kind: local.kind,
        },
        epoch.abort.signal,
      );
      uploadedSuccessfully = true;
      const clientId = randomUUID();
      await epoch.transport.sendMedia(
        {
          peerId: userId,
          contextToken: active.task.contextToken,
          clientId,
          uploaded,
        },
        epoch.abort.signal,
      );
      return { ok: true, messageId: clientId };
    } catch (error) {
      const code =
        error instanceof Error && 'code' in error
          ? String((error as NodeJS.ErrnoException).code)
          : '';
      if (code === 'ENOENT') return { ok: false, reason: 'NOT_FOUND' };
      if (code === 'WECHAT_FILE_EMPTY') return { ok: false, reason: 'EMPTY' };
      if (code === 'WECHAT_FILE_TOO_LARGE') return { ok: false, reason: 'TOO_LARGE' };
      return { ok: false, reason: uploadedSuccessfully ? 'SEND_FAIL' : 'UPLOAD_FAIL' };
    }
  }

  sendInteractiveCard(): Promise<{ messageId: string }> {
    return Promise.reject(new Error('WECHAT_RICH_OUTPUT_UNSUPPORTED'));
  }

  updateInteractiveCard(): Promise<void> {
    return Promise.reject(new Error('WECHAT_RICH_OUTPUT_UNSUPPORTED'));
  }

  patchMarkdownCard(): Promise<void> {
    return Promise.reject(new Error('WECHAT_RICH_OUTPUT_UNSUPPORTED'));
  }

  startStreamingText(
    userId: string,
    initial?: string,
    opts?: { threadTs?: string },
  ): Promise<StreamingTextHandle> {
    void userId;
    void initial;
    void opts;
    return Promise.reject(new Error('WECHAT_RICH_OUTPUT_UNSUPPORTED'));
  }

  async commitFinal(output: ImFinalOutput): Promise<void> {
    const active = this.#activeTasks.get(output.userId);
    if (!active) throw new Error('WECHAT_NO_ACTIVE_TASK');
    const text = filterWechatMarkdown(output.text);
    const chunks = chunkWechatText(text || '（本轮无文本输出）');
    const kind =
      output.terminal === 'done'
        ? ('final' as const)
        : output.terminal === 'aborted'
          ? ('interrupted' as const)
          : ('error' as const);
    const result = await this.#requireStore().commitTerminal({
      bindingEpoch: active.task.bindingEpoch,
      taskId: active.task.id,
      now: this.#now(),
      outbox: chunks.map((chunk, index) => ({
        id: randomUUID(),
        clientId: randomUUID(),
        kind,
        chunkIndex: index,
        text: chunk,
        ...(index === 0 && output.mediaAbsPaths?.length
          ? {
              mediaJson: JSON.stringify(
                output.mediaAbsPaths.slice(0, 4).map((absPath) => ({
                  absPath,
                  clientId: randomUUID(),
                })),
              ),
            }
          : {}),
      })),
    });
    if (!result.committed) throw new Error('WECHAT_TERMINAL_COMMIT_REJECTED');
    active.terminalCommitted = true;
  }

  async onUserMessagePersisted(args: {
    sessionId: string;
    userMessageId: string | null;
    persisted: boolean;
  }): Promise<void> {
    const bindingEpoch = this.#epoch?.binding.bindingEpoch;
    if (!args.persisted || !args.userMessageId || !bindingEpoch) return;
    try {
      await this.#requireStore().promoteTaskAttachments({
        bindingEpoch,
        taskId: args.userMessageId,
        sessionId: args.sessionId,
        now: this.#now(),
      });
    } catch (error) {
      this.log.warn('WeChat attachment promotion requires repair', {
        task: shortId(args.userMessageId),
        code: machineErrorCode(error),
      });
    }
  }

  async #activateAuthorizedCredentials(raw: WechatCredentials, generation: number): Promise<void> {
    if (!this.#isGenerationCurrent(generation)) return;
    const bindingEpoch = randomUUID();
    const stored: StoredWechatCredentials = {
      botToken: raw.token,
      ilinkBotId: raw.botId,
      userId: raw.userId,
      baseUrl: raw.baseUrl,
      boundAt: this.#now(),
      bindingEpoch,
    };
    const key = this.#readDataKey() ?? randomBytes(32);
    if (!this.host.secrets.write(DATA_KEY_NAME, Buffer.from(key).toString('base64'))) {
      throw new Error('WECHAT_DATA_KEY_WRITE_FAILED');
    }
    if (!this.host.secrets.write(`${CREDENTIAL_PREFIX}${bindingEpoch}`, JSON.stringify(stored))) {
      throw new Error('WECHAT_CREDENTIAL_WRITE_FAILED');
    }
    const store = this.#store ?? new WechatTaskStore(this.#deps.getDbClient(), key);
    this.#store = store;
    const previous = await store.getActiveBinding();
    const activated = await store.activateBindingEpoch({
      bindingEpoch,
      expectedActiveEpoch: previous?.bindingEpoch ?? null,
      now: this.#now(),
    });
    if (!activated.activated || !this.#isGenerationCurrent(generation)) {
      this.host.secrets.remove(`${CREDENTIAL_PREFIX}${bindingEpoch}`);
      throw new Error('WECHAT_BINDING_EPOCH_STALE');
    }
    this.#hasBinding = true;
    await this.#stopEpoch();
    if (previous) {
      await store.closeBindingEpoch(previous.bindingEpoch, this.#now());
      await store.unbindCleanup(previous.bindingEpoch);
      this.host.secrets.remove(`${CREDENTIAL_PREFIX}${previous.bindingEpoch}`);
    }
    await this.#startEpoch({ bindingEpoch, cursor: '' }, stored);
  }

  async #startEpoch(
    binding: WechatActiveBinding,
    credentials: StoredWechatCredentials,
  ): Promise<void> {
    const generation = this.#deps.captureAccountGeneration();
    if (generation === null) throw new Error('WECHAT_ACCOUNT_SCOPE_CLOSED');
    const abort = new AbortController();
    const transport = this.#deps.createTransport({ credentials });
    const drain = Promise.allSettled([
      this.#pollLoop(binding, transport, abort.signal, generation),
      this.#taskPump(binding, abort.signal, generation),
      this.#outboxLoop(binding, transport, abort.signal, generation),
    ]).then(() => undefined);
    this.#epoch = { binding, credentials, transport, abort, drain, generation };
    this.#setState({
      phase: 'connected',
      connectedAt: this.#now(),
      queuedTasks: await this.#requireStore().countQueuedTasks(binding.bindingEpoch),
    });
  }

  async #stopEpoch(): Promise<void> {
    const epoch = this.#epoch;
    this.#epoch = null;
    if (!epoch) return;
    epoch.abort.abort();
    await epoch.drain;
    this.#activeTasks.clear();
  }

  async #pollLoop(
    binding: WechatActiveBinding,
    transport: WechatTransport,
    signal: AbortSignal,
    generation: number,
  ): Promise<void> {
    let cursor = binding.cursor;
    let failures = 0;
    while (!signal.aborted && this.#isGenerationCurrent(generation)) {
      try {
        const result = await transport.poll(cursor, signal);
        const now = this.#now();
        const preparedInputs = await Promise.all(
          result.messages.map((message, index) =>
            this.#toTaskInput(binding.bindingEpoch, message, transport, signal, now, index),
          ),
        );
        const inputs = preparedInputs.map((input) => input.message);
        const mediaBlobs = preparedInputs.flatMap((input) => input.mediaBlobs);
        const mediaRefs = preparedInputs.flatMap((input) => input.mediaRefs);
        const fileAttachments = preparedInputs.flatMap((input) => input.fileAttachments);
        let releasePollBarrier!: () => void;
        this.#pollBarrier = new Promise<void>((resolve) => {
          releasePollBarrier = resolve;
        });
        let committed;
        try {
          committed = await this.#requireStore().commitPollBatch({
            bindingEpoch: binding.bindingEpoch,
            expectedCursor: cursor,
            nextCursor: result.cursor,
            now,
            messages: inputs,
            mediaBlobs,
            mediaRefs,
            fileAttachments,
          });
          await removeUncommittedWechatFiles(
            fileAttachments,
            new Set(committed.committed ? committed.insertedTaskIds : []),
          );
          if (committed.committed) {
            for (const message of result.messages) {
              await this.#requireStore().refreshPendingOutboxContext({
                bindingEpoch: binding.bindingEpoch,
                peerId: message.senderId,
                contextToken: message.contextToken,
                now,
              });
            }
          }
          if (committed.committed) {
            for (let index = 0; index < result.messages.length; index += 1) {
              const message = result.messages[index];
              const task = inputs[index];
              const command = message?.text.trim();
              if (!message || !task || (command !== '/stop' && command !== '/stop all')) {
                continue;
              }
              await this.#requireStore().cancelForCommand({
                bindingEpoch: binding.bindingEpoch,
                commandTaskId: task.id,
                ...(command === '/stop' ? { peerId: message.senderId } : {}),
                now,
              });
              if (command === '/stop all') {
                await this.#turnRuntime?.runner.disposeAllSessions();
              } else {
                await this.#turnRuntime?.runner.stopActiveTurn({
                  botContextId: this.#epoch?.credentials.ilinkBotId ?? '',
                  userId: message.senderId,
                });
              }
            }
          }
        } finally {
          releasePollBarrier();
        }
        if (!committed.committed) return;
        cursor = result.cursor;
        failures = 0;
        if (result.messages.length > 0) {
          this.#setState({
            ...this.#state,
            phase: 'connected',
            lastInboundAt: now,
            queuedTasks: await this.#requireStore().countQueuedTasks(binding.bindingEpoch),
          });
        } else {
          await delay(EMPTY_POLL_DELAY_MS, signal);
        }
      } catch (error) {
        if (signal.aborted) return;
        const safe = asWechatIlinkError(error);
        if (safe.code === 'AUTH_REPLACED' || safe.code === 'AUTH_EXPIRED') {
          this.#setState({
            ...this.#state,
            phase: 'needs_reauth',
            errorCode: safe.code.toLowerCase(),
          });
          return;
        }
        if (!safe.retryable) {
          this.#setState({
            ...this.#state,
            phase: 'error',
            errorCode: safe.code.toLowerCase(),
          });
          return;
        }
        this.#setState({
          ...this.#state,
          phase: 'reconnecting',
          errorCode: safe.code.toLowerCase(),
        });
        const backoff = RECONNECT_DELAYS_MS[Math.min(failures, RECONNECT_DELAYS_MS.length - 1)];
        failures += 1;
        await delay(withJitter(backoff), signal);
      }
    }
  }

  async #taskPump(
    binding: WechatActiveBinding,
    signal: AbortSignal,
    generation: number,
  ): Promise<void> {
    while (!signal.aborted && this.#isGenerationCurrent(generation)) {
      await this.#pollBarrier;
      const task = await this.#requireStore().leaseNextTask({
        bindingEpoch: binding.bindingEpoch,
        now: this.#now(),
      });
      if (!task) {
        await delay(IDLE_PUMP_DELAY_MS, signal);
        continue;
      }
      try {
        await this.#processTask(task);
      } catch (error) {
        this.log.warn('WeChat task processing failed', {
          task: shortId(task.id),
          code: machineErrorCode(error),
        });
        const interrupted = await this.#requireStore().commitInterrupted({
          bindingEpoch: task.bindingEpoch,
          taskId: task.id,
          now: this.#now(),
          errorCode: machineErrorCode(error),
        });
        if (!interrupted) {
          await this.#requireStore().releaseDispatch(task.bindingEpoch, task.id);
        }
      }
      this.#setState({
        ...this.#state,
        queuedTasks: await this.#requireStore().countQueuedTasks(binding.bindingEpoch),
      });
    }
  }

  async #processTask(task: WechatTask): Promise<void> {
    const runtime = this.#turnRuntime;
    if (!runtime) throw new Error('WECHAT_TURN_RUNTIME_NOT_ATTACHED');
    const payload = parseTaskPayload(task.payloadJson);
    const command = payload.text.trim();
    if (command.startsWith('/')) {
      await this.#processCommand(task, command);
      return;
    }
    const prompt =
      payload.unsupportedMedia.length > 0
        ? `${payload.text}\n\n（微信消息还包含当前版本暂不支持的媒体，本轮仅处理文字。）`
        : payload.text;
    if (!prompt.trim()) {
      await this.#commitSimpleReply(task, '当前版本暂不支持处理这类微信媒体。');
      return;
    }

    const active: ActiveTask = { task, terminalCommitted: false };
    this.#activeTasks.set(task.peerId, active);
    const stopTyping = await this.#startTyping(task);
    let dispatch;
    try {
      dispatch = await runtime.runner.dispatchAgentTurn({
        botContextId: this.#epoch?.credentials.ilinkBotId ?? '',
        userId: task.peerId,
        userMessageId: task.id,
        text: prompt,
        attachments: payload.attachments,
        queueMode: 'external',
        beforeProviderStart: async () => {
          const accepted = await this.#requireStore().markAccepted(task.bindingEpoch, task.id);
          if (!accepted) throw new Error('WECHAT_ACCEPT_CAS_REJECTED');
        },
        turnPermissionPolicy: createWechatTurnPermissionPolicy(task.id, {
          onInteractionStateChange: (state) => {
            if (state === 'waiting') {
              void this.#requireStore().setWaitingDesktop(task.bindingEpoch, task.id, true);
              void this.sendText(task.peerId, '任务正在等待你在 Cindy 桌面端确认。').catch(
                () => undefined,
              );
            } else {
              void this.#requireStore().setWaitingDesktop(task.bindingEpoch, task.id, false);
            }
          },
        }),
      });
    } catch (error) {
      await stopTyping();
      throw error;
    }

    if (dispatch.kind !== 'accepted') {
      await stopTyping();
      this.#activeTasks.delete(task.peerId);
      if (dispatch.kind === 'busy') {
        await this.#requireStore().releaseDispatch(task.bindingEpoch, task.id);
        await delay(IDLE_PUMP_DELAY_MS);
      } else {
        await this.#commitPreDispatchFailure(task, dispatch.reason);
      }
      return;
    }
    let terminal;
    try {
      terminal = await dispatch.terminal;
    } finally {
      await stopTyping();
    }
    this.#activeTasks.delete(task.peerId);
    if (!active.terminalCommitted) {
      await this.#requireStore().commitInterrupted({
        bindingEpoch: task.bindingEpoch,
        taskId: task.id,
        now: this.#now(),
        errorCode: safeMachineCode(terminal.errorCode ?? 'terminal_output_missing'),
      });
    }
    await this.#flushOutbox(this.#epoch?.transport, task.bindingEpoch);
  }

  async #startTyping(task: WechatTask): Promise<() => Promise<void>> {
    const epoch = this.#epoch;
    if (!epoch) return async () => undefined;
    let ticket: string;
    try {
      ticket = await epoch.transport.getTypingTicket(
        task.peerId,
        task.contextToken,
        epoch.abort.signal,
      );
      await epoch.transport.setTyping(task.peerId, ticket, true, epoch.abort.signal);
    } catch {
      return async () => undefined;
    }

    let stopped = false;
    let busy = false;
    let nextHeartbeatAt = this.#now() + 60_000;
    const timer = setInterval(() => {
      if (stopped || busy || epoch.abort.signal.aborted) return;
      busy = true;
      void (async () => {
        try {
          await epoch.transport.setTyping(task.peerId, ticket, true, epoch.abort.signal);
          if (this.#now() >= nextHeartbeatAt) {
            await epoch.transport.sendMessage(
              {
                peerId: task.peerId,
                text: '任务仍在处理中…',
                contextToken: task.contextToken,
                clientId: randomUUID(),
              },
              epoch.abort.signal,
            );
            nextHeartbeatAt = this.#now() + 120_000;
          }
        } catch {
          // Presence is best effort and must never fail the task.
        } finally {
          busy = false;
        }
      })();
    }, 5_000);
    timer.unref?.();

    return async () => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      try {
        await epoch.transport.setTyping(task.peerId, ticket, false, epoch.abort.signal);
      } catch {
        // Best-effort presence cleanup.
      }
    };
  }

  async #processCommand(task: WechatTask, command: string): Promise<void> {
    const runtime = this.#turnRuntime;
    if (!runtime) throw new Error('WECHAT_TURN_RUNTIME_NOT_ATTACHED');
    switch (command) {
      case '/help':
        await this.#commitSimpleReply(
          task,
          '可用命令：/new 新对话；/stop 停止当前任务；/stop all 停止全部任务；/status 查看状态；/help 查看帮助。',
        );
        return;
      case '/status':
        await this.#commitSimpleReply(
          task,
          `Cindy 微信连接正常，当前队列 ${this.#state.queuedTasks} 条。`,
        );
        return;
      case '/stop':
      case '/stop all':
        await this.#commitSimpleReply(task, '已停止任务。');
        return;
      case '/new': {
        const accepted = await this.#requireStore().markAccepted(task.bindingEpoch, task.id);
        if (!accepted) throw new Error('WECHAT_ACCEPT_CAS_REJECTED');
        const prepared = await runtime.repo.prepareNewSession(
          this.#epoch?.credentials.ilinkBotId ?? '',
          task.peerId,
        );
        const existing = await runtime.repo.findActiveSession(
          this.#epoch?.credentials.ilinkBotId ?? '',
          task.peerId,
        );
        const row =
          existing ??
          (await runtime.repo.createSession(
            this.#epoch?.credentials.ilinkBotId ?? '',
            task.peerId,
            undefined,
            prepared,
          ));
        if (existing) {
          await runtime.resetSessionToDefaults(row.id, runtime.config, prepared);
        }
        await runtime.runner.disposeOneSession(row.id);
        await this.#requireStore().advanceConversationEpoch(
          task.bindingEpoch,
          task.id,
          task.peerId,
        );
        const active: ActiveTask = { task, terminalCommitted: false };
        this.#activeTasks.set(task.peerId, active);
        await this.commitFinal({
          userId: task.peerId,
          text: '已开始一段新对话。',
          terminal: 'done',
        });
        this.#activeTasks.delete(task.peerId);
        await this.#flushOutbox(this.#epoch?.transport, task.bindingEpoch);
        return;
      }
      default:
        await this.#commitSimpleReply(task, '未知命令。发送 /help 查看可用命令。');
    }
  }

  async #commitSimpleReply(task: WechatTask, text: string): Promise<void> {
    const accepted = await this.#requireStore().markAccepted(task.bindingEpoch, task.id);
    if (!accepted) throw new Error('WECHAT_ACCEPT_CAS_REJECTED');
    const active: ActiveTask = { task, terminalCommitted: false };
    this.#activeTasks.set(task.peerId, active);
    try {
      await this.commitFinal({ userId: task.peerId, text, terminal: 'done' });
    } finally {
      this.#activeTasks.delete(task.peerId);
    }
    await this.#flushOutbox(this.#epoch?.transport, task.bindingEpoch);
  }

  async #commitPreDispatchFailure(task: WechatTask, reason: string): Promise<void> {
    const text =
      reason.includes('TURN_PERMISSION_POLICY_UNSUPPORTED') ||
      reason.includes('unsupported_turn_permission')
        ? '当前会话使用“完全访问”权限，个人微信暂不支持该模式。请在 Cindy 中改为“自动”或“每次询问”。'
        : reason === 'missing_auth'
          ? '当前 Agent 尚未完成授权，请先在 Cindy 中连接模型服务。'
          : '这条消息暂时无法启动，请稍后重试。';
    const chunks = chunkWechatText(text);
    await this.#requireStore().commitPreDispatchFailure({
      bindingEpoch: task.bindingEpoch,
      taskId: task.id,
      now: this.#now(),
      errorCode: safeMachineCode(reason),
      outbox: chunks.map((chunk, index) => ({
        id: randomUUID(),
        clientId: randomUUID(),
        kind: 'error',
        chunkIndex: index,
        text: chunk,
      })),
    });
    await this.#flushOutbox(this.#epoch?.transport, task.bindingEpoch);
  }

  async #outboxLoop(
    binding: WechatActiveBinding,
    transport: WechatTransport,
    signal: AbortSignal,
    generation: number,
  ): Promise<void> {
    while (!signal.aborted && this.#isGenerationCurrent(generation)) {
      await this.#flushOutbox(transport, binding.bindingEpoch);
      await delay(1_000, signal);
    }
  }

  async #flushOutbox(transport: WechatTransport | undefined, bindingEpoch: string): Promise<void> {
    if (!transport) return;
    const store = this.#requireStore();
    for (const item of await store.listDueOutbox(bindingEpoch, this.#now())) {
      for (let immediateAttempt = 0; immediateAttempt < 3; immediateAttempt += 1) {
        if (!(await store.claimOutbox(bindingEpoch, item.id))) break;
        try {
          await this.#sendOutboxItem(transport, bindingEpoch, item);
          await store.markOutboxDelivered(bindingEpoch, item.id, this.#now());
          break;
        } catch (error) {
          const safe = asWechatIlinkError(error);
          const retryNow = safe.retryable && immediateAttempt < 2;
          await store.recordOutboxFailure({
            bindingEpoch,
            outboxId: item.id,
            nextRetryAt: retryNow
              ? this.#now()
              : this.#now() + retryDelay(item.attempts + immediateAttempt + 1),
            terminal: false,
            errorCode: safe.code,
          });
          if (safe.code === 'AUTH_REPLACED' || safe.code === 'AUTH_EXPIRED') {
            this.#setState({
              ...this.#state,
              phase: 'needs_reauth',
              errorCode: safe.code.toLowerCase(),
            });
            return;
          }
          if (!retryNow) break;
        }
      }
    }
  }

  async #sendOutboxItem(
    transport: WechatTransport,
    bindingEpoch: string,
    item: Awaited<ReturnType<WechatTaskStore['listDueOutbox']>>[number],
  ): Promise<void> {
    const signal = this.#epoch?.abort.signal ?? new AbortController().signal;
    const peerId = await this.#peerIdForTask(bindingEpoch, item.taskId);
    if (item.text) {
      await transport.sendMessage(
        {
          peerId,
          text: item.text,
          contextToken: item.contextToken,
          clientId: item.clientId,
        },
        signal,
      );
    }
    for (const media of parseOutboxMedia(item.mediaJson)) {
      const local = await readOutboundWechatFile(media.absPath);
      const uploaded = await transport.uploadMedia(
        {
          peerId,
          bytes: local.bytes,
          fileName: local.fileName,
          kind: local.kind,
        },
        signal,
      );
      await transport.sendMedia(
        {
          peerId,
          contextToken: item.contextToken,
          clientId: media.clientId,
          uploaded,
        },
        signal,
      );
    }
  }

  async #peerIdForTask(bindingEpoch: string, taskId: string): Promise<string> {
    const row = await this.#deps.getDbClient().queryOne<{ peerId: string }>(
      `SELECT peer_id AS peerId
       FROM wechat_inbox
       WHERE binding_epoch = ? AND id = ?`,
      [bindingEpoch, taskId],
    );
    if (!row?.peerId) throw new Error('WECHAT_OUTBOX_TASK_MISSING');
    return row.peerId;
  }

  async #toTaskInput(
    bindingEpoch: string,
    message: WechatInboundMessage,
    transport: WechatTransport,
    signal: AbortSignal,
    receivedAt: number,
    index: number,
  ) {
    const runtime = this.#turnRuntime;
    if (!runtime) throw new Error('WECHAT_TURN_RUNTIME_NOT_ATTACHED');
    const botId = this.#epoch?.credentials.ilinkBotId ?? 'wechat';
    const prepared = await runtime.repo.prepareNewSession(botId, message.senderId);
    const existing = await runtime.repo.findActiveSession(botId, message.senderId);
    const session =
      existing ?? (await runtime.repo.createSession(botId, message.senderId, undefined, prepared));
    const epoch = await this.#requireStore().getConversationEpoch(bindingEpoch, message.senderId);
    const taskId = randomUUID();
    const staged = await stageWechatTaskMedia({
      bindingEpoch,
      taskId,
      sessionId: session.id,
      media: [...(message.quote?.media ?? []), ...message.media],
      transport,
      signal,
      now: receivedAt,
    });
    const quote = formatWechatQuote(message);
    return {
      message: {
        id: taskId,
        platformMessageId: message.messageId,
        platformSeq: platformSequence(message, receivedAt, index),
        peerId: message.senderId,
        receivedAt,
        platformCreatedAt: message.createdAt ?? receivedAt,
        sessionId: session.id,
        conversationEpoch: epoch,
        payloadJson: JSON.stringify({
          text: quote ? `${quote}\n${message.text}`.trim() : message.text,
          attachments: staged.attachments,
          unsupportedMedia: staged.unsupportedMedia,
        } satisfies WechatTaskPayload),
        contextToken: message.contextToken,
        overloadReply: {
          outboxId: randomUUID(),
          clientId: randomUUID(),
          text: '当前微信任务较多，请稍后再试。',
        },
      },
      mediaBlobs: staged.mediaBlobs,
      mediaRefs: staged.mediaRefs,
      fileAttachments: staged.fileAttachments,
    };
  }

  async #readActiveBindingWithoutKey(): Promise<WechatActiveBinding | null> {
    const row = await this.#deps.getDbClient().queryOne<{
      bindingEpoch: string;
      cursor: string;
    }>(
      `SELECT binding_epoch AS bindingEpoch, sync_cursor AS cursor
       FROM wechat_sync_state
       WHERE is_active = 1
       LIMIT 1`,
    );
    return row ?? null;
  }

  #readDataKey(): Buffer | null {
    const raw = this.host.secrets.read(DATA_KEY_NAME);
    if (!raw) return null;
    try {
      const key = Buffer.from(raw, 'base64');
      return key.byteLength === 32 ? key : null;
    } catch {
      return null;
    }
  }

  #readCredentials(bindingEpoch: string): StoredWechatCredentials | null {
    const raw = this.host.secrets.read(`${CREDENTIAL_PREFIX}${bindingEpoch}`);
    if (!raw) return null;
    try {
      const value = JSON.parse(raw) as Partial<StoredWechatCredentials>;
      return value.bindingEpoch === bindingEpoch &&
        typeof value.botToken === 'string' &&
        value.botToken &&
        typeof value.ilinkBotId === 'string' &&
        value.ilinkBotId &&
        typeof value.userId === 'string' &&
        value.userId &&
        typeof value.baseUrl === 'string' &&
        value.baseUrl.startsWith('https://') &&
        typeof value.boundAt === 'number'
        ? (value as StoredWechatCredentials)
        : null;
    } catch {
      return null;
    }
  }

  #requireStore(): WechatTaskStore {
    if (!this.#store) throw new Error('WECHAT_STORE_NOT_READY');
    return this.#store;
  }

  #isGenerationCurrent(generation: number): boolean {
    return this.#deps.isAccountGenerationCurrent(generation);
  }

  #setState(state: Omit<WechatBotState, 'bound'>): void {
    this.#state = state;
    this.host.ipc.broadcast('wechatBot:state-changed', this.getState());
    const status = this.getStatus();
    for (const handler of this.#statusHandlers) handler(status);
  }

  #now(): number {
    return this.#deps.now?.() ?? Date.now();
  }
}

export const WECHAT_AUTH_BASE_URL = AUTH_BASE_URL;

export function sessionIdFor(botId: string, peerId: string): string {
  const digest = createHash('sha256').update(`${botId}\0${peerId}`).digest('hex').slice(0, 32);
  return `wechat_${digest}`;
}

function parseTaskPayload(raw: string): WechatTaskPayload {
  const value = JSON.parse(raw) as Partial<WechatTaskPayload>;
  const attachments = value.attachments ?? [];
  if (
    typeof value.text !== 'string' ||
    !Array.isArray(attachments) ||
    !attachments.every(isWechatTaskAttachment) ||
    !Array.isArray(value.unsupportedMedia) ||
    !value.unsupportedMedia.every((item) => typeof item === 'string')
  ) {
    throw new Error('WECHAT_TASK_PAYLOAD_INVALID');
  }
  return {
    text: value.text,
    attachments,
    unsupportedMedia: value.unsupportedMedia,
  };
}

function isWechatTaskAttachment(value: unknown): value is WechatTaskAttachment {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Partial<WechatTaskAttachment>;
  return (
    (item.kind === 'image' || item.kind === 'file') &&
    (item.storage === 'cindy-media' || item.storage === 'file') &&
    typeof item.absPath === 'string' &&
    typeof item.originalName === 'string' &&
    typeof item.mimeType === 'string' &&
    (item.url === undefined || typeof item.url === 'string')
  );
}

function formatWechatQuote(message: WechatInboundMessage): string {
  const quote = message.quote;
  if (!quote) return '';
  const details = [quote.title?.trim(), quote.text?.trim()].filter((item): item is string =>
    Boolean(item),
  );
  if (quote.media.length > 0) details.push(`附件 ${quote.media.length} 个`);
  return details.length > 0 ? `[引用：${details.join('｜')}]` : '';
}

function platformSequence(
  message: WechatInboundMessage,
  receivedAt: number,
  index: number,
): number {
  const parsed = Number.parseInt(message.messageId, 10);
  if (Number.isSafeInteger(parsed)) return parsed;
  return (message.createdAt ?? receivedAt) * 100 + index;
}

function retryDelay(attempt: number): number {
  return [1_000, 5_000, 30_000, 120_000][Math.min(Math.max(attempt - 1, 0), 3)];
}

interface OutboxMedia {
  absPath: string;
  clientId: string;
}

function parseOutboxMedia(raw: string): OutboxMedia[] {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('WECHAT_OUTBOX_MEDIA_INVALID');
  }
  if (
    !Array.isArray(value) ||
    value.length > 4 ||
    !value.every(
      (item) =>
        item &&
        typeof item === 'object' &&
        !Array.isArray(item) &&
        typeof (item as Partial<OutboxMedia>).absPath === 'string' &&
        path.isAbsolute((item as Partial<OutboxMedia>).absPath!) &&
        typeof (item as Partial<OutboxMedia>).clientId === 'string' &&
        (item as Partial<OutboxMedia>).clientId!.length > 0,
    )
  ) {
    throw new Error('WECHAT_OUTBOX_MEDIA_INVALID');
  }
  return value as OutboxMedia[];
}

async function readOutboundWechatFile(
  absPath: string,
  displayName?: string,
): Promise<{
  bytes: Uint8Array;
  fileName: string;
  kind: 'image' | 'video' | 'file';
}> {
  if (!path.isAbsolute(absPath)) {
    throw Object.assign(new Error('WeChat outbound path must be absolute.'), {
      code: 'ENOENT',
    });
  }
  const handle = await fs.open(absPath, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw Object.assign(new Error('WeChat outbound path is not a regular file.'), {
        code: 'ENOENT',
      });
    }
    if (stat.size === 0) {
      throw Object.assign(new Error('WeChat outbound file is empty.'), {
        code: 'WECHAT_FILE_EMPTY',
      });
    }
    if (stat.size > WECHAT_MEDIA_MAX_BYTES) {
      throw Object.assign(new Error('WeChat outbound file exceeds 5 MB.'), {
        code: 'WECHAT_FILE_TOO_LARGE',
      });
    }
    const bytes = await handle.readFile();
    if (bytes.byteLength !== stat.size) {
      throw new Error('WECHAT_OUTBOUND_FILE_CHANGED');
    }
    return {
      bytes,
      fileName: sanitizeOutboundFileName(displayName ?? path.basename(absPath)),
      kind: detectOutboundWechatKind(bytes),
    };
  } finally {
    await handle.close();
  }
}

function sanitizeOutboundFileName(input: string): string {
  const value = path
    .basename(input.normalize('NFKC'))
    .replace(/\p{Cc}/gu, '_')
    .replace(/[<>:"/\\|?*]/g, '_')
    .replace(/[. ]+$/g, '')
    .trim()
    .slice(0, 180);
  return value || 'cindy-file.bin';
}

function detectOutboundWechatKind(bytes: Uint8Array): 'image' | 'video' | 'file' {
  const ascii = (offset: number, value: string): boolean =>
    bytes.length >= offset + value.length &&
    Array.from(value).every((char, index) => bytes[offset + index] === char.charCodeAt(0));
  if (
    (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) ||
    (bytes.length >= 8 && bytes[0] === 0x89 && ascii(1, 'PNG\r\n\u001a\n')) ||
    ascii(0, 'GIF87a') ||
    ascii(0, 'GIF89a') ||
    (ascii(0, 'RIFF') && ascii(8, 'WEBP'))
  ) {
    return 'image';
  }
  return ascii(4, 'ftyp') ? 'video' : 'file';
}

function withJitter(value: number): number {
  return Math.round(value * (0.8 + Math.random() * 0.4));
}

function shortId(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 8);
}

function safeMachineCode(value: string): string {
  const normalized = value
    .toUpperCase()
    .replace(/[^A-Z0-9_]+/g, '_')
    .slice(0, 64);
  return normalized || 'PRE_DISPATCH_REJECTED';
}

function machineErrorCode(error: unknown): string {
  return error instanceof Error ? safeMachineCode(error.message) : 'unknown_error';
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
