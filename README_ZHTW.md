# aifsmjs

小型 deterministic FSM 函式庫，適合可 replay 的 TypeScript/JavaScript state machine。Definition 是 plain data；guards/actions/effects 在 runtime 注入。

> **狀態：0.6.0 - 穩定 1.0 軌道核心。** Core FSM、guards、effects、inspect、replay、PBT helpers、scheduler、sub-machines 都已可用。

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
| `aifsmjs/effects` | `createEnqueuer()` 與 `runEffects()`。 |
| `aifsmjs/inspect` | Read-only middleware helpers：`logger`、`persist`、`recorder`。 |
| `aifsmjs/replay` | 純 event-log replay。 |
| `aifsmjs/pbt` | fast-check property helpers。 |
| `aifsmjs/timer` | `after()` 與 `createScheduler()`。 |

## Lifecycle Rules

- `step(def, snapshot, event, impl)` 是 pure function，回傳 `{ snapshot, effects, changed }`。
- `createRuntime()` 持有 mutable runtime state。每個 event 先 commit，再依序執行 middleware、effects、`subscribe` listeners 與 `'transition'` listeners。
- `send()`/`reset()` 採 run-to-completion：在 middleware、effect handler 或 listener 內的呼叫會排入佇列，等目前 event 的通知全部完成後，再以同樣的完整流程執行。
- Guards 與 reducers 必須同步。Thenable guards 會丟 `AsyncGuardError`。
- Effects 是 fire-and-forget descriptors。Async rejection 會送到 runtime `"error"` channel；沒有 `"error"` listener 時會被丟棄（非 production 環境會 `console.warn`）。
- `reset()` 會回到 initial snapshot 且不執行 entry actions；只要 value、status 或 context 參照有變，就會通知 listeners。
- `dispose()` 可重複呼叫；dispose 後 `send()`/`reset()` 會丟 `RuntimeDisposedError`。
- 傳給 `defineMachine`、`createRuntime` 與 runtime 方法的參數不正確時，會丟 `InvalidDefinitionError`。

## 注意事項

- Middleware、同步 effect 與 subscriber 的 throw 發生在 snapshot commit 之後；可能留下已 commit 的 snapshot 但後續通知中斷，並丟棄佇列中尚未執行的 `send()`/`reset()`。
- 巢狀 `send()` 回傳的是呼叫當下已 commit 的 snapshot，而不是它自己 event 的結果。請在最外層呼叫回傳後再讀 `getSnapshot()`，或改用 subscribe。
- 通知進行中被移除的 listener（unsubscribe、`once`、`signal`、`dispose()`）在該輪剩下的部分會被略過。
- Middleware 不會凍結你的 event，但會深度凍結 effect descriptors，包含你當作 payload 傳入的物件。
- Context 是物件時，action 必須回傳 plain-object patch（或不回傳）；合併會保留 context 的原型。回傳 `false`、`0` 或 `""` 會丟 `InvalidActionResultError`。建議使用 plain-object context。
- Sub-machine replacement 會先建立新 child：init failure 時舊 child 仍然有效；dispose failure 時舊 child 已被 teardown，新 child 會被捨棄。
- 若外部自行 dispose child，`subRuntime()` 可能回傳 disposed handle；只有 parent 離開並重新進入 sub state 才會重建。
- `setup().defineMachine()` 使用 `NoInfer`，讓 states 從 `keyof states` 推斷；請保留 exact optional property 的回歸測試。
- `after()` 遇到 `NaN`、`Infinity` 或負數延遲會丟 `RangeError`，超過 2^31-1 毫秒（約 24.8 天）的延遲會被截為 2^31-1。若要表示「永不觸發」，就不要排程。
- 不要在 guards 或 actions 內做 async I/O；請從 effects 發事件回來。

## AI Context

- 短索引：[`llms.txt`](llms.txt)
- 完整生成內容：[`llms-full.txt`](llms-full.txt)
- 穩定度契約：[`STABILITY.md`](STABILITY.md)
- 目前 review backlog：[`REVIEW.md`](REVIEW.md)
- 版本紀錄：[`CHANGELOG.md`](CHANGELOG.md)

## License

MIT
