#!/usr/bin/env node
// verify-docs.mjs — docs version gate (ai*js family, wave 2026-06-10).
//
// Guards the contract-drift class found in every review wave: README status
// banners regressing out of sync with package.json. Checks:
//   1. README.md (and README_ZHTW.md when present) contains at least one
//      status banner line of the canonical shape
//        > **Status: <x.y.z> — <description>**
//        > **狀態：<x.y.z> — <描述>**
//      whose version equals package.json `version`.
//   2. No banner line mentions any other x.y.z version (keeps the banner
//      single-sourced; ranges like "0.5.x" are fine).
//   3. When src/version.ts exists (aiecsjs), its VERSION constant equals
//      package.json `version` (double-bump guard).
//
// Pure node built-ins, no dependencies — same policy as build-llms-full.mjs.
// Usage: node scripts/verify-docs.mjs   (run from the package root)

import { existsSync, readFileSync } from "node:fs";

const fail = (msg) => {
  console.error(`verify-docs: ${msg}`);
  process.exit(1);
};

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const version = pkg.version;
if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) {
  fail(`package.json version "${version}" is not a plain x.y.z semver`);
}

const BANNER = /^>\s*\*\*(?:Status|狀態)[:：]\s*(\d+\.\d+\.\d+)/;
const ANY_SEMVER = /\d+\.\d+\.\d+/g;

let checked = 0;
for (const file of ["README.md", "README_ZHTW.md"]) {
  if (!existsSync(file)) continue;
  const lines = readFileSync(file, "utf8").split("\n");
  const banners = [];
  lines.forEach((line, i) => {
    if (/^>\s*\*\*(?:Status|狀態)[:：]/.test(line)) banners.push({ line, n: i + 1 });
  });
  if (banners.length === 0) {
    fail(`${file}: no status banner line found (expected \`> **Status: ${version} — ...**\`)`);
  }
  for (const { line, n } of banners) {
    const head = line.match(BANNER);
    if (!head) {
      fail(`${file}:${n}: status banner must start with the x.y.z version right after the colon`);
    }
    for (const m of line.matchAll(ANY_SEMVER)) {
      if (m[0] !== version) {
        fail(`${file}:${n}: banner mentions ${m[0]} but package.json is ${version}`);
      }
    }
    checked += 1;
  }
}

if (existsSync("src/version.ts")) {
  const src = readFileSync("src/version.ts", "utf8");
  const m = src.match(/VERSION\s*=\s*["']([^"']+)["']/);
  if (!m) fail("src/version.ts: VERSION constant not found");
  if (m[1] !== version) {
    fail(`src/version.ts VERSION is ${m[1]} but package.json is ${version}`);
  }
  checked += 1;
}

console.log(`verify-docs: ok (${checked} version marker${checked === 1 ? "" : "s"} match ${version})`);
