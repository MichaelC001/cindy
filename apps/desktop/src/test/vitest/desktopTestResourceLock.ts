import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const LOCK_HOST = '127.0.0.1';
const LOCK_PORT_START = 49_152;
const LOCK_PORT_COUNT = 16_000;
const LOCK_PORT_CANDIDATES = 8;
const RETRY_DELAY_MS = 250;
const PROBE_TIMEOUT_MS = 1_000;
const LOCK_PROTOCOL = 'cindy-desktop-test-lock-v1';
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..');

interface DesktopTestLock {
  port: number;
  release: () => Promise<void>;
}

function delay(durationMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}

async function resolveGitCommonDir(repoRoot: string): Promise<string> {
  const dotGitPath = path.join(repoRoot, '.git');
  const dotGitStat = await fs.stat(dotGitPath);
  if (dotGitStat.isDirectory()) return fs.realpath(dotGitPath);

  const gitDirLine = (await fs.readFile(dotGitPath, 'utf8')).trim();
  const gitDirMatch = /^gitdir:\s*(.+)$/i.exec(gitDirLine);
  if (!gitDirMatch) throw new Error(`Invalid gitdir file: ${dotGitPath}`);
  const gitDir = path.resolve(repoRoot, gitDirMatch[1]);
  try {
    const commonDir = (await fs.readFile(path.join(gitDir, 'commondir'), 'utf8')).trim();
    return fs.realpath(path.resolve(gitDir, commonDir));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return fs.realpath(gitDir);
  }
}

function lockIdentity(commonDir: string): string {
  const normalized = process.platform === 'win32' ? commonDir.toLowerCase() : commonDir;
  return createHash('sha256').update(normalized).digest('hex');
}

function lockPort(identity: string, candidate: number): number {
  const baseOffset = Number.parseInt(identity.slice(0, 8), 16) % LOCK_PORT_COUNT;
  return LOCK_PORT_START + ((baseOffset + candidate) % LOCK_PORT_COUNT);
}

function listen(server: net.Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen({ host: LOCK_HOST, port, exclusive: true });
  });
}

function close(server: net.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function probeLock(port: number, expectedBanner: string): Promise<'owner' | 'retry' | 'collision'> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: LOCK_HOST, port });
    let response = '';
    let settled = false;

    const finish = (result: 'owner' | 'retry' | 'collision') => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };

    socket.setEncoding('utf8');
    socket.setTimeout(PROBE_TIMEOUT_MS);
    socket.on('data', (chunk) => {
      response += chunk;
      if (response.includes('\n')) {
        finish(response.trim() === expectedBanner ? 'owner' : 'collision');
      }
    });
    socket.on('end', () => finish(response.trim() === expectedBanner ? 'owner' : 'collision'));
    socket.on('timeout', () => finish('collision'));
    socket.on('error', (error: NodeJS.ErrnoException) => {
      finish(error.code === 'ECONNREFUSED' || error.code === 'ECONNRESET' ? 'retry' : 'collision');
    });
  });
}

export async function acquireDesktopTestLock(repoRoot: string): Promise<DesktopTestLock> {
  const commonDir = await resolveGitCommonDir(repoRoot);
  const identity = lockIdentity(commonDir);
  const banner = `${LOCK_PROTOCOL}:${identity}`;
  let reportedWait = false;

  while (true) {
    let shouldRetry = false;
    for (let candidate = 0; candidate < LOCK_PORT_CANDIDATES; candidate += 1) {
      const port = lockPort(identity, candidate);
      const server = net.createServer((socket) => {
        socket.end(`${banner}\n`);
      });
      try {
        await listen(server, port);
        return {
          port,
          release: () => close(server),
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
        const probe = await probeLock(port, banner);
        if (probe === 'collision') continue;
        shouldRetry = true;
        if (probe === 'owner' && !reportedWait) {
          reportedWait = true;
          process.stdout.write('WAIT desktop tests: another worktree is using the shared Desktop test budget\n');
        }
        break;
      }
    }
    if (!shouldRetry) {
      throw new Error('All Desktop test resource-lock ports are occupied by other local services');
    }
    await delay(RETRY_DELAY_MS);
  }
}

export default async function setupDesktopTestResourceLock(): Promise<() => Promise<void>> {
  const lock = await acquireDesktopTestLock(REPO_ROOT);
  return lock.release;
}
