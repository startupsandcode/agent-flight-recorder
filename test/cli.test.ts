import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FlightRecorder } from "../src/index.js";

const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
function runCli(args: string[], cwd: string): string {
  return execFileSync(process.execPath, [cli, ...args], { cwd, encoding: "utf8" });
}

test("CLI lists, finds, and explains a failed run from a custom trace file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "afr-cli-"));
  const file = join(dir, "trace.jsonl");
  try {
    const recorder = new FlightRecorder({ file });
    await assert.rejects(recorder.run({ name: "checkout-agent", runId: "run-for-cli-test" }, async (agent) => {
      await agent.tool("charge_card", () => { throw new Error("Payment provider timed out"); });
    }), /Payment provider timed out/);

    const listed = runCli(["list", file], dir);
    assert.match(listed, /run-for-cli-test.*checkout-agent.*error/);
    const failures = runCli(["failures", file], dir);
    assert.match(failures, /run-for-cli-test.*charge_card: Payment provider timed out/);
    const timeline = runCli(["show", "run-for-cli-test", file], dir);
    assert.match(timeline, /agent\.start.*checkout-agent/);
    assert.match(timeline, /tool\.error.*charge_card.*Payment provider timed out/);

    assert.throws(() => runCli(["show", "missing-run", file], dir), /Run not found/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("CLI help works without a trace file", () => {
  const output = runCli(["--help"], resolve("."));
  assert.match(output, /afr list/);
  assert.match(output, /afr failures/);
});
