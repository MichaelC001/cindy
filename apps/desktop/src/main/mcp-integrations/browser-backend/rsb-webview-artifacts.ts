import fs from 'node:fs';
import path from 'node:path';

import type { WebContents } from 'electron';

interface ArtifactLogger {
  warn(message: string, ...args: unknown[]): void;
}

interface DownloadItemLike {
  getFilename(): string;
  getURL(): string;
  getMimeType(): string;
  getTotalBytes(): number;
  getReceivedBytes(): number;
  setSavePath(filePath: string): void;
  cancel(): void;
  once(event: string, listener: (...args: unknown[]) => void): void;
}

interface SessionLike {
  on(event: string, listener: (...args: unknown[]) => void): void;
  removeListener(event: string, listener: (...args: unknown[]) => void): void;
}

export interface BrowserArtifact {
  id: string;
  fileName: string;
  path?: string;
  url?: string;
  mimeType?: string;
  bytes?: number;
  state: 'completed' | 'cancelled' | 'interrupted';
  startedAt: string;
  finishedAt: string;
}

interface PendingDownload {
  item: DownloadItemLike;
  done: Promise<BrowserArtifact>;
}

interface ArtifactCapture {
  id: string;
  webContents: WebContents;
  directory: string;
  accepting: boolean;
  pending: PendingDownload[];
  usedNames: Set<string>;
}

const DOWNLOAD_GRACE_MS = 250;
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 60_000;
const MAX_DOWNLOAD_TIMEOUT_MS = 5 * 60_000;
const MAX_RECENT_ARTIFACTS = 100;

let captureSequence = 0;
let artifactSequence = 0;

function safeSegment(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '');
  return (cleaned || 'session').slice(0, 64);
}

function safeFileName(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? '';
  let cleaned = base
    // eslint-disable-next-line no-control-regex -- control characters are invalid in filenames
    .replace(/[\u0000-\u001f<>:"|?*]/g, '')
    .replace(/^\.+/, '')
    .replace(/[. ]+$/, '')
    .trim();
  if (!cleaned || cleaned === '..') cleaned = 'download';
  if (cleaned.length > 160) cleaned = cleaned.slice(-160);
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(cleaned)) {
    cleaned = `_${cleaned}`;
  }
  return cleaned;
}

function uniqueName(base: string, used: Set<string>): string {
  const extension = path.extname(base);
  const stem = base.slice(0, base.length - extension.length);
  let candidate = base;
  for (let index = 2; used.has(candidate.toLowerCase()); index += 1) {
    candidate = `${stem}-${index}${extension}`;
  }
  used.add(candidate.toLowerCase());
  return candidate;
}

function sessionFor(wc: WebContents): SessionLike {
  const session = (wc as unknown as { session?: SessionLike }).session;
  if (!session) throw new Error('webContents session is unavailable');
  return session;
}

function boundedTimeout(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.min(MAX_DOWNLOAD_TIMEOUT_MS, Math.floor(value))
    : DEFAULT_DOWNLOAD_TIMEOUT_MS;
}

function displayUrl(value: string): string | undefined {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
    parsed.username = '';
    parsed.password = '';
    return parsed.href;
  } catch {
    return undefined;
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Captures downloads only while an agent-owned browser action is in flight.
 * Each action gets an isolated directory; failed and cancelled files are
 * removed, while completed files remain available for later tool steps.
 */
export class RsbWebviewArtifacts {
  private readonly sessionListeners = new Map<SessionLike, (...args: unknown[]) => void>();
  private readonly captures = new Map<WebContents, ArtifactCapture>();
  private readonly recent: BrowserArtifact[] = [];

  constructor(
    private readonly rootDir: () => string,
    private readonly logger: ArtifactLogger,
  ) {}

  async capture<T>(
    wc: WebContents,
    context: { sessionId: string; timeoutMs?: number },
    action: () => Promise<T>,
  ): Promise<{ value: T; downloads: BrowserArtifact[] }> {
    if (this.captures.has(wc)) {
      throw new Error('another download-aware action is already running for this tab');
    }
    const session = sessionFor(wc);
    this.observeSession(session);
    const parent = path.join(this.rootDir(), safeSegment(context.sessionId));
    await fs.promises.mkdir(parent, { recursive: true });
    captureSequence += 1;
    const directory = await fs.promises.mkdtemp(
      path.join(parent, `${Date.now().toString(36)}-${captureSequence.toString(36)}-`),
    );
    const capture: ArtifactCapture = {
      id: `${Date.now().toString(36)}-${captureSequence.toString(36)}`,
      webContents: wc,
      directory,
      accepting: true,
      pending: [],
      usedNames: new Set(),
    };
    this.captures.set(wc, capture);

    let value: T;
    try {
      value = await action();
      await wait(DOWNLOAD_GRACE_MS);
    } catch (err) {
      capture.accepting = false;
      this.captures.delete(wc);
      for (const pending of capture.pending) pending.item.cancel();
      await this.removeDirectory(directory);
      throw err;
    }
    capture.accepting = false;
    this.captures.delete(wc);

    if (capture.pending.length === 0) {
      await this.removeDirectory(directory);
      return { value, downloads: [] };
    }

    const timeoutMs = boundedTimeout(context.timeoutMs);
    const completion = Promise.all(capture.pending.map((entry) => entry.done));
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<BrowserArtifact[]>((_resolve, reject) => {
      timeoutHandle = setTimeout(() => {
        for (const pending of capture.pending) pending.item.cancel();
        reject(new Error(`download did not finish within ${timeoutMs}ms`));
      }, timeoutMs);
    });
    let downloads: BrowserArtifact[];
    try {
      downloads = await Promise.race([completion, timeout]);
    } catch (err) {
      await this.removeDirectory(directory);
      throw err;
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }
    for (const artifact of downloads) {
      this.recent.push(artifact);
    }
    if (this.recent.length > MAX_RECENT_ARTIFACTS) {
      this.recent.splice(0, this.recent.length - MAX_RECENT_ARTIFACTS);
    }
    if (!downloads.some((artifact) => artifact.state === 'completed')) {
      await this.removeDirectory(directory);
    }
    return { value, downloads };
  }

  diagnostics(): { activeCaptures: number; recentArtifacts: BrowserArtifact[] } {
    return {
      activeCaptures: this.captures.size,
      recentArtifacts: this.recent.slice(-20).map((artifact) => ({ ...artifact })),
    };
  }

  async dispose(): Promise<void> {
    for (const [session, listener] of this.sessionListeners) {
      session.removeListener('will-download', listener);
    }
    this.sessionListeners.clear();
    const active = [...this.captures.values()];
    this.captures.clear();
    await Promise.all(active.map(async (capture) => {
      capture.accepting = false;
      for (const pending of capture.pending) pending.item.cancel();
      await this.removeDirectory(capture.directory);
    }));
  }

  private observeSession(session: SessionLike): void {
    if (this.sessionListeners.has(session)) return;
    const listener = (...args: unknown[]) => {
      const item = args[1] as DownloadItemLike | undefined;
      const wc = args[2] as WebContents | undefined;
      if (!item || !wc) return;
      const capture = this.captures.get(wc);
      if (!capture?.accepting) return;
      this.trackDownload(capture, item);
    };
    session.on('will-download', listener);
    this.sessionListeners.set(session, listener);
  }

  private trackDownload(capture: ArtifactCapture, item: DownloadItemLike): void {
    artifactSequence += 1;
    const id = `artifact-${Date.now().toString(36)}-${artifactSequence.toString(36)}`;
    const fileName = uniqueName(safeFileName(item.getFilename()), capture.usedNames);
    const filePath = path.join(capture.directory, fileName);
    const startedAt = new Date().toISOString();
    item.setSavePath(filePath);
    const done = new Promise<BrowserArtifact>((resolve) => {
      item.once('done', (_event: unknown, rawState: unknown) => {
        const state = rawState === 'completed'
          ? 'completed'
          : rawState === 'cancelled'
            ? 'cancelled'
            : 'interrupted';
        if (state !== 'completed') {
          try {
            fs.rmSync(filePath, { force: true });
          } catch (err) {
            this.logger.warn('failed to remove incomplete browser artifact', {
              artifactId: id,
              err,
            });
          }
        }
        const totalBytes = item.getTotalBytes();
        const receivedBytes = item.getReceivedBytes();
        const url = displayUrl(item.getURL());
        resolve({
          id,
          fileName,
          ...(state === 'completed' ? { path: filePath } : {}),
          ...(url ? { url } : {}),
          ...(item.getMimeType() ? { mimeType: item.getMimeType() } : {}),
          ...(Number.isFinite(totalBytes) && totalBytes > 0
            ? { bytes: totalBytes }
            : Number.isFinite(receivedBytes) && receivedBytes > 0
              ? { bytes: receivedBytes }
              : {}),
          state,
          startedAt,
          finishedAt: new Date().toISOString(),
        });
      });
    });
    capture.pending.push({ item, done });
  }

  private async removeDirectory(directory: string): Promise<void> {
    try {
      await fs.promises.rm(directory, { recursive: true, force: true });
    } catch (err) {
      this.logger.warn('failed to clean browser artifact directory', { err });
    }
  }
}
