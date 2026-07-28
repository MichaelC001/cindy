// @vitest-environment jsdom

/**
 * store 单测 —— 覆盖 RSB tab store 的乐观更新 + 回滚 + dedupe + 多 session 隔离 +
 * subscribe 通知。
 *
 * IPC 行为本身在 `main/localDb/ipc/__tests__/rightSidebarTabs.test.ts` 已经测过
 * (16 case),这里只测 renderer store 跟 IPC 的协作:乐观更新先生效、IPC 失败时
 * 回滚 cache、并发 ensureHydrated dedupe 等。
 *
 * IPC 桩:替换 `window.electronAPI.localDb.rightSidebarTabs` 为内存版,把成功 /
 * 失败 / 延迟单独可控。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetTabKindRegistry, registerTabKind } from '../registry';
import type { TabKindPlugin } from '../types';

// device-link origin 注册表桩:'remote-' 前缀的 sessionId 视为远程会话。
// store 对远程会话必须走纯内存(right_sidebar_tabs 对 sessions 表有 FK,
// 远程 sessionId 不在本地库,写入必撞约束),其余测试用例不受影响。
vi.mock('@/features/device-link/remoteProjectsStore', () => ({
  getSessionDeviceId: (sid: string) => (sid.startsWith('remote-') ? 'dev-1' : undefined),
}));

// store 是模块级单例,在测试间必须重置。但 vitest 不会重新 import 模块,
// 用导出的 `_resetStore` 清 cache。
let store: typeof import('../store');

type IpcStub = {
  list: ReturnType<typeof vi.fn>;
  upsert: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  setActive: ReturnType<typeof vi.fn>;
  reorder: ReturnType<typeof vi.fn>;
};

function makeIpcStub(): IpcStub {
  return {
    list: vi.fn().mockResolvedValue({ tabs: [], activeTabId: null }),
    upsert: vi.fn().mockResolvedValue({ ok: true }),
    close: vi.fn().mockResolvedValue({ ok: true }),
    setActive: vi.fn().mockResolvedValue({ ok: true }),
    reorder: vi.fn().mockResolvedValue({ ok: true }),
  };
}

function installIpc(stub: IpcStub): void {
  // 测试用 window.electronAPI 桩。完整 surface 太大,只挂 store 用到的子集,
  // 配合 `as unknown as ...` 绕过 typing(测试本来就是用 mock 替换完整 contract)。
  (window as unknown as {
    electronAPI: { localDb: { rightSidebarTabs: IpcStub }; platform: string };
  }).electronAPI = {
    localDb: { rightSidebarTabs: stub },
    platform: 'darwin',
  };
}

function registerVetoPlugin(
  onBeforeClose = vi.fn(async () => false),
): ReturnType<typeof vi.fn> {
  registerTabKind({
    kind: 'orca-workers',
    menu: {
      kind: 'orca-workers',
      labelKey: 'rightSidebar.tabs.kinds.collaboration',
      icon: (() => null) as never,
      order: 18,
      enabled: true,
      singleton: true,
    },
    TabPillTitle: () => null,
    TabBody: () => null,
    defaultState: () => ({}),
    onBeforeClose,
  } as TabKindPlugin);
  return onBeforeClose;
}

describe('RSB store', () => {
  let ipc: IpcStub;

  beforeEach(async () => {
    store = await import('../store');
    store._resetStore();
    _resetTabKindRegistry();
    ipc = makeIpcStub();
    installIpc(ipc);
  });

  afterEach(() => {
    store._resetStore();
    _resetTabKindRegistry();
  });

  describe('getBucket', () => {
    it('returns empty bucket for null / undefined sessionId', () => {
      expect(store.getBucket(null)).toEqual({ hydrated: false, tabs: [], activeTabId: null });
      expect(store.getBucket(undefined)).toEqual({ hydrated: false, tabs: [], activeTabId: null });
    });

    it('returns empty bucket for unknown session before hydrate', () => {
      const bucket = store.getBucket('session-unknown');
      expect(bucket.hydrated).toBe(false);
      expect(bucket.tabs).toEqual([]);
    });

    // useSyncExternalStore 契约:cache miss 必须返回稳定 reference,否则 React 用
    // Object.is 比对 snapshot 会触发警告 / 无限重渲染。所有 cache miss(null /
    // undefined / unknown sessionId)共用同一 EMPTY_BUCKET 单例。
    it('returns the same reference across calls for cache misses', () => {
      const a = store.getBucket(null);
      const b = store.getBucket(undefined);
      const c = store.getBucket('session-unknown');
      const d = store.getBucket('another-unknown');
      expect(a).toBe(b);
      expect(b).toBe(c);
      expect(c).toBe(d);
    });
  });

  describe('ensureHydrated', () => {
    it('calls IPC list once and caches hydrated bucket', async () => {
      ipc.list.mockResolvedValueOnce({
        tabs: [{ id: 't1', kind: 'file-browser', position: 0, state: { selectedFilePath: 'a.md' } }],
        activeTabId: 't1',
      });
      await store.ensureHydrated('s1');
      expect(ipc.list).toHaveBeenCalledTimes(1);
      const bucket = store.getBucket('s1');
      expect(bucket.hydrated).toBe(true);
      expect(bucket.tabs).toHaveLength(1);
      expect(bucket.activeTabId).toBe('t1');
    });

    it('skips IPC on second call (cache hit)', async () => {
      await store.ensureHydrated('s1');
      await store.ensureHydrated('s1');
      expect(ipc.list).toHaveBeenCalledTimes(1);
    });

    it('dedupes concurrent calls into a single IPC', async () => {
      let resolveList!: (v: { tabs: unknown[]; activeTabId: null }) => void;
      ipc.list.mockReturnValueOnce(
        new Promise((r) => {
          resolveList = r as never;
        }),
      );
      const p1 = store.ensureHydrated('s1');
      const p2 = store.ensureHydrated('s1');
      const p3 = store.ensureHydrated('s1');
      resolveList({ tabs: [], activeTabId: null });
      await Promise.all([p1, p2, p3]);
      expect(ipc.list).toHaveBeenCalledTimes(1);
    });

    it('falls back to empty hydrated bucket when electronAPI is missing (SSR / preload)', async () => {
      delete (window as unknown as { electronAPI?: unknown }).electronAPI;
      await store.ensureHydrated('s1');
      expect(store.getBucket('s1').hydrated).toBe(true);
      expect(store.getBucket('s1').tabs).toEqual([]);
    });

    it('marks unknown local-DB sessions as memory-only', async () => {
      ipc.list.mockResolvedValueOnce({ tabs: [], activeTabId: null, persistable: false });
      await store.ensureHydrated('ghost-s1');
      const tab = await store.addTab('ghost-s1', 'web-browser', { url: 'https://example.com' });
      await store.patchTabState('ghost-s1', tab.id, (current) => ({
        ...(current as object),
        title: 'Example',
      }));

      expect(ipc.list).toHaveBeenCalledOnce();
      expect(ipc.upsert).not.toHaveBeenCalled();
      expect(ipc.setActive).not.toHaveBeenCalled();
      expect(store.getBucket('ghost-s1').tabs).toHaveLength(1);
      expect((store.getBucket('ghost-s1').tabs[0].state as { title: string }).title).toBe('Example');
    });

    it('keeps the tab count limit for memory-only sessions', async () => {
      ipc.list.mockResolvedValueOnce({ tabs: [], activeTabId: null, persistable: false });
      await store.ensureHydrated('ghost-s1');
      for (let i = 0; i < 20; i++) {
        await store.addTab('ghost-s1', 'web-browser', { url: `https://example.com/${i}` });
      }

      await expect(
        store.addTab('ghost-s1', 'web-browser', { url: 'https://example.com/overflow' }),
      ).rejects.toThrow(/limit reached/);
      expect(store.getBucket('ghost-s1').tabs).toHaveLength(20);
      expect(ipc.upsert).not.toHaveBeenCalled();
    });

    it('keeps the state-size limit for memory-only addTab', async () => {
      ipc.list.mockResolvedValueOnce({ tabs: [], activeTabId: null, persistable: false });
      await store.ensureHydrated('ghost-s1');

      await expect(
        store.addTab('ghost-s1', 'web-browser', { favicon: `data:image/png;base64,${'x'.repeat(20 * 1024)}` }),
      ).rejects.toThrow(/tab state JSON too large/);
      expect(store.getBucket('ghost-s1').tabs).toHaveLength(0);
      expect(ipc.upsert).not.toHaveBeenCalled();
    });

    it('keeps the state-size limit for memory-only patchTabState', async () => {
      ipc.list.mockResolvedValueOnce({ tabs: [], activeTabId: null, persistable: false });
      await store.ensureHydrated('ghost-s1');
      const tab = await store.addTab('ghost-s1', 'web-browser', { title: 'small' });

      await expect(
        store.patchTabState('ghost-s1', tab.id, () => ({
          favicon: `data:image/png;base64,${'x'.repeat(20 * 1024)}`,
        })),
      ).rejects.toThrow(/tab state JSON too large/);
      expect((store.getBucket('ghost-s1').tabs[0].state as { title: string }).title).toBe('small');
      expect(ipc.upsert).not.toHaveBeenCalled();
    });
  });

  describe('addTab', () => {
    it('optimistically inserts new tab + sets it active', async () => {
      const tab = await store.addTab('s1', 'file-browser', { selectedFilePath: null });
      expect(tab.kind).toBe('file-browser');
      const bucket = store.getBucket('s1');
      expect(bucket.tabs).toHaveLength(1);
      expect(bucket.activeTabId).toBe(tab.id);
      expect(ipc.upsert).toHaveBeenCalledOnce();
      expect(ipc.setActive).toHaveBeenCalledOnce();
    });

    it('rolls back cache when IPC upsert fails', async () => {
      ipc.upsert.mockRejectedValueOnce(new Error('boom'));
      const prevActiveId = store.getBucket('s1').activeTabId;
      await expect(store.addTab('s1', 'file-browser', null)).rejects.toThrow('boom');
      // 失败回滚:tabs 仍为空,activeTabId 仍是之前的
      expect(store.getBucket('s1').tabs).toEqual([]);
      expect(store.getBucket('s1').activeTabId).toBe(prevActiveId);
    });

    it('falls back to memory-only when the first persist hits a missing session FK', async () => {
      ipc.upsert.mockRejectedValueOnce(new Error('SQLITE_CONSTRAINT_FOREIGNKEY: FOREIGN KEY constraint failed'));
      const tab = await store.addTab('ghost-race', 'web-browser', { url: 'https://example.com' });
      await store.patchTabState('ghost-race', tab.id, (current) => ({
        ...(current as object),
        title: 'Example',
      }));

      expect(store.getBucket('ghost-race').tabs).toHaveLength(1);
      expect(store.getBucket('ghost-race').activeTabId).toBe(tab.id);
      expect(ipc.upsert).toHaveBeenCalledTimes(1);
    });

    it('keeps tabs in different sessions isolated', async () => {
      const a = await store.addTab('s1', 'file-browser', null);
      const b = await store.addTab('s2', 'web-browser', null);
      expect(store.getBucket('s1').tabs.map((t) => t.id)).toEqual([a.id]);
      expect(store.getBucket('s2').tabs.map((t) => t.id)).toEqual([b.id]);
    });

    it('onOptimisticAdd fires synchronously with the optimistic insert, before IPC settles', async () => {
      // popup 来源标记的时序契约:持久化 IPC 在途期间 React 已能 mount 这个
      // tab 的 webview,标记必须在乐观插入的同一 tick 就绪——不能等 addTab
      // resolve(快速 OAuth callback 的 window.close 会赶在登记前到达)。
      let releaseUpsert: (() => void) | null = null;
      ipc.upsert.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseUpsert = () => resolve({ ok: true });
          }),
      );
      const seen: string[] = [];
      const pending = store.addTab('s1', 'web-browser', null, {
        onOptimisticAdd: (tabId) => seen.push(tabId),
      });
      // upsert 仍挂起,回调必须已带着乐观插入的 tabId 执行过。
      expect(seen).toHaveLength(1);
      expect(store.getBucket('s1').tabs.map((t) => t.id)).toEqual(seen);
      releaseUpsert!();
      const tab = await pending;
      expect(tab.id).toBe(seen[0]);
    });
  });

  describe('addOrFocusSingletonTab', () => {
    it('creates a new tab when no existing tab of that kind', async () => {
      const tab = await store.addOrFocusSingletonTab('s1', 'review', null);
      expect(tab.kind).toBe('review');
      expect(store.getBucket('s1').tabs).toHaveLength(1);
      expect(store.getBucket('s1').activeTabId).toBe(tab.id);
      expect(ipc.upsert).toHaveBeenCalledOnce();
    });

    it('returns the existing tab + setActive when same kind already present', async () => {
      const first = await store.addOrFocusSingletonTab('s1', 'review', null);
      // 切到别的 tab 让 active 不再是 review
      const other = await store.addTab('s1', 'file-browser', null);
      expect(store.getBucket('s1').activeTabId).toBe(other.id);
      ipc.upsert.mockClear();
      ipc.setActive.mockClear();

      const same = await store.addOrFocusSingletonTab('s1', 'review', null);
      // 同一个 review tab,不重建
      expect(same.id).toBe(first.id);
      expect(store.getBucket('s1').tabs).toHaveLength(2);
      // 没新建 → upsert 不该再被调用
      expect(ipc.upsert).not.toHaveBeenCalled();
      // setActive 应该被调用切到 review
      expect(ipc.setActive).toHaveBeenCalledOnce();
      expect(store.getBucket('s1').activeTabId).toBe(first.id);
    });

    it('skips setActive when existing tab is already active', async () => {
      const tab = await store.addOrFocusSingletonTab('s1', 'review', null);
      expect(store.getBucket('s1').activeTabId).toBe(tab.id);
      ipc.setActive.mockClear();
      ipc.upsert.mockClear();

      await store.addOrFocusSingletonTab('s1', 'review', null);
      expect(ipc.setActive).not.toHaveBeenCalled();
      expect(ipc.upsert).not.toHaveBeenCalled();
    });
  });

  describe('closeTab', () => {
    it('removes tab and shifts active to neighbor', async () => {
      const a = await store.addTab('s1', 'file-browser', null);
      const b = await store.addTab('s1', 'file-browser', null);
      const c = await store.addTab('s1', 'file-browser', null);
      // 关 active 的 c → 右邻不存在,降回左邻 b
      await store.closeTab('s1', c.id);
      const after = store.getBucket('s1');
      expect(after.tabs.map((t) => t.id)).toEqual([a.id, b.id]);
      expect(after.activeTabId).toBe(b.id);
    });

    it('rolls back on IPC failure', async () => {
      const a = await store.addTab('s1', 'file-browser', null);
      ipc.close.mockRejectedValueOnce(new Error('boom'));
      await expect(store.closeTab('s1', a.id)).rejects.toThrow('boom');
      expect(store.getBucket('s1').tabs.map((t) => t.id)).toEqual([a.id]);
    });

    it('waits for queued state writes before deleting the tab row', async () => {
      const a = await store.addTab('s1', 'web-browser', { url: 'https://example.com/0' });
      ipc.upsert.mockClear();
      let releaseWrite!: () => void;
      ipc.upsert.mockImplementationOnce(
        () => new Promise<{ ok: true }>((resolve) => {
          releaseWrite = () => resolve({ ok: true });
        }),
      );

      const write = store.patchTabState('s1', a.id, () => ({ url: 'https://example.com/1' }));
      const close = store.closeTab('s1', a.id);
      await Promise.resolve();

      expect(ipc.close).not.toHaveBeenCalled();
      releaseWrite();
      await Promise.all([write, close]);

      expect(ipc.close).toHaveBeenCalledWith({ id: a.id });
      expect(store.getBucket('s1').tabs).toEqual([]);
    });

    it('keeps the tab open when plugin onBeforeClose vetoes', async () => {
      const onBeforeClose = registerVetoPlugin();
      const tab = await store.addTab('s1', 'orca-workers', {});

      await store.closeTab('s1', tab.id);

      expect(onBeforeClose).toHaveBeenCalledWith({}, { tabId: tab.id, sessionId: 's1' });
      expect(store.getBucket('s1').tabs.map((t) => t.id)).toEqual([tab.id]);
      expect(ipc.close).not.toHaveBeenCalled();
    });

    it('lets a tab-level close interceptor veto before plugin onBeforeClose', async () => {
      const onBeforeClose = registerVetoPlugin(vi.fn(async () => true));
      const interceptor = vi.fn(async () => false);
      const tab = await store.addTab('s1', 'orca-workers', {});
      store.setTabCloseInterceptor(tab.id, interceptor);

      await store.closeTab('s1', tab.id);

      expect(interceptor).toHaveBeenCalledOnce();
      expect(onBeforeClose).not.toHaveBeenCalled();
      expect(store.getBucket('s1').tabs.map((t) => t.id)).toEqual([tab.id]);
      expect(ipc.close).not.toHaveBeenCalled();
    });

    it('continues closing after a tab-level close interceptor allows it', async () => {
      const onBeforeClose = registerVetoPlugin(vi.fn(async () => true));
      const interceptor = vi.fn(async () => true);
      const tab = await store.addTab('s1', 'orca-workers', {});
      store.setTabCloseInterceptor(tab.id, interceptor);

      await store.closeTab('s1', tab.id);

      expect(interceptor).toHaveBeenCalledOnce();
      expect(onBeforeClose).toHaveBeenCalledWith({}, { tabId: tab.id, sessionId: 's1' });
      expect(store.getBucket('s1').tabs).toEqual([]);
      expect(ipc.close).toHaveBeenCalledWith({ id: tab.id });
    });

    it('can skip plugin onBeforeClose for post-lifecycle cleanup', async () => {
      const onBeforeClose = registerVetoPlugin();
      const tab = await store.addTab('s1', 'orca-workers', {});

      await store.closeTab('s1', tab.id, { skipBeforeClose: true });

      expect(onBeforeClose).not.toHaveBeenCalled();
      expect(store.getBucket('s1').tabs).toEqual([]);
      expect(ipc.close).toHaveBeenCalledWith({ id: tab.id });
    });
  });

  describe('closeAllTabs', () => {
    it('closes every tab in the session bucket', async () => {
      const a = await store.addTab('s1', 'file-browser', null);
      const b = await store.addTab('s1', 'web-browser', null);
      const c = await store.addTab('s1', 'terminal', null);

      await store.closeAllTabs('s1');

      expect(store.getBucket('s1').tabs).toEqual([]);
      expect(store.getBucket('s1').activeTabId).toBeNull();
      expect(ipc.close).toHaveBeenCalledTimes(3);
      expect(ipc.close).toHaveBeenNthCalledWith(1, { id: a.id });
      expect(ipc.close).toHaveBeenNthCalledWith(2, { id: b.id });
      expect(ipc.close).toHaveBeenNthCalledWith(3, { id: c.id });
    });
  });

  describe('setActiveTab', () => {
    it('updates activeTabId optimistically', async () => {
      const a = await store.addTab('s1', 'file-browser', null);
      const b = await store.addTab('s1', 'file-browser', null);
      await store.setActiveTab('s1', a.id);
      expect(store.getBucket('s1').activeTabId).toBe(a.id);
      // setActiveTab(null) 也支持(关掉所有 tab 时 active=null)
      await store.setActiveTab('s1', null);
      expect(store.getBucket('s1').activeTabId).toBeNull();
      // 确认 b 还在(setActive 不影响 tabs)
      expect(store.getBucket('s1').tabs.map((t) => t.id)).toEqual([a.id, b.id]);
    });
  });

  describe('patchTabState', () => {
    it('updates tab state via patcher and persists via IPC upsert', async () => {
      const a = await store.addTab('s1', 'file-browser', { selectedFilePath: null });
      await store.patchTabState('s1', a.id, (current) => ({
        ...(current as object),
        selectedFilePath: 'x.md',
      }));
      const bucket = store.getBucket('s1');
      expect((bucket.tabs[0].state as { selectedFilePath: string }).selectedFilePath).toBe('x.md');
    });

    it('rolls back state on IPC failure', async () => {
      const a = await store.addTab('s1', 'file-browser', { selectedFilePath: null });
      ipc.upsert.mockClear();
      ipc.upsert.mockRejectedValueOnce(new Error('boom'));
      await expect(
        store.patchTabState('s1', a.id, () => ({ selectedFilePath: 'x.md' })),
      ).rejects.toThrow('boom');
      const bucket = store.getBucket('s1');
      expect((bucket.tabs[0].state as { selectedFilePath: string | null }).selectedFilePath).toBeNull();
    });

    it('serializes DB writes and coalesces the latest pending state per tab', async () => {
      const a = await store.addTab('s1', 'web-browser', { url: 'https://example.com/0' });
      ipc.upsert.mockClear();
      let releaseFirst!: () => void;
      ipc.upsert
        .mockImplementationOnce(
          () => new Promise<{ ok: true }>((resolve) => {
            releaseFirst = () => resolve({ ok: true });
          }),
        )
        .mockResolvedValue({ ok: true });

      const first = store.patchTabState('s1', a.id, () => ({ url: 'https://example.com/1' }));
      const second = store.patchTabState('s1', a.id, () => ({ url: 'https://example.com/2' }));
      const third = store.patchTabState('s1', a.id, () => ({ url: 'https://example.com/3' }));

      expect(ipc.upsert).toHaveBeenCalledTimes(1);
      expect(store.getBucket('s1').tabs[0].state).toEqual({ url: 'https://example.com/3' });

      releaseFirst();
      await Promise.all([first, second, third]);

      expect(ipc.upsert).toHaveBeenCalledTimes(2);
      expect(ipc.upsert).toHaveBeenLastCalledWith(
        expect.objectContaining({ id: a.id, state: { url: 'https://example.com/3' } }),
      );
    });

    it('rolls a failed coalesced write back to the last persisted state', async () => {
      const a = await store.addTab('s1', 'web-browser', { url: 'https://example.com/0' });
      ipc.upsert.mockClear();
      let rejectFirst!: (err: Error) => void;
      ipc.upsert
        .mockImplementationOnce(
          () => new Promise((_, reject) => {
            rejectFirst = reject;
          }),
        )
        .mockRejectedValueOnce(new Error('latest failed'));

      const first = store.patchTabState('s1', a.id, () => ({ url: 'https://example.com/1' }));
      const latest = store.patchTabState('s1', a.id, () => ({ url: 'https://example.com/2' }));
      rejectFirst(new Error('first failed'));

      await expect(first).rejects.toThrow('first failed');
      await expect(latest).rejects.toThrow('latest failed');
      expect(store.getBucket('s1').tabs[0].state).toEqual({ url: 'https://example.com/0' });
    });

    it('retries transient DB worker overload without flashing state back', async () => {
      const a = await store.addTab('s1', 'web-browser', { url: 'https://example.com/0' });
      ipc.upsert.mockClear();
      ipc.upsert
        .mockRejectedValueOnce(new Error('db worker RPC queue overloaded: test'))
        .mockResolvedValueOnce({ ok: true });

      const write = store.patchTabState('s1', a.id, () => ({
        url: 'https://example.com/latest',
      }));
      expect(store.getBucket('s1').tabs[0].state).toEqual({
        url: 'https://example.com/latest',
      });

      await write;
      expect(ipc.upsert).toHaveBeenCalledTimes(2);
      expect(store.getBucket('s1').tabs[0].state).toEqual({
        url: 'https://example.com/latest',
      });
    });
  });

  describe('reorderTabs', () => {
    it('optimistically updates the tab order and persists every id', async () => {
      const a = await store.addTab('s1', 'file-browser', null);
      const b = await store.addTab('s1', 'web-browser', null);
      const c = await store.addTab('s1', 'terminal', null);
      ipc.reorder.mockClear();

      await store.reorderTabs('s1', [c.id, a.id, b.id]);

      expect(store.getBucket('s1').tabs.map((tab) => tab.id)).toEqual([c.id, a.id, b.id]);
      expect(store.getBucket('s1').activeTabId).toBe(c.id);
      expect(ipc.reorder).toHaveBeenCalledWith({
        sessionId: 's1',
        orderedIds: [c.id, a.id, b.id],
      });
    });

    it('rolls the tab order back when persistence fails', async () => {
      const a = await store.addTab('s1', 'file-browser', null);
      const b = await store.addTab('s1', 'web-browser', null);
      ipc.reorder.mockRejectedValueOnce(new Error('boom'));

      await expect(store.reorderTabs('s1', [b.id, a.id])).rejects.toThrow('boom');

      expect(store.getBucket('s1').tabs.map((tab) => tab.id)).toEqual([a.id, b.id]);
    });

    it('persists reorder after older queued state writes have settled', async () => {
      const a = await store.addTab('s1', 'web-browser', { url: 'https://example.com' });
      const b = await store.addTab('s1', 'file-browser', {});
      ipc.upsert.mockClear();
      let releaseWrite!: () => void;
      ipc.upsert.mockImplementationOnce(
        () => new Promise<{ ok: true }>((resolve) => {
          releaseWrite = () => resolve({ ok: true });
        }),
      );

      const write = store.patchTabState('s1', a.id, () => ({ url: 'https://example.com/next' }));
      const reorder = store.reorderTabs('s1', [b.id, a.id]);
      await Promise.resolve();

      expect(store.getBucket('s1').tabs.map((tab) => tab.id)).toEqual([b.id, a.id]);
      expect(ipc.reorder).not.toHaveBeenCalled();

      releaseWrite();
      await Promise.all([write, reorder]);
      expect(ipc.reorder).toHaveBeenCalledWith({
        sessionId: 's1',
        orderedIds: [b.id, a.id],
      });
    });
  });

  describe('invalidateSessionCaches', () => {
    it('keeps pending state writes alive while the renderer host changes', async () => {
      const a = await store.addTab('s1', 'web-browser', { url: 'https://example.com/a' });
      const b = await store.addTab('s1', 'web-browser', { url: 'https://example.com/b' });
      ipc.upsert.mockClear();
      let releaseFirst!: () => void;
      ipc.upsert
        .mockImplementationOnce(
          () => new Promise<{ ok: true }>((resolve) => {
            releaseFirst = () => resolve({ ok: true });
          }),
        )
        .mockResolvedValue({ ok: true });

      const first = store.patchTabState('s1', a.id, () => ({ url: 'https://example.com/a1' }));
      const pending = store.patchTabState('s1', b.id, () => ({ url: 'https://example.com/b1' }));
      store.invalidateSessionCaches();
      releaseFirst();
      await Promise.all([first, pending]);

      expect(ipc.upsert).toHaveBeenCalledTimes(2);
      expect(ipc.upsert).toHaveBeenLastCalledWith(
        expect.objectContaining({ id: b.id, state: { url: 'https://example.com/b1' } }),
      );
      expect(store.getBucket('s1').hydrated).toBe(false);
    });
  });

  describe('subscribe / notify', () => {
    it('fires listener with changed sessionId', async () => {
      const seen: string[] = [];
      const unsubscribe = store.subscribe((sessionId) => seen.push(sessionId));
      await store.addTab('s1', 'file-browser', null);
      await store.addTab('s2', 'web-browser', null);
      expect(seen).toContain('s1');
      expect(seen).toContain('s2');
      unsubscribe();
      seen.length = 0;
      await store.addTab('s3', 'file-browser', null);
      expect(seen).not.toContain('s3');
    });
  });
});

describe('device-link remote sessions (memory-only tabs)', () => {
  it('addTab / hydrate never touch IPC for remote sessionIds', async () => {
    store = await import('../store');
    store._resetStore();
    const stub = makeIpcStub();
    installIpc(stub);

    await store.ensureHydrated('remote-s1');
    const tab = await store.addTab('remote-s1', 'file-browser' as never, null);
    expect(tab.id).toBeTruthy();
    expect(store.getBucket('remote-s1').tabs).toHaveLength(1);
    expect(store.getBucket('remote-s1').activeTabId).toBe(tab.id);
    // FK 保护的核心断言:list / upsert / setActive 全部没被调用。
    expect(stub.list).not.toHaveBeenCalled();
    expect(stub.upsert).not.toHaveBeenCalled();
    expect(stub.setActive).not.toHaveBeenCalled();

    // 本地会话仍走 IPC(边界只对远程生效)。
    await store.addTab('local-s1', 'file-browser' as never, null);
    expect(stub.upsert).toHaveBeenCalledTimes(1);
  });
});
