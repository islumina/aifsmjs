# aifsmjs

[![npm version](https://img.shields.io/npm/v/aifsmjs.svg)](https://www.npmjs.com/package/aifsmjs)
[![CI](https://github.com/yshengliao/aifsmjs/actions/workflows/ci.yml/badge.svg)](https://github.com/yshengliao/aifsmjs/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-MIT-brightgreen.svg)](LICENSE)
[![AI Generated](https://img.shields.io/badge/AI_Generated-Claude_Code_Opus_4.7_Max-blueviolet.svg)](https://www.anthropic.com/claude-code)
[![English](https://img.shields.io/badge/lang-English-blue.svg)](README.md)

> 一個小而嚴格的 FSM library，為任何需要可重現、可重播狀態流轉的 TypeScript/JS app 而生：把 lifecycle 寫成 pure `step()`，把 Chain-of-Responsibility 直覺收斂到 cross-cutting concerns（observe / persist / replay）── 而非 transition 主流程。

隸屬 [ai\*js micro-runtime 生態系](https://github.com/yshengliao) ─ 另見 [aibridgejs](https://github.com/yshengliao/aibridgejs)（cross-context RPC）與 [aiecsjs](https://github.com/yshengliao/aiecsjs)（ECS）。

**主要受眾**：所有處理 stateful flow 的工程師 ── 多步驟表單、checkout 流程、auth flow、教學引導步驟、文件審批狀態機、互動 app 的 scene flow，以及瀏覽器遊戲的相同模式（PixiJS / Svelte 5 / 純 Canvas / WebGL）。Library 本身**環境中立**（pure core + adapter 邊界）：browser、Node、Bun、Deno、Flutter WebView、Web Worker 全部都跑。Roadmap 段把遊戲特有的便利功能（tick hook、ECS bridge）保留為 opt-in subpath，不進 core surface。

---

## 為什麼有 aifsmjs

從 C# 帶著 CoR 慣性轉到 JS/TS 的人，通常會把 lifecycle 拆成可中止的 middleware chain，這在 FSM 領域會破壞 determinism 與 replay 能力。網頁遊戲對「可重放、可序列化、可在 worker 跑」的需求尤其重，aifsmjs 反其道：

- **Lifecycle 是 pure function**：`step(def, snapshot, event, impl)` 一次完成 `guards → exit → action → entry`，順序固定、不可中止、不可注入。
- **CoR 思維只用在橫切層**：`inspect/` 提供 Koa-style middleware pipeline，但只能觀察 snapshot 與發出事件，**不能改 transition 結果**。
- **Definition 純資料**：guards / actions / effects 用 string ref 引用，runtime 才注入實作。可序列化、可在 Web Worker 之間傳遞、可存 DB。
- **PBT first-class**：內建 `fast-check` `fc.commands` adapter 與 6 條 generic property tests，市場目前沒有同類產品做這件事。

對應到既有生態：思路接近 Robot3 的 functional composition + XState v5 的 `and/or/not` guard 組合子 + `@xstate/store` v3 的 `enq.effect()` 雙軌副作用，core 實測 ~2.8KB ESM gzipped（v0.1.0），每個 opt-in subpath 獨立可 tree-shake。

---

## Quick Start

```bash
pnpm add aifsmjs
```

```typescript
import { setup, createRuntime, assign } from "aifsmjs";

type Ctx = { ticks: number };
type Evt = { type: "NEXT" };

// 1. Definition 是純資料；setup<Ctx, Evt>() 後 States 由 states keys 自動推導
const trafficLight = setup<Ctx, Evt>().defineMachine({
  id: "trafficLight",
  initial: "red",
  context: { ticks: 0 },
  states: {
    red:    { on: { NEXT: { target: "green",  actions: ["bump"] } } },
    green:  { on: { NEXT: { target: "yellow", actions: ["bump"] } } },
    yellow: { on: { NEXT: { target: "red",    actions: ["bump"] } } },
  },
});

// 2. Implementations 是 runtime 才注入的函式
const runtime = createRuntime(trafficLight, {
  actions: {
    bump: assign(({ context }) => ({ ticks: context.ticks + 1 })),
  },
});

// 3. 互動
runtime.send({ type: "NEXT" });
console.log(runtime.getSnapshot().value);   // "green"
console.log(runtime.getSnapshot().context); // { ticks: 1 }
```

> 也可以用 `defineMachine<Ctx, Evt, States>({...})` 直接傳三個型別參數（escape hatch；當你需要對 union event types 完全顯式控制時）。一般情況下 `setup().defineMachine()` 更省事。

---

## Mental Model

```
┌──────────────────────┐       ┌──────────────────────┐
│  MachineDefinition   │       │   Implementations    │
│  (純資料、可序列化)   │  +    │  (guards/actions/     │
│  • states            │       │   effects fn map)    │
│  • on / target       │       │                      │
│  • string refs       │       │                      │
└──────────┬───────────┘       └──────────┬───────────┘
           │                              │
           └──────────────┬───────────────┘
                          ▼
              ┌────────────────────────┐
              │  step(def, snap, evt,  │  ← pure function
              │       impl)            │     固定順序、不可中止
              └───────────┬────────────┘
                          ▼
              ┌────────────────────────┐
              │   { snapshot,          │
              │     effects: [...] }   │     effects 由 caller
              └───────────┬────────────┘     決定何時 dispatch
                          ▼
              ┌────────────────────────┐
              │  createRuntime(...)    │  ← 薄包裝
              │  state holder + send   │
              └────────────────────────┘
```

三個分層完全解耦：你可以單獨拿 `step()` 做 replay、或單獨拿 `MachineDefinition` 做 visualization，runtime 只是把這兩個黏起來的便利層。

---

## Capabilities / Limitations

| 會做（v1）                                          | 不會做                                            |
| --------------------------------------------------- | ------------------------------------------------- |
| Flat states + transitions                           | Parallel state regions                            |
| 透過 `state.sub` 的階層式 sugar（stable since 0.4.0） | Definition 內直接綁 closure（會無法序列化）    |
| Guards（sync only；inline async 在 `defineMachine` 時丟 `InvalidDefinitionError`；runtime 偵測到 thenable 回傳則丟 `AsyncGuardError`） | Async guards                                      |
| Actions（assign + enqueue effects）                 | 在 action 內呼叫 async API（請放到 effect）        |
| Fire-and-forget effects                             | Actor invocation / spawn                          |
| Read-only inspect middleware                        | 可中止 transition 的 middleware                   |
| `replay(initial, log, def, impl)` 純函式             | Time travel debugger（v2 再評估）                  |
| `fast-check` `fc.commands` adapter                   | 自家 PBT framework                                 |
| String ref + runtime injection                      | 從 root 一次 import 全部                           |
| Tree-shake friendly subpath exports                  | ECS / Pixi bridges（opt-in subpath，不進 core）   |

---

## Design Philosophy

<details>
<summary>為何 lifecycle 不能套 middleware（點開展開）</summary>

UML statechart 與 SCXML 都規定 `exit → transition action → entry` 是 atomic sequence。一旦允許中間 handler 呼叫 `next()` 或丟錯中止，就會出現「進入新 state 但舊 state 沒 exit」的無效狀態，破壞：

1. **Determinism**：同一 event sequence 不再保證得到同一 snapshot。
2. **Replay**：event log 無法在獨立環境重現結果。
3. **PBT shrinking**：fast-check 的反例最小化前提是 deterministic state machine。

XState v5 從 v4 的「actions 順序不穩」教訓走到 `predictableActionArguments` 不再需要存在（永遠 predictable），就是這個教訓。Spring StateMachine 把可中止的 Interceptor 標為「relatively deep internal feature」也是同一原因。

所以 aifsmjs 把 CoR 的 chain 思維拆兩半：

| 場景                | 處理方式                                            |
| ------------------- | --------------------------------------------------- |
| Guard 鏈式判斷       | `and/or/not` 三個 higher-order combinators          |
| Action 多步驟順序    | `actions: [...]` array，按序執行、跑完為止          |
| 跨橫切（log/persist）| `inspect/` middleware，僅讀，無中止能力             |

</details>

<details>
<summary>為何 definition 是純資料</summary>

只要 definition 含 closure，就無法：

- 透過 `JSON.stringify` 存 DB / localStorage
- 透過 `postMessage` 傳到 Web Worker
- 透過 visualizer 工具靜態分析 reachability
- 透過 PBT adapter 自動產生 event arbitraries

aifsmjs 走 XState v5 `setup().createMachine()` 雙階段路線：definition 用 string ref，`createRuntime()` 時才注入 fn map。Inline function 仍允許，但標為 escape hatch。

</details>

---

## Core API

### `defineMachine<C, E, S>(def)`

```typescript
function defineMachine<
  Ctx,
  Evt extends { type: string },
  States extends string,
>(def: MachineDef<Ctx, Evt, States>): MachineDef<Ctx, Evt, States>;
```

純資料 builder。會 freeze 整個 def 並驗證 `initial` 在 `states` 集合內。

### `createRuntime(def, impl, opts?)`

```typescript
function createRuntime<C, E, S>(
  def: MachineDef<C, E, S>,
  impl: Implementations<C, E>,
  opts?: { middleware?: readonly Middleware<C, E, S>[] },
): Runtime<C, E, S>;

interface Runtime<C, E, S> {
  getSnapshot(): Snapshot<C, S>;
  send(event: E): Snapshot<C, S>;
  subscribe(listener: (snap: Snapshot<C, S>) => void): () => void;
  reset(event?: E): Snapshot<C, S>;
  dispose(): void;
  readonly disposed: boolean;
  readonly signal: AbortSignal;
}
```

薄包裝。內部呼叫 `step()` 並 dispatch effects。`dispose()` 會 abort 內建 `AbortController`、清空 listeners，並讓後續的 `send()` / `reset()` 丟 `RuntimeDisposedError`。`reset()` 把 snapshot 拉回 `initialSnapshot(def)`、觸發 listeners，但**不會跑 entry actions**（reset 是「整個 runtime 回出生點」，不是 transition）。

`runtime.signal` 是這個 runtime 的生命週期 signal，會在 dispose 時 abort 一次。被傳進每個 `EffectHandler` 的 `args.signal`；外部整合（React unmount、game scene teardown）也可以 `runtime.signal.addEventListener("abort", ...)` 串自己的收尾。

### `step(def, snapshot, event, impl)`

```typescript
function step<C, E, S>(
  def: MachineDef<C, E, S>,
  snapshot: Snapshot<C, S>,
  event: E,
  impl: Implementations<C, E>,
): { snapshot: Snapshot<C, S>; effects: readonly Effect[] };
```

**Pure function**。整個 library 的 invariant 守護者。不會 dispatch effects、不會 mutate snapshot。Guard 沒過或 event 沒對應 transition 就回原 snapshot（不改變）。誤用（`UnknownGuardError`、`UnknownActionError`、`AsyncGuardError`）才會丟錯，讓配接錯誤在開發期間立即浮現、不被靜默略過。

### `assign(updater)`

```typescript
function assign<C, E>(
  updater: (args: { context: C; event: E }) => Partial<C>,
): Action<C, E>;
```

純 context 更新 helper。回傳新 context（partial merge），不含副作用。

---

## Opt-in Modules

每個 opt-in 都是獨立 subpath，不引入則 tree-shake 完全清除。

### `aifsmjs/guards` — Guard combinators

```typescript
import { and, or, not, stateIn } from "aifsmjs/guards";

const canCheckout = and([
  "isAuthenticated",
  or(["isAdmin", "isOwner"]),
  not("isBanned"),
]);
```

`and/or/not` 對 sync guard 做短路求值。`stateIn(...states)` 是常用 sugar：「目前 state 在這群之內就通過」。

### `aifsmjs/effects` — Fire-and-forget effects

```typescript
import { type Action } from "aifsmjs";

const checkout: Action<Ctx, Evt> = ({ context, enqueue }) => {
  enqueue.effect("trackAnalytics", { event: "checkout", ctx: context });
  // 回傳值代表新 context（不回傳則沿用舊 context）
};
```

`enqueue.effect(type, payload)` 把副作用宣告排隊，由 `step()` 收集後回傳給 caller。Runtime 預設在 transition 完成後 dispatch；replay 模式下可關掉 dispatch，只做 snapshot fold。

### `aifsmjs/inspect` — Read-only middleware

```typescript
import { createRuntime } from "aifsmjs";
import { logger, persist } from "aifsmjs/inspect";

const runtime = createRuntime(def, impl, {
  middleware: [
    logger(console.log),
    persist({ key: "machine-state", storage: localStorage }),
  ],
});
```

Koa-style `(ctx, next) => void` pipeline。`ctx` 是 `{ prev, next, event, effects, changed }`，全部 deep-frozen。**不能中止 transition**——`next()` 必呼叫，回傳值無語意。

### `aifsmjs/replay` — Pure event log replay

```typescript
import { replay } from "aifsmjs/replay";

const finalSnap = replay(initialSnapshot, eventLog, def, impl);
// 等價於 eventLog.reduce((s, e) => step(def, s, e, impl).snapshot, initial)
```

不會 dispatch effects。用於 PBT、time-travel debug、incident reproduction。

### `aifsmjs/pbt` — fast-check adapter

> **需另裝 peer**：`pnpm add -D fast-check`（^3.20.0）。aifsmjs 把 fast-check 列為 optional peer dependency，使用 pbt 模組才需安裝。

```typescript
import fc from "fast-check";
import { createRuntime } from "aifsmjs";
import { commandsFromMachine, initialModel, properties } from "aifsmjs/pbt";

// 用任一內建 generic property，或 assertAll 一次跑全部：
properties.replayEqualsFold(def, impl, {
  NEXT: fc.constant({ type: "NEXT" as const }),
});

// 或用 commandsFromMachine 自訂 property：
fc.assert(
  fc.property(
    commandsFromMachine(def, impl, {
      NEXT: fc.constant({ type: "NEXT" as const }),
    }),
    (cmds) => {
      const real = createRuntime(def, impl, { dispatchEffects: false });
      fc.modelRun(() => ({ model: initialModel(def), real }), cmds);
      return true;
    },
  ),
);
```

`properties.*` 提供 6 條 generic property（見 [Testing Strategy](#testing-strategy)）。fast-check 是 `peerDependenciesMeta.optional`，不裝就不用付。

### `aifsmjs/timer` — Cancellable delayed callbacks

```typescript
import { after, createScheduler } from "aifsmjs/timer";

// One-shot
const handle = after(5000, () => runtime.send({ type: "TIMEOUT" }));
handle.cancel(); // 還沒燒到的話，取消

// 與 AbortSignal 整合
const ac = new AbortController();
after(5000, () => runtime.send({ type: "TIMEOUT" }), { signal: ac.signal });
ac.abort(); // 同樣取消

// Scheduler：把一群 timers 綁在一起，destroy 時 cancelAll
const sched = createScheduler();
sched.after(1000, () => {});
sched.after(2000, () => {});
sched.cancelAll();
```

- 純包 `setTimeout` / `clearTimeout`，可注入測試替身（vitest fake timers 已驗證）
- AbortSignal listener 用 `{ once: true }` 註冊，避免 leak
- 與 FSM 本體解耦：你自己決定何時把 timer 燒出的事件 `runtime.send(...)`

---

## Lifecycle Invariants

`step()` 的固定順序（永遠如此，無法改變）：

```
1. resolveTransitions(def, snapshot.value, event)
       → 拿到該 event 在此 state 上的候選 transitions
2. evaluate guard on each candidate, in declaration order
       → 第一個通過的 transition 被選中；都沒通過則回原 snapshot
3. exit actions of old state         （目前 v1 為單層，無階層）
4. transition.actions[]，按宣告順序循序執行
       → 每個 action 可呼叫 enqueue.effect()
       → 每個 action 的回傳 partial ctx 會 merge 到 current ctx
5. entry actions of new state
6. 回傳 { snapshot, effects } — caller 決定何時 dispatch effects
```

**契約**：

保證：

- Guards 永遠 sync、永遠 pure（不 mutate ctx）
- Actions 永遠跑完（無中止機制）
- Effects 是宣告（type + payload），不是 callback —— 序列化友善
- Snapshot 不可變；dev mode deep-freeze 偵錯，prod shallow 省效能

不做：

- async lifecycle hook
- Inspect middleware 影響 transition 結果

### Sub-machine lifecycle（stable since 0.4.0）

當一個 state 宣告 `sub` 時，每次 transition 的執行順序為：

1. Parent `step()` 執行：`exit actions → transition.actions → entry actions`。
2. 舊 child（若有）`dispose()` — 同步執行；例外會包成 `SubMachineError(phase: "dispose")`。
3. 新 child（若 next state 有 `sub`）實例化 — 例外會包成 `SubMachineError(phase: "init")`。
4. Parent snapshot 確認提交。
5. Middleware pipeline 執行。
6. Effects 派發。
7. `'transition'` 事件發給 `on()` / `onTransition()` 的訂閱者。

若步驟 2 或 3 丟例外，parent snapshot **不會**提交（回滾至 `prev`）；middleware、effects、`'transition'` 都不會執行。

`runtime.dispose()` 透過 `controller.signal` 的 abort listener 以及顯式的 `child.dispose()` 呼叫，將 dispose 行為串聯到 child。Cascade 會吞掉 child 的例外，以遵守永不丟錯的 dispose 契約。

---

## Lifecycle Protocol

aifsmjs 是「極簡 AI 工具鏈」家族的第一個套件，這條 lifecycle protocol 會被未來的 `aitaskjs / aibridgejs / aiaudiojs` 等共用：

| 動詞 | aifsmjs 對應 | 語意 |
|---|---|---|
| `createX()` | `createRuntime` / `createScheduler` / `defineMachine` / `setup` | 工廠 fn，回傳值即「實例」 |
| `dispose()` | `runtime.dispose()` / `scheduler.cancelAll()` | 釋放資源；idempotent；post-dispose API 拋已知 error |
| `reset()` | `runtime.reset()` | 把狀態歸零，不釋放資源 |
| `on/off` | `runtime.subscribe(fn)` 回傳 unsubscribe | 訂閱模式；明寫 unsubscribe |
| `AbortSignal` | `runtime.signal` / `after(_, _, { signal })` | 所有 long-running / async 任務的取消通道 |
| Pure core | `step()` | 不碰 I/O、可序列化、可 replay |
| Error 明寫 | `RuntimeDisposedError` / `UnknownGuardError` / `UnknownActionError` / `InvalidDefinitionError` | named error class，不靠 throw string |

未來其他 ai\*js 套件遇到「該不該加 dispose？」「signal 怎麼接？」這類問題，以此表為 baseline。

---

## 設計取捨：與常見模式的差異

aifsmjs 在幾個常見議題上做了刻意取捨，跟主流 FSM library 寫法不同。把理由寫在這裡，從 XState、statecharts、或一般 event-emitter library 過來的讀者不必跳進 source 就能掌握。

- **`send()` 是同步、回傳 `Snapshot` 而非 `Promise<Snapshot>`**。Pure `step()` 設計上就是 sync，`replay(initial, log)` 與 PBT shrinking 才能單純。Effect handler 仍可 async；runtime 觸發後忽略結果，async rejection 走 `'error'` event channel。要 await effect 完成的人可自己包一層 `Promise.all`。
- **Guards / reducers 只能 sync**。非確定性 guard 會破壞 PBT determinism property (#1)。把 async 改寫成 event：先送 `FETCH_REQUEST`，handler 完成後送 `FETCH_DONE`，payload 帶結果。
- **Effects 是描述子，不是 inline callback**。Action 透過 `enqueue.effect(type, payload?)` 排隊；runtime 收集後 dispatcher 才執行 user handler。好處：machine definition 可序列化（沒 inline fn 時 JSON round-trip）、`replay()` 可把 event log 摺成同樣 snapshot、`inspect/persist` middleware 抓得到 effects 做 audit log。
- **兩種 factory 並存**。`setup<Ctx, Evt>().defineMachine(...)` 是型別友善版（States 從 `keyof states` 推導）。`createMachine(def, impl, opts?)` 是來自 ai*js 生態 spec 的 single-factory 捷徑。顯式 `defineMachine<Ctx, Evt, States>(def)` 仍保留作完全顯式控制。看 call site 哪個讀起來順手就用哪個。
- **`subscribe(listener)` 與 `on(type, fn, { signal, once })` 並存**。Typed `on()` 對齊平台 `EventTarget` 語意（signal + once），emit `'transition'`、`'error'`、`'dispose'`。原本的 `subscribe()` 保留 React `useSyncExternalStore` shape，可直接傳。兩者不互斥。

---

## AI-Agent Reading Guide

> 此區塊為 LLM 與 code-search agent 量身設計，把不變量、型別、誤用模式集中於此。

### Serializable fields

下列欄位皆為 plain data，可 `JSON.stringify` round-trip：

- `MachineDef` 全結構（前提：未用 inline fn）
- `Snapshot` 全結構（前提：`context` 為 plain data）
- `Effect` 全結構（`{ type: string; payload?: unknown }`）

下列**不可序列化**，會破壞 PBT/replay：

- `Implementations` 內所有 fn
- Middleware closure

### Invariants（請勿違反）

1. `step()` 是 pure：對同 `(def, snapshot, event, impl)` 必回相同 `{ snapshot, effects }`。
2. Snapshot frozen：dev mode 違反 freeze 立即拋錯。
3. Guards never mutate context：違反者 PBT property #2 會抓到。
4. Effects 永遠 fire-and-forget：runtime 不等 effect 完成才更新 snapshot。
5. `dispose()` idempotent；post-dispose 呼叫 `send()` / `reset()` 拋 `RuntimeDisposedError`。
6. `runtime.signal.aborted` 在 dispose 後永遠為 `true`；effect handler 拿到的 signal 即此。
7. `reset()` 只重置 snapshot 與通知 listener，**不跑 entry actions**；listeners 只在 `prev.value !== initial.value` 時被通知（與 `send()` 對齊）。Middleware 永遠看得到該次呼叫（含 `changed: false`）。
8. `MiddlewareContext.event` 是 `Evt | ResetEvent`；無事件的 `reset()` 會塞入 `RESET_EVENT_TYPE` (`"@@aifsmjs/RESET"`) 哨兵。

### Common misuses

| 反模式                                              | 正確寫法                                                |
| --------------------------------------------------- | ------------------------------------------------------- |
| 在 guard 內呼叫 `fetch()` 等 async API              | 把 async 改寫成 event：先送 `FETCH_REQUEST`，handler 完成後送 `FETCH_DONE` |
| 在 action 內 `setTimeout` 後 mutate context          | 改用 `enqueue.effect("delayedThing", ...)`              |
| 用 middleware 攔截並改變 next state                 | 不可能；middleware 為 read-only。改寫成 guard。           |
| Definition 內直接寫 inline fn（可行但破壞序列化）   | 拆出 string ref，於 `createRuntime` 注入                |

### Machine-readable schema

`MachineDef` 的 JSON schema 之後將發佈於 `dist/schema/machine.schema.json`。v1 階段尚未提供，但型別定義集中在 [src/fsm/types.ts](src/fsm/types.ts)，agent 可從 TS 型別直接推導。

---

## Testing Strategy

例子驅動為主，PBT 補強。借鑑 jssm 的教訓：「3000+ tests / 100% coverage」中只有 < 12% coverage 來自 stochastic tests，其餘來自 example specs。

- **Example tests**（vitest）：對每個 src module 寫 happy path + 邊界 + error message 三類。
- **PBT smoke**：每條 generic property 跑 50 runs，作為 invariant guard，不追求 coverage。
- **CI 強制門檻**：`@vitest/coverage-v8` 設 **100% statements / 100% lines / 100% functions / ≥90% branches**。少數 defensive invariant-guard 分支（例如 runtime determinism mismatch）標 `/* v8 ignore */` 並寫明原因。
- **Size budget**：`scripts/check-size.mjs` 在 CI 檢查每個 subpath gzip 大小，超過預算（core ≤4.7 KB、replay ≤1.8 KB、pbt ≤5.5 KB、其他 ≤1 KB；0.3.0 為了 sub-machine sugar 提高 core / pbt 上限）即 fail。

### 內建的 6 條 generic properties

| #   | Property                          | 一句話                                              |
| --- | --------------------------------- | --------------------------------------------------- |
| 1   | snapshotAlwaysFrozen              | 任意 event 序列後，snapshot 仍 frozen               |
| 2   | unknownEventNoOp                  | 未宣告 event 不會改變 snapshot                      |
| 3   | reachableStatesSubsetDeclared     | 跑到的所有 state 必在 `def.states` 集合內           |
| 4   | replayEqualsFold                  | `replay(init, log)` 等價於 `events.reduce(step)`    |
| 5   | guardsFalseNoTransition           | 所有 guards 失敗時 state 不變                       |
| 6   | assignDoesNotMutate               | `assign` 不修改前一個 ctx                           |

---

## Comparison

|                            | aifsmjs        | XState v5         | Robot3            | @xstate/store     | Zag.js            |
| -------------------------- | -------------- | ----------------- | ----------------- | ----------------- | ----------------- |
| Core size (gzip)           | ~2.8KB         | ~15KB             | ~1KB              | < 1KB             | per-component     |
| Hierarchical states         | Sugar (0.3.0)  | Yes               | No                | N/A               | Yes               |
| Async invoke / actor        | No             | Yes               | No                | N/A               | No                |
| Guard combinators           | and/or/not     | and/or/not        | No                | N/A               | No                |
| Effects 雙軌                | enqueue        | enqueueActions    | reduce/action     | enq.effect()      | array of names    |
| Inspect / observe           | read-only      | inspect API       | No                | 社群提案中        | watch ctx         |
| Serializable definition     | Yes            | Yes               | Partial           | Partial           | Yes               |
| fast-check adapter          | built-in       | No                | No                | No                | No                |
| Tree-shake subpath imports  | Yes            | Partial           | Yes               | Yes               | Yes               |

---

## Roadmap

| 版本 | 範圍                                                              |
| ---- | ----------------------------------------------------------------- |
| v0.1 | core + guards + effects + inspect + replay + pbt（本次發佈）       |
| v0.2 | Async-guard 偵測、coverage 調整、llms-full.txt verify gate        |
| v0.3 | 透過 `state.sub` 的階層式 sugar（experimental）                    |
| v0.4 | sub-machine API 升 stable；降依賴 cycle                            |
| v0.5 | `aifsmjs-bridge-bitecs` / `aifsmjs-bridge-pixi`（獨立 sub-package） |
| v1.0 | API freeze 與 stability guarantee                                  |

**不在 v1 範圍內**：

- **Parallel state regions**（v1 不做）
- **Actor invocation / spawn**（v1 不做）
- **Tick / game-loop hook**（v1 不做）
- **ECS / Pixi bridges**（v1 不做）

**未來候選**：`historyState` — re-entry 時自動恢復上一次的 sub-state。0.3.0 的暫代方案：透過 `onTransition` snapshot sub-runtime 的 value，之後手動還原。

---

## License

[MIT](LICENSE)
