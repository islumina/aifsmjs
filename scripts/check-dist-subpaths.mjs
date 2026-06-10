#!/usr/bin/env node
// Regression guard against tsup code-splitting fracturing the shared internal
// module registry across dist subpaths. If `.`, `/guards`, `/effects`,
// `/inspect`, `/replay`, `/pbt`, and `/timer` do not resolve to the same
// singleton internals, cross-subpath usage breaks at runtime in ways the unit
// suite (which imports from src) cannot see.
//
// Minimum bar (per fix-wave T8): every subpath loads under BOTH ESM `import()`
// and CJS `createRequire`, AND at least one genuine cross-subpath identity /
// interop assertion holds — existence-only checks (import without throw) do
// not qualify. Concretely:
//   1. A machine built by root `createMachine`/`createRuntime` is fed to the
//      `/pbt` property runner (snapshotAlwaysFrozen, real fast-check run) and
//      an `/inspect` recorder middleware, and both actually run.
//   2. An `UnknownGuardError` raised through the `/guards` combinator path is
//      an `instanceof` the *root* export's `UnknownGuardError` — same-realm
//      registry proof: a fractured build would yield two distinct classes.
//   3. `/effects` `runEffects`, `/replay` `replay`, and `/timer` `after` are
//      exercised against the same machine / values.
// Any throw → exit(1). Success → print OK.

import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

const SUBPATHS = [
  "index",
  "guards/index",
  "effects/index",
  "inspect/index",
  "replay/index",
  "pbt/index",
  "timer/index",
];

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// Drive the cross-subpath interop assertions for one module flavour (ESM/CJS).
// `fc` is the fast-check module loaded with the matching flavour so the /pbt
// property runner executes for real rather than via a fabricated arbitrary.
function exerciseInterop(label, mods, fc) {
  const { index, guards, effects, inspect, pbt, replay, timer } = mods;

  // --- (1a) root machine × /inspect recorder middleware --------------------
  const sink = [];
  const machine = index.createRuntime(
    index.defineMachine({
      id: "interop",
      initial: "a",
      context: { n: 0 },
      states: {
        a: { on: { GO: { target: "b", actions: ["bump"] } } },
        b: {},
      },
    }),
    { actions: { bump: index.assign(({ context }) => ({ n: context.n + 1 })) } },
    { middleware: [inspect.recorder(sink)] },
  );
  machine.send({ type: "GO" });
  assert(machine.getSnapshot().value === "b", `${label}: /inspect-wired machine did not transition`);
  assert(
    sink.length === 1 && sink[0].changed === true,
    `${label}: /inspect recorder did not capture the transition`,
  );

  // --- (1b) root machine × /pbt property runner (real fast-check run) ------
  const def = index.defineMachine({
    id: "pbt-interop",
    initial: "a",
    context: { n: 0 },
    states: {
      a: { on: { GO: { target: "b" } } },
      b: { on: { GO: { target: "a" } } },
    },
  });
  // snapshotAlwaysFrozen throws if the invariant fails; a clean run proves
  // /pbt consumes the root machine + root snapshot internals coherently.
  pbt.snapshotAlwaysFrozen(def, {}, { GO: fc.constant({ type: "GO" }) }, { numRuns: 5 });

  // --- (2) /guards UnknownGuardError instanceof ROOT export -----------------
  const composed = guards.and(["missingGuard"]);
  let caught;
  try {
    index.evalGuard(composed, { n: 0 }, { type: "GO" }, {});
  } catch (err) {
    caught = err;
  }
  assert(caught !== undefined, `${label}: composed guard with unknown ref did not throw`);
  assert(
    caught instanceof index.UnknownGuardError,
    `${label}: /guards-raised error is NOT instanceof root UnknownGuardError — dist registry is fractured`,
  );

  // --- (3) /effects, /replay, /timer against shared values -----------------
  let effectRan = false;
  effects.runEffects(
    [{ type: "ping" }],
    {
      ping: () => {
        effectRan = true;
      },
    },
    { context: { n: 0 }, event: { type: "GO" } },
  );
  assert(effectRan, `${label}: /effects runEffects did not dispatch handler`);

  const replayed = replay.replay(index.initialSnapshot(def), [{ type: "GO" }], def, {}).snapshot;
  assert(replayed.value === "b", `${label}: /replay did not fold the event to state b`);

  let fired = false;
  timer.after(0, () => { fired = true; }, {
    setTimeout: (fn) => {
      fn();
      return 0;
    },
    clearTimeout: () => {},
  });
  assert(fired, `${label}: /timer after() did not fire with injected setTimeout`);

  process.stdout.write(`${label}: SHARED-OK recorder=${sink.length} replay=${replayed.value}\n`);
}

async function smokeESM() {
  const loaded = await Promise.all(SUBPATHS.map((p) => import(resolve(root, `dist/${p}.js`))));
  const fc = await import("fast-check");
  const mods = {
    index: loaded[0],
    guards: loaded[1],
    effects: loaded[2],
    inspect: loaded[3],
    replay: loaded[4],
    pbt: loaded[5],
    timer: loaded[6],
  };
  exerciseInterop("ESM", mods, fc);
}

function smokeCJS() {
  const fc = require("fast-check");
  const mods = {
    index: require(resolve(root, "dist/index.cjs")),
    guards: require(resolve(root, "dist/guards/index.cjs")),
    effects: require(resolve(root, "dist/effects/index.cjs")),
    inspect: require(resolve(root, "dist/inspect/index.cjs")),
    replay: require(resolve(root, "dist/replay/index.cjs")),
    pbt: require(resolve(root, "dist/pbt/index.cjs")),
    timer: require(resolve(root, "dist/timer/index.cjs")),
  };
  exerciseInterop("CJS", mods, fc);
}

try {
  await smokeESM();
  smokeCJS();
} catch (err) {
  process.stderr.write(
    `check-dist-subpaths FAILED: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  if (err instanceof Error && err.stack) process.stderr.write(`${err.stack}\n`);
  process.exit(1);
}
