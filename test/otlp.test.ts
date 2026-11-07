import test from "node:test";
import assert from "node:assert/strict";
import type { TraceEvent } from "../src/index.js";
import { toOtlpTrace } from "../src/otlp.js";

const traceId = "1".repeat(32);
const rootSpanId = "2".repeat(16);
const toolSpanId = "3".repeat(16);
const timestamp = "2026-11-06T12:00:00.000Z";

function event(input: Partial<TraceEvent> & Pick<TraceEvent, "kind" | "spanId" | "name">): TraceEvent {
  return { schemaVersion: 1, timestamp, traceId, runId: "run-1", ...input } as TraceEvent;
}

test("maps agent and tool events into linked OTLP spans with status and span events", () => {
  const data = [
    event({ kind: "agent.start", spanId: rootSpanId, name: "agent", attributes: { model: "test-model" } }),
    event({ kind: "event", spanId: rootSpanId, name: "response.received", attributes: { code: 200 } }),
    event({ kind: "tool.start", spanId: toolSpanId, parentSpanId: rootSpanId, name: "search" }),
    event({ kind: "tool.error", spanId: toolSpanId, parentSpanId: rootSpanId, name: "search", status: "error", error: { name: "Error", message: "service unavailable" } }),
    event({ kind: "agent.end", spanId: rootSpanId, name: "agent", status: "error", error: { name: "Error", message: "service unavailable" } })
  ];
  const output = toOtlpTrace(data, { serviceName: "test-agent" }) as any;
  const resourceSpans = output.resourceSpans[0];
  const spans = resourceSpans.scopeSpans[0].spans;
  const agent = spans.find((span: any) => span.spanId === rootSpanId);
  const tool = spans.find((span: any) => span.spanId === toolSpanId);

  assert.equal(resourceSpans.resource.attributes[0].value.stringValue, "test-agent");
  assert.equal(agent.traceId, traceId);
  assert.equal(agent.status.code, "STATUS_CODE_ERROR");
  assert.equal(agent.events[0].name, "response.received");
  assert.equal(agent.events[0].attributes[0].value.intValue, "200");
  assert.equal(tool.parentSpanId, rootSpanId);
  assert.equal(tool.kind, "SPAN_KIND_CLIENT");
  assert.equal(tool.events[0].name, "exception");
  assert.equal(tool.status.message, "service unavailable");
});

test("rejects invalid trace IDs instead of exporting invalid OTLP spans", () => {
  assert.throws(() => toOtlpTrace([event({ kind: "agent.start", traceId: "bad", spanId: rootSpanId, name: "agent" })]), /invalid trace ID/);
});
