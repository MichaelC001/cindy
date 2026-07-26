# Desktop 单测性能基准

> **读取时机**：调整 Desktop Vitest worker、测试分池或根级单测资源配额前

## 可复现命令

`benchmark:desktop-workers` 复用 `test-workspaces.config.mjs` 中 Desktop unit tier 的
完整排除规则，不会混入 DB、migration、guard 或 `*.bench.ts`。

```bash
pnpm benchmark:desktop-workers -- --workers 1,2,4,8 --runs 1 --output <report.json>
```

报告包含机器信息、墙钟、文件数、测试数、文件耗时 P50/P95/P99 和最慢文件。调整 worker
或分池前后必须使用同一 checkout、同一机器和同一测试范围比较；单次数据需同时保留稳定性
结果，不得只挑最快的一次。

## 2026-07-26 Windows 基线

环境：Windows x64、Node v24.15.0、32 available CPUs、63.8 GiB RAM。测试范围为
1,213 个文件、13,062 个测试。

| Workers | 结果 | 墙钟 | 相比上一档 | 相比 1 worker |
|---:|---|---:|---:|---:|
| 1 | 通过 | 710.6s | — | 1.00x |
| 2 | 通过 | 353.7s | -50.2% | 2.01x |
| 4 | 通过 | 183.5s | -48.1% | 3.87x |
| 8 | 通过 | 108.3s | -41.0% | 6.56x |

8-worker 复跑为 114.9s，说明该档在本机约为 108–115s。2-worker 首次运行曾在 116.7s
触发一次 `ERR_IPC_CHANNEL_CLOSED`，重跑 353.7s 通过；worker 数降低本身不能消除
Vitest/tinypool fork 通道的偶发退出问题。

随着 workers 增加，所有文件自身耗时之和从 247.0s（1 worker）升至 317.5s（8
workers），说明存在资源争用；但墙钟仍持续下降。当前单池的速度候选是 8 workers，后续
分池需要验证能否隔离高争用文件，在不继续放大总 worker 预算的前提下进一步缩短墙钟。

## 长尾分布

8-worker 复跑中，最慢 200 个文件按路径聚合：

| 路径 | 文件数 | 文件耗时之和 |
|---|---:|---:|
| `src/main/git-review/**` | 10 | 180.7s |
| `src/main/__tests__/**` | 27 | 49.7s |
| `src/renderer/**` | 92 | 31.8s |
| `src/main/hook-control/**` | 1 | 11.9s |

最慢的单文件主要是创建真实 Git 仓库或子进程的测试：

| 文件 | 8-worker 文件耗时 |
|---|---:|
| `git-review/__tests__/stageOps.test.ts` | 42.1s |
| `git-review/__tests__/pushOps.test.ts` | 28.6s |
| `git-review/__tests__/branchReader.test.ts` | 23.8s |
| `main/__tests__/codexFileRewindExecutor.test.ts` | 23.4s |
| `git-review/__tests__/ipc.test.ts` | 22.0s |
| `git-review/__tests__/diffReader.test.ts` | 19.5s |

因此分池优先按“真实 Git／子进程长尾”和“其余测试”隔离，而不是只按 node/jsdom 环境
机械拆分。
