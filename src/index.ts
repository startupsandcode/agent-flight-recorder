import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, appendFile, rename, rm, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export type EventKind = "agent.start" | "agent.end" | "tool.start" | "tool.end" | "tool.error" | "event";
export interface TraceEvent {
  schemaVersion: 1;
  timestamp: string;
  kind: EventKind;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  runId: string;
  name: string;
  durationMs?: number;
  status?: "ok" | "error";
  attributes?: Record<string, unknown>;
  error?: { name: string; message: string };
}
export interface RecorderOptions {
  file?: string;
  redact?: boolean;
  redactedKeys?: string[];
  /** Additional patterns for application-specific secret formats. Matches are replaced with [REDACTED]. */
  redactPatterns?: RegExp[];
  clock?: () => Date;
  idGenerator?: (bytes: number) => string;
  /** Maximum size of one JSONL file before rotating it. Defaults to 5 MiB. */
  maxFileBytes?: number;
  /** Number of rotated copies to keep alongside the active file. Defaults to 3. */
  maxFiles?: number;
}
export interface RunOptions { name?: string; attributes?: Record<string, unknown>; traceId?: string; runId?: string; }
export interface ToolOptions { name?: string; attributes?: Record<string, unknown>; }

const DEFAULT_FILE = ".afr/traces.jsonl";
const SECRET_KEY = /(?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|secret|password|passwd|credential|cookie|private[_-]?key)/i;
const TOKEN_VALUE = /\b(?:Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi;
const JSON_SECRET = /(["'])(api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)\1\s*:\s*(["'])[^"']*\3/gi;
const KEY_VALUE = /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)\s*[:=]\s*(["']?)[^\s,;"']+\2/gi;
const KNOWN_TOKENS = /\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|AIza[0-9A-Za-z_-]{30,}|AKIA[0-9A-Z]{16})\b/g;
const JWT = /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g;

export function redact(value: unknown, extraKeys: string[] = [], extraPatterns: RegExp[] = []): unknown {
  const sensitive = new RegExp(`(?:${[SECRET_KEY.source, ...extraKeys.map(escapeRegex)].join("|")})`, "i");
  if (typeof value === "string") {
    let result = value.replace(JSON_SECRET, "$1$2$1: $3[REDACTED]$3").replace(TOKEN_VALUE, "Bearer [REDACTED]").replace(KEY_VALUE, "$1=[REDACTED]").replace(KNOWN_TOKENS, "[REDACTED]").replace(JWT, "[REDACTED]");
    for (const pattern of extraPatterns) {
      const flags = [...new Set(`${pattern.flags.replaceAll("y", "")}g`)].join("");
      result = result.replace(new RegExp(pattern.source, flags), "[REDACTED]");
    }
    return result;
  }
  if (Array.isArray(value)) return value.map((item) => redact(item, extraKeys, extraPatterns));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sensitive.test(key) ? "[REDACTED]" : redact(item, extraKeys, extraPatterns)]));
  }
  return value;
}
function escapeRegex(value: string): string { return value.replace(/[.*+?^\x24{}()|[\]\\]/g, "\\$&"); }
function hexId(bytes: number): string { return randomBytes(bytes).toString("hex"); }
function errorInfo(error: unknown): { name: string; message: string } {
  if (error instanceof Error) return { name: error.name, message: error.message };
  return { name: "Error", message: String(error) };
}

export class FlightRecorder {
  readonly file: string;
  private readonly shouldRedact: boolean;
  private readonly extraRedactedKeys: string[];
  private readonly extraRedactPatterns: RegExp[];
  private readonly clock: () => Date;
  private readonly id: (bytes: number) => string;
  private readonly maxFileBytes: number;
  private readonly maxFiles: number;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(options: RecorderOptions = {}) {
    this.file = resolve(options.file ?? DEFAULT_FILE);
    this.shouldRedact = options.redact ?? true;
    this.extraRedactedKeys = options.redactedKeys ?? [];
    this.extraRedactPatterns = options.redactPatterns ?? [];
    this.clock = options.clock ?? (() => new Date());
    this.id = options.idGenerator ?? hexId;
    this.maxFileBytes = options.maxFileBytes ?? 5 * 1024 * 1024;
    this.maxFiles = options.maxFiles ?? 3;
    if (!Number.isSafeInteger(this.maxFileBytes) || this.maxFileBytes < 1) throw new RangeError("maxFileBytes must be a positive safe integer");
    if (!Number.isSafeInteger(this.maxFiles) || this.maxFiles < 1) throw new RangeError("maxFiles must be a positive safe integer");
  }

  async run<T>(options: RunOptions, fn: (run: AgentRun) => Promise<T> | T): Promise<T> {
    const traceId = options.traceId ?? this.id(16);
    const runId = options.runId ?? randomUUID();
    assertHexId(traceId, 32, "traceId");
    const spanId = this.id(8); assertHexId(spanId, 16, "spanId");
    const run = new AgentRun(this, { traceId, spanId, runId, name: options.name ?? "agent", ...(options.attributes ? { attributes: options.attributes } : {}) });
    const started = this.clock().getTime();
    await this.record({ kind: "agent.start", traceId, spanId, runId, name: run.name, ...(options.attributes ? { attributes: options.attributes } : {}) });
    try {
      const result = await fn(run);
      await this.record({ kind: "agent.end", traceId, spanId, runId, name: run.name, durationMs: Math.max(0, this.clock().getTime() - started), status: "ok" });
      return result;
    } catch (error) {
      await this.record({ kind: "agent.end", traceId, spanId, runId, name: run.name, durationMs: Math.max(0, this.clock().getTime() - started), status: "error", error: errorInfo(error) });
      throw error;
    }
  }

  async record(input: Omit<TraceEvent, "schemaVersion" | "timestamp"> & { timestamp?: string }): Promise<void> {
    const event: TraceEvent = {
      schemaVersion: 1,
      timestamp: input.timestamp ?? this.clock().toISOString(),
      ...input,
      ...(input.attributes && this.shouldRedact ? { attributes: redact(input.attributes, this.extraRedactedKeys, this.extraRedactPatterns) as Record<string, unknown> } : {}),
      ...(input.error ? { error: this.shouldRedact ? redact(input.error, this.extraRedactedKeys, this.extraRedactPatterns) as { name: string; message: string } : input.error } : {})
    };
    const line = `${JSON.stringify(event)}\n`;
    this.writeQueue = this.writeQueue.catch(() => undefined).then(async () => {
      await mkdir(dirname(this.file), { recursive: true });
      const bytes = Buffer.byteLength(line, "utf8");
      if (bytes > this.maxFileBytes) throw new RangeError(`Trace event is ${bytes} bytes, larger than maxFileBytes (${this.maxFileBytes})`);
      let currentBytes = 0;
      try { currentBytes = (await stat(this.file)).size; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (currentBytes + bytes > this.maxFileBytes) await this.rotate();
      await appendFile(this.file, line, { encoding: "utf8", mode: 0o600 });
    });
    return this.writeQueue;
  }

  private async rotate(): Promise<void> {
    await rm(`${this.file}.${this.maxFiles}`, { force: true });
    for (let index = this.maxFiles - 1; index >= 1; index--) {
      try { await rename(`${this.file}.${index}`, `${this.file}.${index + 1}`); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    try { await rename(this.file, `${this.file}.1`); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}

interface RunContext { traceId: string; spanId: string; runId: string; name: string; attributes?: Record<string, unknown>; }
function assertHexId(value: string, length: number, label: string): void {
  if (!new RegExp(`^[0-9a-f]{${length}}$`, "i").test(value) || /^0+$/.test(value)) throw new TypeError(`${label} must be a non-zero ${length}-character hexadecimal ID`);
}

export class AgentRun {
  readonly traceId: string;
  readonly spanId: string;
  readonly runId: string;
  readonly name: string;
  readonly attributes?: Record<string, unknown>;
  constructor(private readonly recorder: FlightRecorder, context: RunContext) {
    this.traceId = context.traceId; this.spanId = context.spanId; this.runId = context.runId; this.name = context.name;
    if (context.attributes) this.attributes = context.attributes;
  }
  async tool<T>(name: string, fn: () => Promise<T> | T, options: ToolOptions = {}): Promise<T> {
    const spanId = randomBytes(8).toString("hex");
    const started = Date.now();
    const attrs = options.attributes;
    const base = { traceId: this.traceId, spanId, parentSpanId: this.spanId, runId: this.runId, name: options.name ?? name };
    await this.recorder.record({ kind: "tool.start", ...base, ...(attrs ? { attributes: attrs } : {}) });
    try {
      const result = await fn();
      await this.recorder.record({ kind: "tool.end", ...base, durationMs: Math.max(0, Date.now() - started), status: "ok" });
      return result;
    } catch (error) {
      await this.recorder.record({ kind: "tool.error", ...base, durationMs: Math.max(0, Date.now() - started), status: "error", error: errorInfo(error) });
      throw error;
    }
  }
  event(name: string, attributes?: Record<string, unknown>): Promise<void> {
    return this.recorder.record({ kind: "event", traceId: this.traceId, spanId: this.spanId, runId: this.runId, name, ...(attributes ? { attributes } : {}) });
  }
}

export function readTraceFile(file: string): Promise<string> { return import("node:fs/promises").then(({ readFile }) => readFile(file, "utf8")); }
