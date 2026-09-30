import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { ESLint } from "eslint";

const supportedExtensions = new Set([".cjs", ".js", ".jsx", ".mjs", ".ts", ".tsx"]);

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function gitLines(args) {
  const output = git(args);
  return output === "" ? [] : output.split(/\r?\n/);
}

function commitExists(ref) {
  try {
    git(["cat-file", "-e", `${ref}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

function previousCommit() {
  try {
    return git(["rev-parse", "HEAD^"]);
  } catch {
    return null;
  }
}

function ciChangedFiles(head) {
  const requestedBase = process.env.FORMAT_BASE_SHA;
  const base =
    requestedBase && !/^0+$/.test(requestedBase) && commitExists(requestedBase)
      ? requestedBase
      : previousCommit();

  if (base) {
    return gitLines(["diff", "--name-only", "--diff-filter=ACMR", base, head]);
  }

  return gitLines(["ls-tree", "-r", "--name-only", head]);
}

function localChangedFiles() {
  return [
    ...gitLines(["diff", "--name-only", "--diff-filter=ACMR"]),
    ...gitLines(["diff", "--cached", "--name-only", "--diff-filter=ACMR"]),
    ...gitLines(["ls-files", "--others", "--exclude-standard"]),
  ];
}

function isGitIgnored(file) {
  const result = spawnSync("git", ["check-ignore", "--quiet", "--no-index", "--", file], {
    stdio: "ignore",
  });
  return result.status === 0;
}

const repositoryRoot = git(["rev-parse", "--show-toplevel"]);
const head = git(["rev-parse", "HEAD"]);
const candidateFiles = process.env.CI ? ciChangedFiles(head) : localChangedFiles();
const eslint = new ESLint({ cwd: repositoryRoot });
const files = [];

for (const file of [...new Set(candidateFiles)].sort()) {
  const absolutePath = join(repositoryRoot, file);
  const isSupported = supportedExtensions.has(extname(file).toLowerCase());
  const isExistingFile = existsSync(absolutePath) && statSync(absolutePath).isFile();

  if (
    isSupported &&
    isExistingFile &&
    !isGitIgnored(file) &&
    !(await eslint.isPathIgnored(absolutePath))
  ) {
    files.push(file);
  }
}

if (files.length === 0) {
  console.log("No supported changed files to lint.");
  process.exit(0);
}

console.log("ESLint checking changed files:");
for (const file of files) {
  console.log(`- ${file}`);
}

const eslintCli = join(repositoryRoot, "node_modules", "eslint", "bin", "eslint.js");
const result = spawnSync(process.execPath, [eslintCli, ...files], {
  cwd: repositoryRoot,
  stdio: "inherit",
});

process.exit(result.status ?? 1);
