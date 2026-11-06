#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { TraceEvent } from "./index.js";

function help(): void {
  console.log(`Agent Flight Recorder v0.1

Usage:
  afr list [file]             List recorded runs
  afr show <run-id> [file]    Show a run timeline
  afr failures [file]         List failed tool calls

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
  const [command, a, b] = process.argv.slice(2);
  if (!command || command === "help" || command === "--help") return help();
  const file = command === "show" ? (b ?? ".afr/traces.jsonl") : (a ?? ".afr/traces.jsonl");
  const events = await load(file);
  if (command === "list") return summary(events);
  if (command === "failures") {
    const failures = events.filter((e) => e.kind === "tool.error");
    if (!failures.length) return console.log("No tool failures found.");
    for (const event of failures) console.log(`${event.runId}  ${event.name}: ${event.error?.message ?? "unknown error"}`);
    return;
  }
  if (command === "show") {
    if (!a) throw new Error("Usage: afr show <run-id> [file]");
    const selected = events.filter((e) => e.runId === a);
    if (!selected.length) throw new Error(`Run not found: ${a}`);
    return timeline(selected);
  }
  help(); process.exitCode = 1;
}
main().catch((error: unknown) => { console.error(`afr: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; });
