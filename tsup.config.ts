import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "guards/index": "src/guards/index.ts",
    "effects/index": "src/effects/index.ts",
    "inspect/index": "src/inspect/index.ts",
    "replay/index": "src/replay/index.ts",
    "pbt/index": "src/pbt/index.ts",
    "timer/index": "src/timer/index.ts",
  },
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  sourcemap: true,
  treeshake: true,
  // splitting must stay ON so tsup hoists internals shared across entry points
  // (the error classes — UnknownGuardError, SubMachineError, … — plus the
  // runtime/evaluator core) into shared chunk-*.js files imported by every
  // subpath. With splitting:false each entry inlines its OWN copy, so an error
  // thrown inside `aifsmjs/guards` is a DIFFERENT class object than the one
  // re-exported from the root entry: `err instanceof UnknownGuardError` (root)
  // returns false across the subpath boundary. scripts/check-dist-subpaths.mjs
  // asserts this same-realm identity; mirrors aiecsjs's tsup config.
  splitting: true,
  target: "es2022",
  outDir: "dist",
});
