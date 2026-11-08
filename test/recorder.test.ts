import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
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
  assert.equal(redact('upstream error: {"api_key": "topsecret"}'), 'upstream error: {"api_key": "[REDACTED]"}');
  assert.equal(redact("tokens sk-proj-12345678901234567890 ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456"), "tokens [REDACTED] [REDACTED]");
  assert.equal(redact("custom-session=cust-A1B2C3", [], [/cust-[A-Z0-9]{6}/g]), "custom-session=[REDACTED]");
  const dir = await mkdtemp(join(tmpdir(), "afr-"));
  try {
    const file = join(dir, "trace.jsonl");
    await new FlightRecorder({ file }).run({ name: "safe", attributes: { password: "do-not-store" } }, (run) => run.event("note", { message: "api_key=verysecret" }));
    const text = await readFile(file, "utf8");
    assert.doesNotMatch(text, /do-not-store|verysecret/);
    assert.match(text, /\[REDACTED\]/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("applies custom secret patterns to recorded error messages", async () => {
  const dir = await mkdtemp(join(tmpdir(), "afr-custom-redact-"));
  try {
    const file = join(dir, "trace.jsonl");
    const recorder = new FlightRecorder({ file, redactPatterns: [/cust-[A-Z0-9]{6}/g] });
    await assert.rejects(recorder.run({ name: "custom-secret" }, (run) => run.tool("request", () => { throw new Error("Rejected cust-X7Q2P9"); })), /Rejected cust-X7Q2P9/);
    const contents = await readFile(file, "utf8");
    assert.doesNotMatch(contents, /cust-X7Q2P9/);
    assert.match(contents, /Rejected \[REDACTED\]/);
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

test("rotates traces at the configured size and rejects a single oversized event", async () => {
  const dir = await mkdtemp(join(tmpdir(), "afr-"));
  try {
    const file = join(dir, "trace.jsonl");
    const recorder = new FlightRecorder({ file, maxFileBytes: 300, maxFiles: 2 });
    const base = { kind: "event" as const, traceId: "a".repeat(32), spanId: "b".repeat(16), runId: "rotation-test", name: "checkpoint", attributes: { value: "x".repeat(35) } };
    await recorder.record({ ...base, name: "one" });
    await recorder.record({ ...base, name: "two" });
    await recorder.record({ ...base, name: "three" });
    const files = await readdir(dir);
    assert.deepEqual(files.sort(), ["trace.jsonl", "trace.jsonl.1", "trace.jsonl.2"]);
    for (const name of files) assert.ok((await readFile(join(dir, name), "utf8")).length <= 300);

    const limited = new FlightRecorder({ file: join(dir, "small.jsonl"), maxFileBytes: 200 });
    await assert.rejects(limited.record({ ...base, name: "too-large", attributes: { value: "x".repeat(500) } }), /larger than maxFileBytes/);
    await limited.record({ kind: "event", traceId: base.traceId, spanId: base.spanId, runId: base.runId, name: "small" });
    assert.equal((await readFile(join(dir, "small.jsonl"), "utf8")).trim().split("\n").length, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
