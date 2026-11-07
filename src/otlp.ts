import type { TraceEvent } from "./index.js";

type JsonObject = Record<string, unknown>;
export interface OtlpOptions { serviceName?: string; }

function unixNanos(timestamp: string): string {
  const milliseconds = Date.parse(timestamp);
  if (!Number.isFinite(milliseconds)) throw new Error(`Invalid event timestamp: ${timestamp}`);
  return (BigInt(milliseconds) * 1_000_000n).toString();
}

function anyValue(value: unknown): JsonObject {
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "boolean") return { boolValue: value };
  if (typeof value === "number") return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value };
  if (value === null || value === undefined) return { stringValue: value === null ? "null" : "undefined" };
  if (Array.isArray(value)) return { arrayValue: { values: value.map(anyValue) } };
  if (typeof value === "object") return { kvlistValue: { values: Object.entries(value).map(([key, nested]) => ({ key, value: anyValue(nested) })) } };
  return { stringValue: String(value) };
}

function attributes(values: Record<string, unknown> | undefined): JsonObject[] {
  return Object.entries(values ?? {}).map(([key, value]) => ({ key, value: anyValue(value) }));
}

function validId(value: string, size: number, label: string): void {
  if (!new RegExp(`^[0-9a-f]{${size}}$`, "i").test(value) || /^0+$/.test(value)) {
    throw new Error(`Cannot export invalid ${label}: ${value}`);
  }
}

/** Convert AFR JSONL events to an OTLP ExportTraceServiceRequest JSON object. */
export function toOtlpTrace(events: TraceEvent[], options: OtlpOptions = {}): JsonObject {
  const spans = new Map<string, { traceId: string; spanId: string; parentSpanId?: string; runId: string; name: string; kind: "SPAN_KIND_INTERNAL" | "SPAN_KIND_CLIENT"; start?: TraceEvent; end?: TraceEvent; events: TraceEvent[] }>();
  for (const event of events) {
    validId(event.traceId, 32, "trace ID");
    validId(event.spanId, 16, "span ID");
    if (event.parentSpanId) validId(event.parentSpanId, 16, "parent span ID");
    const key = `${event.traceId}:${event.spanId}`;
    let span = spans.get(key);
    if (!span) {
      span = { traceId: event.traceId, spanId: event.spanId, ...(event.parentSpanId ? { parentSpanId: event.parentSpanId } : {}), runId: event.runId, name: event.name, kind: event.kind.startsWith("tool.") ? "SPAN_KIND_CLIENT" : "SPAN_KIND_INTERNAL", events: [] };
      spans.set(key, span);
    }
    if (event.kind === "agent.start" || event.kind === "tool.start") span.start = event;
    else if (event.kind === "agent.end" || event.kind === "tool.end" || event.kind === "tool.error") span.end = event;
    else span.events.push(event);
  }

  const outputSpans: JsonObject[] = [];
  for (const span of spans.values()) {
    if (!span.start) throw new Error(`Cannot export span ${span.spanId}: its start event is missing`);
    const start = span.start;
    const end = span.end ?? start;
    const spanAttrs = attributes(start.attributes);
    spanAttrs.push({ key: "afr.run_id", value: { stringValue: span.runId } });
    if (!span.end) spanAttrs.push({ key: "afr.incomplete", value: { boolValue: true } });

    const spanEvents: JsonObject[] = span.events.map((event) => ({
      timeUnixNano: unixNanos(event.timestamp),
      name: event.name,
      attributes: attributes(event.attributes)
    }));
    if (span.end?.error) {
      spanEvents.push({
        timeUnixNano: unixNanos(span.end.timestamp),
        name: "exception",
        attributes: attributes({ "exception.type": span.end.error.name, "exception.message": span.end.error.message })
      });
    }
    outputSpans.push({
      traceId: span.traceId,
      spanId: span.spanId,
      ...(span.parentSpanId ? { parentSpanId: span.parentSpanId } : {}),
      name: start.name,
      kind: span.kind,
      startTimeUnixNano: unixNanos(start.timestamp),
      endTimeUnixNano: unixNanos(end.timestamp),
      attributes: spanAttrs,
      events: spanEvents,
      status: span.end?.status === "error" ? { code: "STATUS_CODE_ERROR", message: span.end.error?.message ?? "" } : { code: "STATUS_CODE_UNSET" }
    });
  }

  outputSpans.sort((left, right) => {
    const leftStart = BigInt(left.startTimeUnixNano as string);
    const rightStart = BigInt(right.startTimeUnixNano as string);
    return leftStart < rightStart ? -1 : leftStart > rightStart ? 1 : 0;
  });
  return {
    resourceSpans: [{
      resource: { attributes: [{ key: "service.name", value: { stringValue: options.serviceName ?? "agent-flight-recorder" } }] },
      scopeSpans: [{ scope: { name: "agent-flight-recorder", version: "0.1.0" }, spans: outputSpans }]
    }]
  };
}
