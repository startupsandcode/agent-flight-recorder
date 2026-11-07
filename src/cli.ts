#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { TraceEvent } from "./index.js";
import { toOtlpTrace } from "./otlp.js";

function help(): void {
  console.log(`Agent Flight Recorder v0.1

Usage:
  afr list [--file <path>]             List recorded runs
  afr show <run-id|latest> [--file <path>]  Show a run timeline
  afr failures [--file <path>]         List failed tool calls
  afr export-otlp [--file <path>] [--out <path>]  Export OTLP JSON

Default file: .afr/traces.jsonl`);
}
async function load(file: string): Promise<TraceEvent[]> {
  try {
    const text = await readFile(resolve(file), "utf8");
    return text.split(/\r?\n/).filter(Boolean).map((line, index) => {
      try { return JSON.parse(line) as TraceEvent; }
      catch { throw new Error(`Invalid JSON on line ${index + 1}`); }
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`Trace file not found: ${resolve(file)}`);
    throw error;
  }
}
const time = (stamp: string) => new Date(stamp).toLocaleTimeString();
function summary(events: TraceEvent[]): void {
  const starts = events.filter((e) => e.kind === "agent.start");
  if (!starts.length) { console.log("No agent runs found."); return; }
  for (const start of starts) {
    const end = events.find((e) => e.kind === "agent.end" && e.runId === start.runId);
    console.log(`${start.runId}  ${start.name}  ${end?.status ?? "running"}  ${start.timestamp}`);
  }
}
function timeline(events: TraceEvent[]): void {
  for (const event of events) {
    const marker = event.status === "error" ? "!" : event.kind.endsWith("start") ? ">" : "-";
    const duration = event.durationMs === undefined ? "" : ` (${event.durationMs}ms)`;
    const error = event.error ? `: ${event.error.name}: ${event.error.message}` : "";
    console.log(`${time(event.timestamp)} ${marker} ${event.kind.padEnd(11)} ${event.name}${duration}${error}`);
    if (event.attributes && Object.keys(event.attributes).length) console.log(`  ${JSON.stringify(event.attributes)}`);
  }
}
async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === "help" || command === "--help") return help();
  const fileFlag = args.findIndex((arg) => arg === "--file" || arg === "-f");
  let file = ".afr/traces.jsonl";
  if (fileFlag !== -1) {
    const selectedFile = args[fileFlag + 1];
    if (!selectedFile) throw new Error("--file requires a path");
    file = selectedFile;
    args.splice(fileFlag, 2);
  } else if (args.length > (command === "show" ? 1 : 0) && !(command === "export-otlp" && args.includes("--out"))) {
    // Keep accepting the original positional file argument for v0.1 users.
    file = args.pop()!;
  }
  const outFlag = args.findIndex((arg) => arg === "--out");
  let outputFile: string | undefined;
  if (outFlag !== -1) {
    outputFile = args[outFlag + 1];
    if (!outputFile) throw new Error("--out requires a path");
    args.splice(outFlag, 2);
  }
  const events = await load(file);
  if (command === "export-otlp") {
    const json = `${JSON.stringify(toOtlpTrace(events), null, 2)}\n`;
    if (outputFile) await writeFile(resolve(outputFile), json, "utf8");
    else process.stdout.write(json);
    return;
  }
  if (command === "list") return summary(events);
  if (command === "failures") {
    const failures = events.filter((e) => e.kind === "tool.error");
    if (!failures.length) return console.log("No tool failures found.");
    for (const event of failures) console.log(`${event.runId}  ${event.name}: ${event.error?.message ?? "unknown error"}`);
    return;
  }
  if (command === "show") {
    const requested = args[0];
    if (!requested) throw new Error("Usage: afr show <run-id|latest> [--file <path>]");
    const starts = events.filter((event) => event.kind === "agent.start");
    const runId = requested === "latest" ? starts.at(-1)?.runId : requested;
    if (!runId) throw new Error("No agent runs found in this trace file");
    const selected = events.filter((e) => e.runId === runId);
    if (!selected.length) throw new Error(`Run not found: ${runId}`);
    return timeline(selected);
  }
  help(); process.exitCode = 1;
}
main().catch((error: unknown) => { console.error(`afr: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; });
