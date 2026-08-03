#!/usr/bin/env node
// Link each vendored checkout's own workspace packages into its own
// node_modules, so a bare specifier inside that checkout resolves to ITS
// sibling package rather than to eochat's.
//
// Why this exists. `vendor/eoreader5` declares npm workspaces, so
// `packages/engine` importing "@eoreader/spec/cube/index.js" is meant to find
// `vendor/eoreader5/packages/spec`. Nothing had ever run an install inside the
// submodule, so that link did not exist — and Node, walking up from the
// importing file, kept going until it reached eochat's own node_modules, where
// "@eoreader/spec" is linked to **eoreader6**. eoreader6's spec has no `cube/`
// directory at all, so terrain analysis (UX-DESIGN affordance 15) failed with
// ERR_MODULE_NOT_FOUND against a path nobody had written.
//
// That failure was invisible for a second reason: the two call sites imported
// the perceiver by absolute path from one developer's home directory, so on
// every other machine the import threw before resolution ever got this far.
// Fixing the path exposed the version mismatch underneath it.
//
// This is done with symlinks rather than `npm install --workspaces` because it
// must work offline and must not touch the submodule's git state. It is
// idempotent, and a checkout that is not present is skipped rather than fatal —
// the vendored engine is optional, and its absence is already reported by the
// affordance that needs it.

import fs from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "../server/paths.js";

const VENDORED = [path.join(REPO_ROOT, "vendor", "eoreader5")];

let linked = 0, skipped = 0;

for (const root of VENDORED) {
  const packagesDir = path.join(root, "packages");
  if (!fs.existsSync(packagesDir)) {
    console.log(`[link-workspaces] ${path.relative(REPO_ROOT, root)} not present — skipped`);
    skipped++;
    continue;
  }

  for (const entry of fs.readdirSync(packagesDir)) {
    const pkgDir = path.join(packagesDir, entry);
    const manifest = path.join(pkgDir, "package.json");
    if (!fs.existsSync(manifest)) continue;

    let name;
    try {
      name = JSON.parse(fs.readFileSync(manifest, "utf8")).name;
    } catch {
      continue; // an unreadable manifest is not this script's problem to report
    }
    if (!name) continue;

    // Scoped names need their scope directory to exist first.
    const target = path.join(root, "node_modules", ...name.split("/"));
    fs.mkdirSync(path.dirname(target), { recursive: true });

    // Replace an existing link only if it points somewhere else; leaving a
    // correct link alone keeps this cheap to run on every install.
    try {
      if (fs.lstatSync(target).isSymbolicLink()) {
        if (path.resolve(path.dirname(target), fs.readlinkSync(target)) === pkgDir) continue;
        fs.unlinkSync(target);
      } else {
        continue; // a real directory here is someone's deliberate install
      }
    } catch { /* nothing there yet */ }

    fs.symlinkSync(path.relative(path.dirname(target), pkgDir), target, "junction");
    linked++;
  }
}

console.log(`[link-workspaces] linked ${linked} vendored workspace package(s)` +
  (skipped ? `, ${skipped} checkout(s) not present` : ""));
