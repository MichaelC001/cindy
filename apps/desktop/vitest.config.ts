import { defineConfig } from 'vitest/config';
import path from 'node:path';
import { desktopClientBuildEnv } from '../../scripts/shared/client-endpoint-build-env.mjs';

const clientBuildEnv = desktopClientBuildEnv({ allowEnvOverride: false });

export default defineConfig({
  define: {
    // 业务端点烘焙 define 已随端点清单重构退役;测试固定值统一走
    // src/test/vitest/clientEndpointsFixture.ts,不再从生产配置取"真值"。
    'import.meta.env.VITE_ENDPOINT_MANIFEST_BASE_URL': JSON.stringify(
      clientBuildEnv.VITE_ENDPOINT_MANIFEST_BASE_URL,
    ),
    'import.meta.env.VITE_ENDPOINT_MANIFEST_PEER_BASE_URL': JSON.stringify(
      clientBuildEnv.VITE_ENDPOINT_MANIFEST_PEER_BASE_URL,
    ),
  },
  plugins: [
    {
      // 仓库根 scripts/*.mjs 带 shebang(#!/usr/bin/env node)。vite-node 内联
      // 执行这类 root 外模块时不剥 hashbang,包进函数体后成非法 token,
      // ensureDepsElectronBinary.test.ts 在本地(Windows + Node 25 实测)整文件
      // SyntaxError;CI(ubuntu + Node 22)不复现。统一在 transform 前把首行
      // shebang 置空(保留换行,行号不漂移,无需 sourcemap)。
      name: 'strip-hashbang',
      enforce: 'pre' as const,
      transform(code: string) {
        if (code.startsWith('#!')) return { code: code.replace(/^#![^\n]*/, ''), map: null };
        return null;
      },
    },
  ],
  resolve: {
    alias: {
      // Mirror the renderer alias from tsconfig.json so any test that reaches
      // into renderer code can resolve '@/...' the same way the build does.
      '@': path.resolve(__dirname, 'src/renderer'),
      electron: path.resolve(__dirname, 'src/test/vitest/electron-stub.ts'),
    },
  },
  test: {
    globals: true,
    // 多个 worktree 会各自启动完整 Desktop worker 池。用同一 Git common-dir
    // 派生的本机回环锁串行这些测试进程，避免 8-worker 池跨 worktree 相乘；
    // 进程退出后监听端口由操作系统释放，不会留下 stale lock 文件。
    globalSetup: ['src/test/vitest/desktopTestResourceLock.ts'],
    // Main-process tests do real IO (loopback HTTP servers, git subprocesses,
    // heavy module imports through the vite-node transform). On Windows those
    // are markedly slower and, under the full desktop suite's worker-pool
    // contention, light tests intermittently blow past vitest's 5s default and
    // time out non-deterministically (a different test each run). Give Windows
    // a wider default so those pass reliably; keep the standard 5s on
    // Linux/macOS/CI so genuine hangs still surface promptly. Tests that need
    // even more (multi-step real-git orchestration) still set their own higher
    // per-file timeout, which overrides this.
    testTimeout: process.platform === 'win32' ? 20_000 : 5_000,
    // Node 25 默认开启 webstorage,globalThis.localStorage 变成一个未配
    // --localstorage-file 时方法全缺的残缺对象:node 环境下骗过
    // `typeof localStorage !== 'undefined'` 探测,jsdom 环境下又因 key 已存在
    // 顶掉 jsdom 注入的可用实现(vitest 填充全局时跳过已存在的 key)。统一在
    // worker 进程关掉该全局(flag 自 Node 22 起有效),恢复两种环境的原语义;
    // CI(Node 22,webstorage 默认关)上本为 no-op。配置放这里(而非 test 脚本
    // 注 NODE_OPTIONS)是因为根 test-workspaces runner 走 `exec vitest run`
    // 直调、不经 package.json 脚本,只有 config 层对所有入口一致生效。
    poolOptions: {
      threads: { execArgv: ['--no-experimental-webstorage'] },
      forks: { execArgv: ['--no-experimental-webstorage'] },
    },
    // Main-process code is pure Node — no DOM needed. Renderer tests (if/when
    // added) should switch to 'jsdom' via per-file `// @vitest-environment`.
    environment: 'node',
    include: [
      'src/main/__tests__/**/*.test.ts',
      'src/main/**/__tests__/**/*.test.ts',
      'src/renderer/__tests__/**/*.test.ts',
      'src/renderer/**/__tests__/**/*.test.ts',
      // renderer 组件测试(React,tsx):按文件头 `// @vitest-environment jsdom`
      // 切 DOM 环境;此前 include 只收 .test.ts,tsx 用例根本不会被跑。
      'src/renderer/**/__tests__/**/*.test.tsx',
      'src/preload/__tests__/**/*.test.ts',
      // shared 是 main/renderer 共用的纯函数层;此前漏配导致 src/shared/__tests__
      // 下的测试(如 workingDir.test.ts)从未跑过。
      'src/shared/__tests__/**/*.test.ts',
    ],
  },
});
