import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FlightRecorder, redact } from "../src/index.js";

test("records runs and tool errors with correlated trace and parent span IDs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "afr-"));
  try {
    const file = join(dir, "trace.jsonl");
    const recorder = new FlightRecorder({ file, idGenerator: (bytes) => bytes === 16 ? "a".repeat(32) : "b".repeat(16) });
    await assert.rejects(recorder.run({ name: "demo" }, async (run) => {
      await run.tool("broken", () => { throw new Error("boom"); });
    }), /boom/);
    const events = (await readFile(file, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(events.map((e) => e.kind), ["agent.start", "tool.start", "tool.error", "agent.end"]);
    assert.ok(events.every((e) => e.traceId === "a".repeat(32)));
    assert.equal(events[1].parentSpanId, events[0].spanId);
    assert.equal(events[2].error.message, "boom");
    assert.equal(events[3].status, "error");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("redacts secret keys and credentials embedded in strings by default", async () => {
  assert.deepEqual(redact({ apiKey: "abc", nested: { note: "Authorization: Bearer abc.def" } }), {
    apiKey: "[REDACTED]", nested: { note: "Authorization: Bearer [REDACTED]" }
  });
  const dir = await mkdtemp(join(tmpdir(), "afr-"));
  try {
    const file = join(dir, "trace.jsonl");
    await new FlightRecorder({ file }).run({ name: "safe", attributes: { password: "do-not-store" } }, (run) => run.event("note", { message: "api_key=verysecret" }));
    const text = await readFile(file, "utf8");
    assert.doesNotMatch(text, /do-not-store|verysecret/);
    assert.match(text, /\[REDACTED\]/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("writes concurrent events as valid complete JSONL records", async () => {
  const dir = await mkdtemp(join(tmpdir(), "afr-"));
  try {
    const file = join(dir, "trace.jsonl"); const recorder = new FlightRecorder({ file });
    await recorder.run({ name: "parallel" }, async (run) => {
      await Promise.all(Array.from({ length: 20 }, (_, i) => run.event(`event-${i}`)));
    });
    const lines = (await readFile(file, "utf8")).trim().split("\n");
    assert.equal(lines.length, 22);
    for (const line of lines) JSON.parse(line);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
