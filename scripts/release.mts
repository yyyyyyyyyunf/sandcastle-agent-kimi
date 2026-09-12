/**
 * Release helper: bump the version, commit, and create the `v*` tag that
 * triggers .github/workflows/release.yml (npm publish).
 *
 *   pnpm release patch|minor|major|<x.y.z> [--push]
 *
 * Requires a clean worktree on `main`. Without `--push` the commit and tag
 * stay local and the push commands are printed at the end.
 */

import { exec } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";

const execp = promisify(exec);

const fail = (msg: string): never => {
  console.error(`error: ${msg}`);
  process.exit(1);
};

const arg =
  process.argv.find((a, i) => i >= 2 && !a.startsWith("--")) ??
  fail("usage: pnpm release patch|minor|major|<x.y.z> [--push]");
const push = process.argv.includes("--push");

const pkgRaw = await readFile("package.json", "utf8");
const pkg = JSON.parse(pkgRaw) as { version: string };
const current = pkg.version;

const SEMVER = /^\d+\.\d+\.\d+$/;
if (!SEMVER.test(current)) {
  fail(`package.json version "${current}" is not x.y.z`);
}

const [major, minor, patch] = current.split(".").map(Number) as [
  number,
  number,
  number,
];
const next = SEMVER.test(arg)
  ? arg
  : arg === "major"
    ? `${major + 1}.0.0`
    : arg === "minor"
      ? `${major}.${minor + 1}.0`
      : arg === "patch"
        ? `${major}.${minor}.${patch + 1}`
        : fail(`unknown version bump "${arg}"`);

if (next === current) {
  fail(`version is already ${current}`);
}

const tag = `v${next}`;

const { stdout: status } = await execp("git status --porcelain");
if (status.trim()) {
  fail("worktree is not clean — commit or stash first");
}

const { stdout: branch } = await execp("git branch --show-current");
if (branch.trim() !== "main") {
  fail(`not on main (on "${branch.trim()}")`);
}

const tagExists = await execp(`git rev-parse -q --verify refs/tags/${tag}`)
  .then(() => true)
  .catch(() => false);
if (tagExists) {
  fail(`tag ${tag} already exists`);
}

console.log(`${current} → ${next}`);
console.log("running preflight: typecheck + test");
await execp("pnpm run typecheck && pnpm test", {
  env: { ...process.env, CI: "true" },
}).catch((e) => {
  throw new Error(`preflight failed\n${e.stdout ?? ""}${e.stderr ?? ""}`);
});

await writeFile(
  "package.json",
  pkgRaw.replace(`"version": "${current}"`, `"version": "${next}"`),
);

await execp(
  `git add package.json && git commit -m "chore: release ${tag}" && git tag ${tag}`,
);

console.log(`created commit + tag ${tag}`);
if (push) {
  await execp(`git push origin main && git push origin ${tag}`);
  console.log("pushed main and tag — release workflow is running");
} else {
  console.log(`\nto publish, run:\n  git push origin main && git push origin ${tag}`);
}
