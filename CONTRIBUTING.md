# Contributing

Thanks for helping make agent debugging more practical. Small, focused contributions are welcome.

## Development setup

- Node.js 20 or newer
- npm

```bash
npm install
npm test
```

Run `npm run example` to create a local sample trace. The generated `.afr/` directory contains runtime data and should not be committed.

## Pull requests

1. Open an issue for large changes so the direction can be discussed.
2. Keep changes focused and preserve the local-first, dependency-light design.
3. Add or update tests for behavior changes.
4. Run `npm test` before opening a pull request.
5. Describe the user-facing behavior and any format changes in the pull request.

## Event format

Event records are append-only JSONL and carry `schemaVersion`. New optional fields are preferred for compatible additions. If a change breaks older readers or writers, discuss a schema version increase before implementing it. Keep W3C trace and span ID widths valid.

## Security and privacy

Never include real credentials, personal information, or production trace files in issues, tests, or pull requests. Use synthetic fixtures. Report security issues privately to the repository maintainers instead of opening a public issue.

## Code style

Use strict TypeScript, clear names, and Node built-ins where possible. Avoid adding runtime dependencies without explaining the need and maintenance cost.
