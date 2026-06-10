#!/usr/bin/env node
// Verify gzip-compressed bundle size per subpath stays under budget.
// Run after `pnpm build`; fails the publish if any entry exceeds.
//
// CHUNK-CLOSURE SEMANTICS (wave 2026-06-10): aifsmjs builds with tsup
// `splitting: true` (cross-subpath error-class identity — see tsup.config.ts),
// so each entry file is a thin re-export shell importing shared `chunk-*.js`
// files. Measuring only the entry is hollow (dist/index.js reports ~336 B
// while its closure carries the whole runtime). This script mirrors
// aiecsjs/scripts/check-size.mjs: BFS over relative imports from each entry,
// sum per-file gzip sizes over the reachable set, and budget that closure.
// Closure totals are comparable to the pre-split inlined sizes the budgets
// below were calibrated against (and which README.md documents).
//
// ESM-ONLY SCOPE: only `dist/**/*.js` is measured; the `.cjs` twins share the
// same logic and would double-count the shared chunks.

import { gzipSync } from "node:zlib";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = resolve(root, "dist");

const budgets = {
  // wave 2026-06-10 recalibration: budgets are CLOSURE sizes now, not inlined
  // entry sizes (semantics changed with splitting:true). Closure > old inlined
  // for small entries because a shared chunk counts fully towards every entry
  // that imports it; total dist JS shrank 50.7 KB -> 31.1 KB in the same
  // change. Leader-measured actuals: index 6,149 / guards 1,325 /
  // effects 1,521 / inspect 550 / replay 3,008 / pbt 8,061 / timer 1,023 B.
  // Historical inlined calibration (pre-split): index 4,465 B and pbt 5,228 B
  // measured in v0.3.0. README "Size budget" bullet mirrors these caps.
  "dist/index.js": 6_500,
  "dist/guards/index.js": 1_500,
  "dist/effects/index.js": 1_700,
  "dist/inspect/index.js": 1_000,
  "dist/replay/index.js": 3_300,
  // pbt pulls createRuntime (and its chunk) transitively.
  "dist/pbt/index.js": 8_500,
  "dist/timer/index.js": 1_200,
};

// Relative-import regex matching both `from './foo'` and `import('./foo')`.
const IMPORT_RE = /(?:from|import)\s*['"](\.{1,2}\/[^'"]+)['"]/g;

function resolveChunkClosure(entryFile) {
  const visited = new Set();
  const queue = [entryFile];
  while (queue.length > 0) {
    const file = queue.shift();
    if (visited.has(file)) continue;
    visited.add(file);
    if (!existsSync(file)) continue;
    const src = readFileSync(file, "utf8");
    for (const match of src.matchAll(IMPORT_RE)) {
      const rel = match[1];
      if (!rel) continue;
      const base = rel.split("?")[0].split("#")[0];
      const candidate = resolve(dirname(file), base);
      const resolved = existsSync(candidate)
        ? candidate
        : existsSync(`${candidate}.js`)
          ? `${candidate}.js`
          : null;
      if (resolved && resolved.startsWith(dist) && !visited.has(resolved)) {
        queue.push(resolved);
      }
    }
  }
  return visited;
}

const failures = [];
for (const [rel, max] of Object.entries(budgets)) {
  const entryPath = resolve(root, rel);
  if (!existsSync(entryPath)) {
    failures.push(`${rel}: missing (did you run pnpm build?)`);
    continue;
  }
  const reachable = resolveChunkClosure(entryPath);
  let totalGz = 0;
  for (const file of reachable) {
    if (!existsSync(file)) continue;
    totalGz += gzipSync(readFileSync(file)).length;
  }
  const pct = ((totalGz / max) * 100).toFixed(0);
  const tag = totalGz > max ? "FAIL" : "ok  ";
  const chunkCount = reachable.size - 1;
  console.log(
    `[${tag}] ${rel.padEnd(28)} gz ${String(totalGz).padStart(6)} B / ${max} B (${pct}%)` +
      (chunkCount > 0 ? `  [+${chunkCount} chunk${chunkCount === 1 ? "" : "s"}]` : ""),
  );
  if (totalGz > max) failures.push(`${rel}: ${totalGz} B > ${max} B budget`);
}

if (failures.length > 0) {
  console.error("\ncheck-size: bundle budget exceeded:");
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}

console.log(`\ncheck-size: all ${Object.keys(budgets).length} entries within budget.`);
