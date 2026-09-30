import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { getFileInfo } from "prettier";

const supportedExtensions = new Set([
  ".cjs",
  ".css",
  ".js",
  ".json",
  ".jsx",
  ".md",
  ".mjs",
  ".ts",
  ".tsx",
  ".yaml",
  ".yml",
]);

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

function isIgnored(file) {
  const result = spawnSync("git", ["check-ignore", "--quiet", "--no-index", "--", file], {
    stdio: "ignore",
  });
  return result.status === 0;
}

const repositoryRoot = git(["rev-parse", "--show-toplevel"]);
const head = git(["rev-parse", "HEAD"]);
const candidateFiles = process.env.CI ? ciChangedFiles(head) : localChangedFiles();
const candidatePaths = [...new Set(candidateFiles)]
  .filter((file) => supportedExtensions.has(extname(file).toLowerCase()))
  .filter((file) => {
    const absolutePath = join(repositoryRoot, file);
    return existsSync(absolutePath) && statSync(absolutePath).isFile() && !isIgnored(file);
  })
  .sort();
const files = [];

for (const file of candidatePaths) {
  const fileInfo = await getFileInfo(join(repositoryRoot, file), {
    ignorePath: join(repositoryRoot, ".prettierignore"),
  });

  if (!fileInfo.ignored) {
    files.push(file);
  }
}

if (files.length === 0) {
  console.log("No supported changed files to check.");
  process.exit(0);
}

console.log("Prettier checking changed files:");
for (const file of files) {
  console.log(`- ${relative(repositoryRoot, join(repositoryRoot, file))}`);
}

const prettierCli = join(repositoryRoot, "node_modules", "prettier", "bin", "prettier.cjs");
const result = spawnSync(process.execPath, [prettierCli, "--check", "--ignore-unknown", ...files], {
  cwd: repositoryRoot,
  stdio: "inherit",
});

process.exit(result.status ?? 1);
