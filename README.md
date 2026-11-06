# Agent Flight Recorder

Agent Flight Recorder (AFR) is a small, local-first recorder for AI agent runs. Instrument a run and its tools, reproduce a failure, then inspect the event timeline from your terminal. No account, server, or cloud service is required.

## Features

- TypeScript SDK for agent runs, tool calls, and named events
- Append-only JSONL storage at `.afr/traces.jsonl` by default
- Secret redaction enabled by default
- W3C Trace Context compatible trace IDs (32 hex characters) and span IDs (16 hex characters), with parent span links
- CLI commands to list runs, inspect a run, and find tool failures

## Requirements

Node.js 20 or newer.

## Install and build

```bash
npm install
npm run build
```

When published, install with `npm install @startupsandcode/agent-flight-recorder`. In this repository, run the CLI with `node dist/src/cli.js`, or run `npm link` after building to add the `afr` command to your path.

## Instrument an agent

```ts
import { FlightRecorder } from "@startupsandcode/agent-flight-recorder";
const recorder = new FlightRecorder();
const answer = await recorder.run({ name: "research-agent" }, async (run) => {
  const sources = await run.tool("search", () => searchWeb("local tracing"));
  await run.event("sources.loaded", { count: sources.length });
  return summarize(sources);
});
```

Tool or run errors are recorded and rethrown. See `examples/tool-error.ts` for a complete sample.

## Inspect a run

```bash
node dist/src/cli.js list
node dist/src/cli.js failures
node dist/src/cli.js show <run-id>
```

All commands accept a custom JSONL path. See the CLI help for details.

## Privacy and redaction

Redaction is on by default. AFR replaces values for common sensitive keys such as `apiKey`, `authorization`, `password`, `secret`, and `accessToken`, including nested object fields. It also masks common bearer tokens and inline key/value credentials inside strings. Add application-specific keys with `new FlightRecorder({ redactedKeys: ["customerEmail"] })`.

Redaction is best effort, not a guarantee that arbitrary sensitive text will be detected. Avoid recording prompts, user data, or raw tool payloads unless needed. Set `redact: false` only when you are comfortable writing unfiltered data to disk. Trace files are local and may contain operational details. Keep them out of version control; `.afr/` is ignored by default.

## Data format

Each line is one versioned JSON event with an ISO timestamp, kind, trace ID, span ID, parent span ID when applicable, run ID, name, optional duration and status, and optional attributes or error. IDs use W3C Trace Context hexadecimal widths. AFR does not yet export to an OpenTelemetry collector.

## Development

```bash
npm install
npm test
npm run example
```

See [CONTRIBUTING.md](CONTRIBUTING.md). Licensed under the MIT License.