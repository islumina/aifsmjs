import { describe, expect, it, vi } from "vitest";
import { createRuntime } from "../../src/fsm/runtime.js";
import { type RecordedEntry, logger, persist, recorder } from "../../src/inspect/index.js";
import {
  type Ctx,
  type Evt,
  type States,
  makeImpl,
  trafficLight,
} from "../fixtures/traffic-light.js";

describe("logger", () => {
  it("logs only when changed", () => {
    const out = vi.fn();
    const runtime = createRuntime(trafficLight, makeImpl(), {
      middleware: [logger<Ctx, Evt, States>(out)],
    });
    runtime.send({ type: "NEXT" }); // changed
    runtime.send({ type: "GHOST" as unknown as "NEXT" }); // no-op
    expect(out).toHaveBeenCalledTimes(1);
    expect(out.mock.calls[0]?.[0]).toContain("red → green");
  });
});

describe("persist", () => {
  it("writes JSON to storage on each change", () => {
    const writes: Record<string, string> = {};
    const storage = {
      setItem: (k: string, v: string) => {
        writes[k] = v;
      },
    };
    const runtime = createRuntime(trafficLight, makeImpl(), {
      middleware: [persist<Ctx, Evt, States>({ key: "k", storage })],
    });
    runtime.send({ type: "NEXT" });
    expect(writes.k).toContain('"value":"green"');
  });
});

describe("recorder", () => {
  it("captures every step", () => {
    const sink: RecordedEntry<Ctx, Evt, States>[] = [];
    const runtime = createRuntime(trafficLight, makeImpl(), {
      middleware: [recorder<Ctx, Evt, States>(sink)],
    });
    runtime.send({ type: "NEXT" });
    runtime.send({ type: "EMERGENCY" });
    expect(sink).toHaveLength(2);
    expect(sink[0]?.next.value).toBe("green");
    expect(sink[1]?.next.value).toBe("halt");
  });
});

// ---------------------------------------------------------------------------
// FSM-T-02 — characterise (NOT fix) the documented-open middleware edges:
// silent next() skip and re-entrant send() recorder ordering. These pin the
// current behaviour so the STABILITY/middleware docs (FSM-B-04) describe what
// actually happens; a future change here is a deliberate behaviour change that
// must update these assertions.
// ---------------------------------------------------------------------------

describe("middleware contract edges — characterisation (FSM-T-02 / FSM-B-04)", () => {
  it("a middleware that skips next() silently drops later observers", () => {
    const sink: RecordedEntry<Ctx, Evt, States>[] = [];
    const reached: string[] = [];
    const runtime = createRuntime(trafficLight, makeImpl(), {
      middleware: [
        // First middleware never calls next() — the chain underruns.
        () => {
          reached.push("first");
        },
        (_mw, next) => {
          reached.push("second");
          next();
        },
        recorder<Ctx, Evt, States>(sink),
      ],
    });
    runtime.send({ type: "NEXT" }); // state still advances (commit precedes mw)

    // Current behaviour: the skipped next() drops the second middleware and the
    // recorder entirely — no throw, no warning. The state transition itself is
    // unaffected (snapshot committed before the pipeline runs).
    expect(reached).toEqual(["first"]);
    expect(sink).toHaveLength(0);
    expect(runtime.getSnapshot().value).toBe("green");
  });

  it("re-entrant send() from middleware records [inner, outer] for an application order of [outer, inner]", () => {
    const sink: RecordedEntry<Ctx, Evt, States>[] = [];
    let reentered = false;
    // Holder lets the middleware closure reach the runtime (assigned just
    // below) without a forward-declared `let runtime`. The closure only runs
    // during send(), after construction completes.
    const holder: { rt?: ReturnType<typeof createRuntime<Ctx, Evt, States>> } = {};
    const runtime = createRuntime(trafficLight, makeImpl(), {
      middleware: [
        (mw, next) => {
          // On the outer red->green event, re-entrantly send before delegating
          // to the rest of the chain (recorder). The inner event runs its FULL
          // pipeline — including the recorder push — before this outer frame
          // reaches the recorder.
          if (mw.event.type === "NEXT" && mw.prev.value === "red" && !reentered) {
            reentered = true;
            holder.rt?.send({ type: "NEXT" }); // green -> yellow (inner)
          }
          next();
        },
        recorder<Ctx, Evt, States>(sink),
      ],
    });
    holder.rt = runtime;

    runtime.send({ type: "NEXT" }); // outer: red -> green

    // Application order was outer (red->green) THEN inner (green->yellow), but
    // recorder's sink — documented as feeding replay() — lists the inner first
    // because it pushes after next() and the inner pipeline completed first.
    // Replaying this log would diverge from the real application order.
    expect(sink.map((e) => `${e.prev.value}->${e.next.value}`)).toEqual([
      "green->yellow",
      "red->green",
    ]);
  });
});

describe("read-only invariant", () => {
  it("middleware cannot mutate the next snapshot (frozen)", () => {
    const runtime = createRuntime(trafficLight, makeImpl(), {
      middleware: [
        (mw, next) => {
          expect(() => {
            // biome-ignore lint/suspicious/noExplicitAny: probing freeze
            (mw.next.context as any).ticks = 9999;
          }).toThrow();
          next();
        },
      ],
    });
    runtime.send({ type: "NEXT" });
    expect(runtime.getSnapshot().context.ticks).toBe(1);
  });
});
