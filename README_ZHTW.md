# aifsmjs

小型 deterministic FSM 函式庫，適合可 replay 的 TypeScript/JavaScript state machine。Definition 是 plain data；guards/actions/effects 在 runtime 注入。

> **狀態：0.5.6 - 穩定 1.0 軌道核心。** Core FSM、guards、effects、inspect、replay、PBT helpers、scheduler、sub-machines 都已可用。

## 安裝

```bash
pnpm add aifsmjs
```

```ts
import { assign, createRuntime, setup } from "aifsmjs";
```

## 快速開始

```ts
type Ctx = { ticks: number };
type Evt = { type: "NEXT" };

const trafficLight = setup<Ctx, Evt>().defineMachine({
  id: "trafficLight",
  initial: "red",
  context: { ticks: 0 },
  states: {
    red: { on: { NEXT: { target: "green", actions: ["bump"] } } },
    green: { on: { NEXT: { target: "yellow", actions: ["bump"] } } },
    yellow: { on: { NEXT: { target: "red", actions: ["bump"] } } },
  },
});

const runtime = createRuntime(trafficLight, {
  actions: {
    bump: assign(({ context }) => ({ ticks: context.ticks + 1 })),
  },
});

runtime.send({ type: "NEXT" });
console.log(runtime.getSnapshot().value); // "green"
```

一般情況請用 `setup<Ctx, Evt>().defineMachine()` 讓 states 自動推斷；需要完整 generic 控制時再用裸 `defineMachine<Ctx, Evt, States>()`。

## Public Surface

| Import | 用途 |
| --- | --- |
| `aifsmjs` | `setup`、`defineMachine`、`createRuntime`、`createMachine`、`step`、`assign`、snapshots、runtime/errors/types。 |
| `aifsmjs/guards` | `and`、`or`、`not`、`stateIn`。Guard 必須同步。 |
| `aifsmjs/effects` | `enqueue.effect()` descriptor 與 `runEffects()`。 |
| `aifsmjs/inspect` | Read-only middleware helpers：`logger`、`persist`、`recorder`。 |
| `aifsmjs/replay` | 純 event-log replay。 |
| `aifsmjs/pbt` | fast-check property helpers。 |
| `aifsmjs/timer` | `after()` 與 `createScheduler()`。 |

## Lifecycle Rules

- `step(def, snapshot, event, impl)` 是 pure function，回傳 `{ snapshot, effects, changed }`。
- `createRuntime()` 持有 mutable runtime state，commit 後 dispatch effects，並送出 transition/error/dispose events。
- Guards 與 reducers 必須同步。Thenable guards 會丟 `AsyncGuardError`。
- Effects 是 fire-and-forget descriptors。Async rejection 會送到 runtime `"error"` channel。
- `reset()` 會回到 initial snapshot 並通知 listeners，但不執行 entry actions。
- `dispose()` 可重複呼叫；dispose 後 `send()`/`reset()` 會丟 `RuntimeDisposedError`。

## 注意事項

- Middleware 與同步 effect throw 發生在 snapshot commit 之後；可能留下已 commit snapshot 但後續通知中斷。
- Sub-machine replacement 在 init failure 時可 rollback，但 dispose failure 時舊 child 已被 teardown。
- 若外部自行 dispose child，`subRuntime()` 可能回傳 disposed handle；只有 parent 離開並重新進入 sub state 才會重建。
- `setup().defineMachine()` 使用 `NoInfer`，讓 states 從 `keyof states` 推斷；請保留 exact optional property 的回歸測試。
- 不要在 guards 或 actions 內做 async I/O；請從 effects 發事件回來。

## AI Context

- 短索引：[`llms.txt`](llms.txt)
- 完整生成內容：[`llms-full.txt`](llms-full.txt)
- 穩定度契約：[`STABILITY.md`](STABILITY.md)
- 目前 review backlog：[`REVIEW.md`](REVIEW.md)
- 版本紀錄：[`CHANGELOG.md`](CHANGELOG.md)

## License

MIT
