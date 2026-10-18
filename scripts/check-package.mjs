import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, mkdirSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const temp = mkdtempSync(join(tmpdir(), "ridian-package-"));
try {
  const [pack] = JSON.parse(
    execFileSync(
      "npm",
      ["pack", "--ignore-scripts", "--json", "--pack-destination", temp],
      { encoding: "utf8" },
    ),
  );
  assert.deepEqual(
    pack.files.map((f) => f.path).sort(),
    [
      "LICENSE",
      "README.md",
      "dist/index.d.ts",
      "dist/index.js",
      "package.json",
    ].sort(),
  );
  const consumer = join(temp, "consumer");
  mkdirSync(consumer);
  execFileSync(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--prefix",
      consumer,
      join(temp, pack.filename),
    ],
    { stdio: "pipe" },
  );
  const installed = join(consumer, "node_modules", "@getridian", "mailbox");
  for (const file of [
    "dist/index.js",
    "dist/index.d.ts",
    "README.md",
    "LICENSE",
  ])
    assert.deepEqual(readFileSync(join(installed, file)), readFileSync(file));
  const metadata = JSON.parse(readFileSync(join(installed, "package.json")));
  assert.equal(metadata.name, "@getridian/mailbox");
  assert.equal(metadata.license, "MIT");
  assert.equal(metadata.publishConfig.tag, "alpha");
  cpSync("tests", join(installed, "tests"), { recursive: true });
  execFileSync(process.execPath, ["--test", "tests/client.test.mjs"], {
    cwd: installed,
    stdio: "inherit",
  });
  console.log(
    "Package allowlist, metadata, byte parity and installed-package tests passed.",
  );
} finally {
  rmSync(temp, { recursive: true, force: true });
}
