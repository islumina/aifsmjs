#!/usr/bin/env node
// Verify that every entry declared in package.json#exports has a real file in dist/.
// Run after `pnpm build`; fails the publish if entries are missing.

import { readFile, access } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const pkg = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));

const failures = [];
let entryCount = 0;

// Condition entries may nest (e.g. "import": { "types": ..., "default": ... }),
// so walk each subpath's conditions recursively rather than assuming one level.
async function walk(subpath, node, trail) {
  if (typeof node === "string") {
    entryCount++;
    const abs = resolve(root, node);
    try {
      await access(abs);
    } catch {
      failures.push(`${subpath} → ${trail.join(" → ")} (${node}) (missing)`);
    }
    return;
  }
  for (const [condition, value] of Object.entries(node)) {
    await walk(subpath, value, [...trail, condition]);
  }
}

for (const [subpath, conditions] of Object.entries(pkg.exports)) {
  await walk(subpath, conditions, []);
}

if (failures.length > 0) {
  console.error("verify-exports: missing files declared in package.json#exports:");
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}

console.log(
  `verify-exports: all ${entryCount} condition entries across ${Object.keys(pkg.exports).length} subpaths resolved.`,
);
