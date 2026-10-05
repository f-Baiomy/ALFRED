# Quickstart: Alfred for Claude (MCP)

## Prerequisites

- Alfred running (`python3 start.py`), UI on `http://localhost:3000`.
- Node 22+.
- `frontend/node_modules` installed (`cd frontend && npm ci`) - the server imports the frontend's pure utils, which resolve `@angular/core`/`rxjs` from there.

## Install

```bash
cd mcp-server && npm ci
```

## Register once, for every project (user scope)

```bash
claude mcp add --scope user alfred -- node C:/projects/Alfred/Alfred/mcp-server/node_modules/tsx/dist/cli.mjs C:/projects/Alfred/Alfred/mcp-server/src/index.ts
```

Runs `node` with the server's own pinned `tsx` - no npm/npx, so no `cmd /c` wrapper on Windows and nothing downloaded at start. Set `ALFRED_URL` if Alfred is not on `http://localhost:3000`:

```bash
claude mcp add --scope user alfred -e ALFRED_URL=http://localhost:3000 -- node C:/projects/Alfred/Alfred/mcp-server/node_modules/tsx/dist/cli.mjs C:/projects/Alfred/Alfred/mcp-server/src/index.ts
```

Per-project alternative: a `.mcp.json` in the odeysys repo root:

```json
{ "mcpServers": { "alfred": { "command": "node", "args": ["C:/projects/Alfred/Alfred/mcp-server/node_modules/tsx/dist/cli.mjs", "C:/projects/Alfred/Alfred/mcp-server/src/index.ts"] } } }
```

## Try it (from the odeysys project)

- "List my Alfred cycles."
- "Debug the cycle 'booking fails at payment'."
- "Open call 500d0cdc-ed5b-459e-9afa-ef7c2996949f, show its database findings and statement #42."
- "Comment on that call's response body that the fan-out comes from SystemSettingService.java:75."
- "Create a cycle 'fan-out repro' from that call with a spacer 'search' above it."
- "Start recording a cycle 'payment retry'." … "Stop recording."
- "Export cycle 'fan-out repro' as html to C:/tmp/repro.html."

## Verify

```bash
cd mcp-server && npm test
```

```bash
cd mcp-server && npm run live-check
```

`live-check` runs the spec's live scenario against the running Alfred (call 500d0cdc…: overview has the fan-out #19-#25 and the swallowed failure #42; adds a comment, creates a test cycle, copies the call in, adds a spacer, exports .md/.json/.html to a temp dir, then deletes the test comment and the test cycle).

## Session settings

- "Hide secrets for this session." → replies masked with Alfred's Redactions (start masked: register with `-e ALFRED_MCP_MASK=1`).
- "Show this one call unmasked." → one-request override.
- "Save exports to C:/tmp/alfred for this session." → later exports with no path or a relative path go there; without it Claude asks where to save each time.

## Data warning

With masking off, tool replies contain recorded bodies, headers, tokens and database rows verbatim, and they reach the model provider through the Claude session. Exports are always masked by Alfred's Redactions, as in the UI.
