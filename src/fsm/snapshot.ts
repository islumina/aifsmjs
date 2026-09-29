import type { Snapshot } from "./types.js";

// Written so a bundler define-replacement of `process.env.NODE_ENV` (Vite,
// webpack 5, ...) still applies: those tools replace only the
// `process.env.NODE_ENV` expression, not a runtime `process` global, so
// gating on `typeof process !== "undefined"` first left IS_DEV permanently
// false in a browser build even though NODE_ENV !== "production". A plain
// try/catch around the read lets the replaced literal survive while still
// falling back to false wherever `process` is entirely absent. Exported for
// internal dev-only diagnostics (runtime.ts); not re-exported from the root.
export let IS_DEV = false;
try {
  IS_DEV = process.env.NODE_ENV !== "production";
} catch {
  /* no `process` global (browser without bundler define-replacement) */
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

// Trees already deep-frozen here. Short-circuits re-walking carried-over
// context and guards cycles; unlike `Object.isFrozen` it does not stop at a
// shallow-frozen object (e.g. an effect descriptor) whose children are mutable.
const DEEP_FROZEN = new WeakSet<object>();

export function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  if (DEEP_FROZEN.has(value)) return value;
  DEEP_FROZEN.add(value);
  // Object.freeze throws on a non-empty TypedArray / Buffer; binary data in
  // context or event payloads is left mutable (caller-owned) instead.
  if (ArrayBuffer.isView(value)) return value;
  Object.freeze(value);
  if (Array.isArray(value)) {
    for (const item of value) deepFreeze(item);
  } else if (isPlainObject(value)) {
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

/**
 * Wrap a freshly built snapshot. In dev mode the whole tree is deep-frozen so
 * accidental mutation throws immediately. In production only the top object is
 * frozen, keeping the cost negligible.
 */
export function freezeSnapshot<C, S extends string>(snap: Snapshot<C, S>): Snapshot<C, S> {
  // IS_DEV is always true in vitest; the production branch (`Object.freeze`)
  // is exercised only when NODE_ENV === "production" and is intentionally
  // left out of the coverage threshold.
  return IS_DEV ? deepFreeze(snap) : Object.freeze(snap);
}

export function createSnapshot<C, S extends string>(args: {
  value: S;
  context: C;
  status?: "active" | "final";
}): Snapshot<C, S> {
  return freezeSnapshot({
    value: args.value,
    context: args.context,
    status: args.status ?? "active",
  });
}
