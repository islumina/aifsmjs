import * as fc from "fast-check";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { defineMachine } from "../../src/fsm/definition.js";
import { SubMachineError, createRuntime } from "../../src/fsm/runtime.js";
import type { Implementations, MachineDef, Runtime } from "../../src/fsm/types.js";
import {
  childImpl,
  childMachine,
  log,
  parentImpl,
  parentMachine,
  resetLog,
} from "../fixtures/sub-machine.js";

beforeEach(() => {
  resetLog();
});

// ---------------------------------------------------------------------------
// Group A — Type extension + validation
// ---------------------------------------------------------------------------

describe("Group A — Type extension + validation", () => {
  it("A1: defineMachine accepts state.sub of valid shape", () => {
    expect(() =>
      defineMachine<{ n: number }, { type: "GO" }, "a" | "b">({
        id: "valid-sub",
        initial: "a",
        context: { n: 0 },
        states: {
          a: {
            sub: childMachine,
            on: { GO: { target: "b" } },
          },
          b: {},
        },
      }),
    ).not.toThrow();
  });

  it("A2: defineMachine throws InvalidDefinitionError when state.sub is non-object", () => {
    expect(() =>
      defineMachine<{}, { type: "X" }, "s">({
        id: "bad-sub-nonobj",
        initial: "s",
        context: {},
        states: {
          // biome-ignore lint/suspicious/noExplicitAny: intentionally broken for error test
          s: { sub: "not-an-object" as any },
        },
      }),
    ).toThrow(/sub is not a valid sub-machine definition/);
  });

  it("A3: defineMachine throws InvalidDefinitionError when state.sub.states is missing", () => {
    expect(() =>
      defineMachine<{}, { type: "X" }, "s">({
        id: "bad-sub-no-states",
        initial: "s",
        context: {},
        states: {
          // biome-ignore lint/suspicious/noExplicitAny: intentionally broken for error test
          s: { sub: { id: "x", initial: "a", context: {}, states: null as any } },
        },
      }),
    ).toThrow(/sub is not a valid sub-machine definition/);
  });

  it("A4: defineMachine throws InvalidDefinitionError when state.sub.initial is missing", () => {
    expect(() =>
      defineMachine<{}, { type: "X" }, "s">({
        id: "bad-sub-no-initial",
        initial: "s",
        context: {},
        states: {
          // biome-ignore lint/suspicious/noExplicitAny: intentionally broken for error test
          s: { sub: { id: "x", initial: 42 as any, context: {}, states: { a: {} } } },
        },
      }),
    ).toThrow(/sub is not a valid sub-machine definition/);
  });

  it("A5: defineMachine throws when state.sub.initial is a string but not a member of sub.states (FSM-S-02)", () => {
    // Shallow validation accepted any string `initial`; a sub whose initial
    // is not one of its own states boots with snapshot.value pointing at a
    // non-existent state, and step() then no-ops every event forever — a
    // live-looking but permanently dead child. Construction must reject it.
    expect(() =>
      defineMachine<{}, { type: "X" }, "s">({
        id: "bad-sub-initial-not-member",
        initial: "s",
        context: {},
        states: {
          // biome-ignore lint/suspicious/noExplicitAny: intentionally broken for error test
          s: { sub: { id: "x", initial: "ghost", context: {}, states: { a: {} } } as any },
        },
      }),
    ).toThrow(/sub is not a valid sub-machine definition/);
  });
});

// ---------------------------------------------------------------------------
// Group B — Initial sub-machine instantiation
// ---------------------------------------------------------------------------

describe("Group B — Initial sub-machine instantiation", () => {
  it("B1: createRuntime of machine whose initial state has sub returns a Runtime from subRuntime()", () => {
    const def = defineMachine<{ n: number }, { type: "GO" }, "a" | "b">({
      id: "initial-sub",
      initial: "a",
      context: { n: 0 },
      states: {
        a: {
          sub: childMachine,
          subImpl: childImpl,
          on: { GO: { target: "b" } },
        },
        b: {},
      },
    });
    const rt = createRuntime(def, {});
    const child = rt.subRuntime();
    expect(child).toBeDefined();
    expect(child!.disposed).toBe(false);
  });

  it("B2: that child's getSnapshot().value equals child initial state", () => {
    const def = defineMachine<{ n: number }, { type: "GO" }, "a" | "b">({
      id: "initial-sub-snap",
      initial: "a",
      context: { n: 0 },
      states: {
        a: {
          sub: childMachine,
          subImpl: childImpl,
          on: { GO: { target: "b" } },
        },
        b: {},
      },
    });
    const rt = createRuntime(def, {});
    expect(rt.subRuntime()!.getSnapshot().value).toBe("fetching");
  });

  it("B3: createRuntime throws SubMachineError(phase: init) if child init throws", () => {
    // We need a sub that causes createRuntime to throw at bootstrap. As of C2,
    // defineMachine deep-validates subs, so a malformed sub can no longer be
    // smuggled past construction; we therefore build a VALID parent, then mutate
    // the state's `sub` to a malformed nested sub AFTER defineMachine (simulating
    // a dynamically-injected / corrupted def). createRuntime's bootstrap then
    // boots the bad sub, whose grandchild has states:null → createRuntime throws,
    // which initChildFor wraps as SubMachineError(phase: "init"). This still
    // exercises the init-failure path; only the smuggling vector changed.
    // biome-ignore lint/suspicious/noExplicitAny: intentionally broken for error test
    const innerBadSub: any = { id: "inner-bad", initial: "y", context: {}, states: null };
    // biome-ignore lint/suspicious/noExplicitAny: intentionally broken for error test
    const badSub: any = {
      id: "bad",
      initial: "x",
      context: {},
      states: { x: { sub: innerBadSub } }, // x.sub has null states → createRuntime throws
    };
    const def = defineMachine<{ n: number }, { type: "GO" }, "a" | "b">({
      id: "bad-initial-sub",
      initial: "a",
      context: { n: 0 },
      states: {
        a: { on: { GO: { target: "b" } } },
        b: {},
      },
    });
    // Inject the malformed sub post-construction (bypasses C2 deep validation).
    // biome-ignore lint/suspicious/noExplicitAny: test patching
    (def as any).states.a.sub = badSub;
    expect(() => createRuntime(def, {})).toThrow(SubMachineError);
    try {
      createRuntime(def, {});
    } catch (e) {
      expect(e).toBeInstanceOf(SubMachineError);
      expect((e as SubMachineError).phase).toBe("init");
    }
  });
});

// ---------------------------------------------------------------------------
// Group C — Enter/exit lifecycle action ordering
// ---------------------------------------------------------------------------

describe("Group C — Enter/exit lifecycle action ordering", () => {
  it("C1: send START from idle → loading: parent entry action fires; child is init'd and accessible", () => {
    const rt = createRuntime(parentMachine, parentImpl);
    rt.send({ type: "START" });
    // parent entry action runs in step() — must appear in log
    expect(log).toContain("parent:enter");
    // child is instantiated after parent step() (before snapshot commit per new spec)
    // child:enter does NOT fire on initial createRuntime (createRuntime is not a transition)
    expect(rt.subRuntime()).toBeDefined();
    expect(rt.subRuntime()!.getSnapshot().value).toBe("fetching");
  });

  it("C2: send FINISH from loading → done: parent:exit fires in step(), then child is disposed", () => {
    const rt = createRuntime(parentMachine, parentImpl);
    rt.send({ type: "START" });
    const child = rt.subRuntime()!;
    resetLog();
    rt.send({ type: "FINISH" });
    // parent exit action runs in step() (before applySubLifecycle)
    expect(log).toContain("parent:exit");
    // child is disposed during applySubLifecycle (after step, before snapshot commit)
    expect(child.disposed).toBe(true);
    expect(rt.subRuntime()).toBeUndefined();
  });

  it("C3: subRuntime() returns undefined after transitioning out of loading", () => {
    const rt = createRuntime(parentMachine, parentImpl);
    rt.send({ type: "START" });
    expect(rt.subRuntime()).toBeDefined();
    rt.send({ type: "FINISH" });
    expect(rt.subRuntime()).toBeUndefined();
  });

  it("C4: subscribers see parent snapshot AFTER child init: subRuntime() available inside subscriber", () => {
    const rt = createRuntime(parentMachine, parentImpl);
    let subRuntimeInsideSubscriber: Runtime<unknown, { type: string }, string> | undefined =
      undefined;
    rt.subscribe(() => {
      subRuntimeInsideSubscriber = rt.subRuntime();
    });
    rt.send({ type: "START" });
    // After send commits, subscriber fires — child should already be initialised
    expect(subRuntimeInsideSubscriber).toBeDefined();
  });

  it("C5: middleware sees next already committed, subRuntime() pointing to new child", () => {
    let middlewareSubRuntime: Runtime<unknown, { type: string }, string> | undefined = undefined;
    const rt = createRuntime(parentMachine, parentImpl, {
      middleware: [
        (_ctx, next) => {
          middlewareSubRuntime = rt.subRuntime();
          next();
        },
      ],
    });
    rt.send({ type: "START" });
    // Middleware runs after snapshot commit per §3.4
    expect(middlewareSubRuntime).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Group D — Both-states-have-sub transition
// ---------------------------------------------------------------------------

describe("Group D — Both-states-have-sub transition", () => {
  // Build a parent with two sub-bearing states
  function makeTwoSubParent() {
    const child1 = defineMachine<{ n: number }, { type: "X" }, "s1">({
      id: "child1",
      initial: "s1",
      context: { n: 1 },
      states: { s1: {} },
    });
    const child2 = defineMachine<{ n: number }, { type: "X" }, "s2">({
      id: "child2",
      initial: "s2",
      context: { n: 2 },
      states: { s2: {} },
    });
    return defineMachine<{}, { type: "SWITCH" }, "stateA" | "stateB">({
      id: "two-sub-parent",
      initial: "stateA",
      context: {},
      states: {
        stateA: {
          sub: child1,
          on: { SWITCH: { target: "stateB" } },
        },
        stateB: {
          sub: child2,
        },
      },
    });
  }

  it("D1: transitioning between two sub-bearing states changes the child reference", () => {
    const def = makeTwoSubParent();
    const rt = createRuntime(def, {});
    const child1 = rt.subRuntime();
    expect(child1).toBeDefined();
    rt.send({ type: "SWITCH" });
    const child2 = rt.subRuntime();
    expect(child2).toBeDefined();
    expect(child2).not.toBe(child1);
  });

  it("D2: old child has disposed === true after transition", () => {
    const def = makeTwoSubParent();
    const rt = createRuntime(def, {});
    const oldChild = rt.subRuntime()!;
    rt.send({ type: "SWITCH" });
    expect(oldChild.disposed).toBe(true);
  });

  it("D3: old child is disposed before new child is instantiated (ordering via identity check)", () => {
    // Use a two-sub parent to verify old child disposed before new child exists
    const def = makeTwoSubParent();
    const rt = createRuntime(def, {});
    const child1 = rt.subRuntime()!;
    let wasChild1DisposedAtTransitionTime = false;
    let child2AtTransitionTime: Runtime<unknown, { type: string }, string> | undefined;

    // subscriber fires after snapshot commit — at that point new child is live
    rt.subscribe(() => {
      wasChild1DisposedAtTransitionTime = child1.disposed;
      child2AtTransitionTime = rt.subRuntime();
    });

    rt.send({ type: "SWITCH" });

    // child1 was disposed (applySubLifecycle ran before subscribe notified)
    expect(wasChild1DisposedAtTransitionTime).toBe(true);
    // child2 exists at subscribe time
    expect(child2AtTransitionTime).toBeDefined();
    expect(child2AtTransitionTime).not.toBe(child1);
  });
});

// ---------------------------------------------------------------------------
// Group E — Self-targeting external
// ---------------------------------------------------------------------------

describe("Group E — Self-targeting external", () => {
  it("E1: RETRY while in loading → still in loading, old child disposed, fresh child created", () => {
    const rt = createRuntime(parentMachine, parentImpl);
    rt.send({ type: "START" });
    const child1 = rt.subRuntime()!;
    expect(child1.disposed).toBe(false);

    rt.send({ type: "RETRY" });

    // Still in loading
    expect(rt.getSnapshot().value).toBe("loading");
    // Old child disposed
    expect(child1.disposed).toBe(true);
    // New child is fresh
    const child2 = rt.subRuntime()!;
    expect(child2).not.toBe(child1);
    expect(child2.disposed).toBe(false);
    expect(child2.getSnapshot().value).toBe("fetching");
  });

  it("E2: RETRY log records parent exit + enter pair; old child disposed, new child fresh", () => {
    const rt = createRuntime(parentMachine, parentImpl);
    rt.send({ type: "START" });
    const child1 = rt.subRuntime()!;
    resetLog();
    rt.send({ type: "RETRY" });
    // parent exit action fires in step() → parent enter action fires in step()
    // (both are on loading's exit/entry; step runs them both since it's treated as exit+re-entry)
    expect(log).toContain("parent:exit");
    expect(log).toContain("parent:enter");
    // parent:exit must come before parent:enter (step() ordering)
    const pExitIdx = log.indexOf("parent:exit");
    const pEnterIdx = log.indexOf("parent:enter");
    expect(pExitIdx).toBeLessThan(pEnterIdx);
    // old child was disposed, new child is fresh
    expect(child1.disposed).toBe(true);
    const child2 = rt.subRuntime()!;
    expect(child2).not.toBe(child1);
    expect(child2.disposed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Group F — Internal transition
// ---------------------------------------------------------------------------

describe("Group F — Internal transition", () => {
  // Parent impl typed for THIS group's event union (START | INTERNAL |
  // FINISH). parentImpl is typed for START | FINISH | RETRY, so spreading it
  // here is contravariantly incompatible under the activated test typecheck;
  // the action bodies are event-agnostic, so we rebuild them against the
  // correct union. Runtime behaviour is identical.
  const internalImpl: Implementations<
    { step: number },
    { type: "START" } | { type: "INTERNAL" } | { type: "FINISH" }
  > = {
    actions: {
      logParentEnter: () => {
        log.push("parent:enter");
        return undefined;
      },
      logParentExit: () => {
        log.push("parent:exit");
        return undefined;
      },
    },
  };
  // Build a parent with an internal transition (no target) in loading
  function makeInternalParent() {
    return defineMachine<
      { step: number },
      { type: "START" } | { type: "INTERNAL" } | { type: "FINISH" },
      "idle" | "loading" | "done"
    >({
      id: "internal-parent",
      initial: "idle",
      context: { step: 0 },
      states: {
        idle: { on: { START: { target: "loading" } } },
        loading: {
          sub: childMachine,
          subImpl: childImpl,
          entry: ["logParentEnter"],
          exit: ["logParentExit"],
          on: {
            // No target = internal transition (no state change)
            INTERNAL: { actions: ["logParentEnter"] },
            FINISH: { target: "done" },
          },
        },
        done: { final: true },
      },
    });
  }

  it("F1: internal transition leaves child reference identity-equal", () => {
    const rt = createRuntime(makeInternalParent(), internalImpl);
    rt.send({ type: "START" });
    const childBefore = rt.subRuntime();
    rt.send({ type: "INTERNAL" });
    const childAfter = rt.subRuntime();
    expect(childAfter).toBe(childBefore);
  });

  it("F2: internal transition actions still run; child entry/exit NOT fired", () => {
    const rt = createRuntime(makeInternalParent(), internalImpl);
    rt.send({ type: "START" });
    resetLog();
    rt.send({ type: "INTERNAL" });
    // logParentEnter action should have run (it's in the INTERNAL actions array)
    expect(log).toContain("parent:enter");
    // child:enter and child:exit must NOT be in the log (no child lifecycle change)
    expect(log).not.toContain("child:enter");
    expect(log).not.toContain("child:exit");
  });
});

// ---------------------------------------------------------------------------
// Group G — reset() interactions
// ---------------------------------------------------------------------------

describe("Group G — reset() interactions", () => {
  it("G1: reset() from loading to idle → child disposed, subRuntime() returns undefined", () => {
    const rt = createRuntime(parentMachine, parentImpl);
    rt.send({ type: "START" });
    const child = rt.subRuntime()!;
    rt.reset();
    expect(child.disposed).toBe(true);
    expect(rt.subRuntime()).toBeUndefined();
  });

  it("G2: reset() from done to idle (no sub on initial) → no SubMachineError thrown", () => {
    const rt = createRuntime(parentMachine, parentImpl);
    rt.send({ type: "START" });
    rt.send({ type: "FINISH" });
    expect(() => rt.reset()).not.toThrow();
    expect(rt.getSnapshot().value).toBe("idle");
  });

  it("G3: reset() to an initial state that has sub → fresh child created", () => {
    const def = defineMachine<{ n: number }, { type: "GO" }, "a" | "b">({
      id: "reset-with-sub",
      initial: "a",
      context: { n: 0 },
      states: {
        a: {
          sub: childMachine,
          subImpl: childImpl,
          on: { GO: { target: "b" } },
        },
        b: {},
      },
    });
    const rt = createRuntime(def, {});
    const child1 = rt.subRuntime()!;
    rt.send({ type: "GO" });
    rt.reset();
    const child2 = rt.subRuntime();
    expect(child2).toBeDefined();
    expect(child2).not.toBe(child1);
    expect(child2!.disposed).toBe(false);
  });

  it("G4: same-state reset() while in initial sub-bearing state → old child disposed, new child instantiated", () => {
    const def = defineMachine<{ n: number }, { type: "GO" }, "a" | "b">({
      id: "same-state-reset",
      initial: "a",
      context: { n: 0 },
      states: {
        a: {
          sub: childMachine,
          subImpl: childImpl,
          on: { GO: { target: "b" } },
        },
        b: {},
      },
    });
    const rt = createRuntime(def, {});
    const child1 = rt.subRuntime()!;
    rt.reset(); // same state — old child disposed, new child created
    const child2 = rt.subRuntime();
    expect(child1.disposed).toBe(true);
    expect(child2).toBeDefined();
    expect(child2).not.toBe(child1);
    expect(child2!.disposed).toBe(false);
  });

  it("G5a: reset() throws SubMachineError(phase: init) if new child init throws during reset", () => {
    // As of C2 a malformed sub cannot be smuggled past defineMachine, so we
    // build a VALID machine, transition away from the sub-bearing state, then
    // mutate the INITIAL state's `sub` to a malformed one AFTER construction.
    // reset() then tries to re-init the child for the initial state and the
    // bootstrap throws → SubMachineError(phase: "init").
    // biome-ignore lint/suspicious/noExplicitAny: intentionally broken for error test
    const innerBadSub: any = { id: "inner-bad-g", initial: "y", context: {}, states: null };
    const workingDef = defineMachine<{ n: number }, { type: "GO" }, "idle" | "loaded">({
      id: "reset-init-throw-2",
      initial: "idle",
      context: { n: 0 },
      states: {
        idle: { on: { GO: { target: "loaded" } } },
        loaded: {
          sub: childMachine,
          subImpl: childImpl,
          on: {},
        },
      },
    });
    const rt = createRuntime(workingDef, {});
    rt.send({ type: "GO" });
    expect(rt.subRuntime()).toBeDefined();
    // Patch the initial state's sub to a broken one to make reset()'s init throw
    // biome-ignore lint/suspicious/noExplicitAny: test patching
    (workingDef as any).states.idle.sub = innerBadSub;
    // Now reset() will try to init a child for "idle" (the initial state) and fail
    let thrown: unknown;
    try {
      rt.reset();
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(SubMachineError);
    expect((thrown as SubMachineError).phase).toBe("init");
  });

  it("G5: reset() throws SubMachineError(phase: dispose) if current child dispose throws", () => {
    const rt = createRuntime(parentMachine, parentImpl);
    rt.send({ type: "START" });
    const child = rt.subRuntime()!;
    // Patch child dispose to throw after disposing
    const origDispose = child.dispose.bind(child);
    // biome-ignore lint/suspicious/noExplicitAny: test patching
    (child as any).dispose = () => {
      origDispose();
      throw new Error("reset-dispose-boom");
    };
    let thrown: unknown;
    try {
      rt.reset();
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(SubMachineError);
    expect((thrown as SubMachineError).phase).toBe("dispose");
    // snapshot must NOT have been updated (still in loading)
    expect(rt.getSnapshot().value).toBe("loading");
  });
});

// ---------------------------------------------------------------------------
// Group H — dispose() cascade
// ---------------------------------------------------------------------------

describe("Group H — dispose() cascade", () => {
  it("H1: parent.dispose() while in loading → child disposed === true", () => {
    const rt = createRuntime(parentMachine, parentImpl);
    rt.send({ type: "START" });
    const child = rt.subRuntime()!;
    rt.dispose();
    expect(child.disposed).toBe(true);
  });

  it("H2: parent.dispose() swallows child dispose exceptions (never throws)", () => {
    const rt = createRuntime(parentMachine, parentImpl);
    rt.send({ type: "START" });
    const child = rt.subRuntime()!;
    // Monkey-patch child dispose to throw after actually disposing
    const origDispose = child.dispose.bind(child);
    // biome-ignore lint/suspicious/noExplicitAny: test patching
    (child as any).dispose = () => {
      origDispose();
      throw new Error("child-dispose-boom");
    };
    // parent.dispose() must NOT throw
    expect(() => rt.dispose()).not.toThrow();
    expect(rt.disposed).toBe(true);
  });

  it("H3: child signal.aborted === true after parent dispose", () => {
    const rt = createRuntime(parentMachine, parentImpl);
    rt.send({ type: "START" });
    const child = rt.subRuntime()!;
    const childSignal = child.signal;
    rt.dispose();
    expect(childSignal.aborted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Group I — SubMachineError rollback
// ---------------------------------------------------------------------------

describe("Group I — SubMachineError rollback", () => {
  // Build a machine where send() to "loading" triggers a sub init that throws.
  // As of C2 a malformed sub cannot be smuggled past defineMachine, so we build
  // a VALID parent (loading carries no sub at construction), then inject a
  // malformed nested sub into loading.sub AFTER defineMachine. Entering
  // "loading" via START boots that sub — whose grandchild has states:null →
  // createRuntime throws — and initChildFor wraps it as SubMachineError(init).
  function makeThrowingInitParent() {
    // biome-ignore lint/suspicious/noExplicitAny: intentionally broken for error test
    const innerBadSub: any = { id: "inner-bad-i", initial: "y", context: {}, states: null };
    // biome-ignore lint/suspicious/noExplicitAny: intentionally broken for error test
    const badSub: any = {
      id: "bad-sub-init",
      initial: "x",
      context: {},
      states: { x: { sub: innerBadSub } }, // x.sub has states:null → createRuntime throws
    };
    const def = defineMachine<
      { step: number },
      { type: "START" } | { type: "FINISH" },
      "idle" | "loading" | "done"
    >({
      id: "throwing-init-parent",
      initial: "idle",
      context: { step: 0 },
      states: {
        idle: { on: { START: { target: "loading" } } },
        loading: { on: { FINISH: { target: "done" } } },
        done: { final: true },
      },
    });
    // Inject the malformed sub post-construction (bypasses C2 deep validation).
    // biome-ignore lint/suspicious/noExplicitAny: test patching
    (def as any).states.loading.sub = badSub;
    return def;
  }

  it("I1: child init throw during send() → parent snapshot.value rolled back to prev.value", () => {
    const def = makeThrowingInitParent();
    const rt = createRuntime(def, {});
    expect(rt.getSnapshot().value).toBe("idle");
    try {
      rt.send({ type: "START" });
    } catch (e) {
      expect(e).toBeInstanceOf(SubMachineError);
    }
    // Snapshot must be rolled back
    expect(rt.getSnapshot().value).toBe("idle");
  });

  it("I2: child init throw → no 'transition' event emitted", () => {
    const def = makeThrowingInitParent();
    const rt = createRuntime(def, {});
    const transitions: string[] = [];
    rt.on("transition", () => transitions.push("fired"));
    try {
      rt.send({ type: "START" });
    } catch {
      /* expected */
    }
    expect(transitions).toHaveLength(0);
  });

  it("I3: child init throw → no middleware ran", () => {
    const def = makeThrowingInitParent();
    const middlewareCalls: number[] = [];
    const rt = createRuntime(
      def,
      {},
      {
        middleware: [
          (_ctx, next) => {
            middlewareCalls.push(1);
            next();
          },
        ],
      },
    );
    try {
      rt.send({ type: "START" });
    } catch {
      /* expected */
    }
    expect(middlewareCalls).toHaveLength(0);
  });

  it("I4: child dispose throw during send() transition → SubMachineError(phase: dispose), snapshot rolled back", () => {
    const rt = createRuntime(parentMachine, parentImpl);
    rt.send({ type: "START" });
    const child = rt.subRuntime()!;
    const prevValue = rt.getSnapshot().value;
    // Patch child dispose to throw
    const origDispose = child.dispose.bind(child);
    // biome-ignore lint/suspicious/noExplicitAny: test patching
    (child as any).dispose = () => {
      origDispose();
      throw new Error("dispose-boom");
    };
    let thrown: unknown;
    try {
      rt.send({ type: "FINISH" });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(SubMachineError);
    expect((thrown as SubMachineError).phase).toBe("dispose");
    // Snapshot rolled back to prev
    expect(rt.getSnapshot().value).toBe(prevValue);
  });
});

// ---------------------------------------------------------------------------
// Group J — property-based lifecycle invariants
//
// Random-walk the parentMachine fixture over its event/reset alphabet and
// assert the sub-machine lifecycle invariants hold after EVERY step. This is
// the §2-checklist PBT requirement for the [must] sub-machine feature; the
// example-based Groups A-I cover specific transitions, this covers arbitrary
// sequences fast-check can shrink.
//
// parentMachine: idle --START--> loading --FINISH--> done(final)
//                        loading --RETRY--> loading (self-target external)
// The ONLY sub-bearing state is "loading".
// ---------------------------------------------------------------------------

describe("Group J — property-based lifecycle invariants", () => {
  type Cmd = "START" | "FINISH" | "RETRY" | "RESET";
  const cmdArb = fc.constantFrom<Cmd>("START", "FINISH", "RETRY", "RESET");

  // Drive the shared parentMachine fixture. A switch (not an `as` cast) keeps
  // the event union narrow; "RESET" maps to the runtime method, not an event.
  function drive(rt: ReturnType<typeof makeParentRuntime>, cmd: Cmd): void {
    switch (cmd) {
      case "RESET":
        rt.reset();
        break;
      case "START":
        rt.send({ type: "START" });
        break;
      case "FINISH":
        rt.send({ type: "FINISH" });
        break;
      case "RETRY":
        rt.send({ type: "RETRY" });
        break;
    }
  }
  function makeParentRuntime() {
    return createRuntime(parentMachine, parentImpl);
  }

  it("J1: subRuntime() is defined IFF current state has a sub; the live child is never disposed", () => {
    fc.assert(
      fc.property(fc.array(cmdArb, { maxLength: 30 }), (cmds) => {
        const rt = makeParentRuntime();
        const check = () => {
          const inSubState = rt.getSnapshot().value === "loading";
          const child = rt.subRuntime();
          // P1 — lifecycle binding: child exists exactly when in a sub-bearing state
          expect(child !== undefined).toBe(inSubState);
          // P2 — the live child is never observed disposed
          if (child !== undefined) expect(child.disposed).toBe(false);
        };
        check(); // t=0 (initial state "idle" has no sub)
        for (const cmd of cmds) {
          drive(rt, cmd);
          check();
        }
        rt.dispose();
        // After parent dispose the child reference is cleared.
        expect(rt.subRuntime()).toBeUndefined();
      }),
      { numRuns: 50 },
    );
  });

  it("J2: every replaced child ends disposed; only the live child (if any) stays undisposed; parent dispose disposes all", () => {
    fc.assert(
      fc.property(fc.array(cmdArb, { maxLength: 30 }), (cmds) => {
        const rt = makeParentRuntime();
        const seen = new Set<Runtime<unknown, { type: string }, string>>();
        const track = () => {
          const child = rt.subRuntime();
          if (child) seen.add(child);
        };
        track();
        for (const cmd of cmds) {
          drive(rt, cmd);
          track();
        }
        const live = rt.subRuntime();
        // Every child ever created that is not the current live one is disposed.
        for (const c of seen) {
          if (c !== live) expect(c.disposed).toBe(true);
        }
        if (live) expect(live.disposed).toBe(false);
        rt.dispose();
        // Parent dispose cascades to every child instance ever created.
        for (const c of seen) expect(c.disposed).toBe(true);
      }),
      { numRuns: 50 },
    );
  });
});
