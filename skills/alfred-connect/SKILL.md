---
name: alfred-connect
description: Connect Claude Code to an Alfred instance by its address - this machine, another port, a LAN host or a tunnel URL - by checking it answers and registering it as an MCP server (one per instance, named after it); also lists, checks, renames and removes connected Alfreds. Use when the user gives an Alfred link ("connect http://192.168.1.80:3000", "add the staging Alfred"), asks which Alfreds are connected, or says "/alfred-connect".
argument-hint: "<alfred url> [name] [--project <folder>] | list | remove <name>"
---

# Alfred connect

Read `rules.md` in this skill's folder first. Registering a server changes Claude Code's configuration: say exactly
what you will run and ask before running it.

Alfred can run in many places - `localhost:3000`, another port (`localhost:3001`), a LAN machine
(`http://192.168.1.80:3000`), a tunnel URL. Each instance is its own MCP server in Claude Code, with its own name, so
several can be connected at once.

## Modes

| Input | Do |
|---|---|
| `<url> [name]` | connect that instance (below) |
| `list` / nothing | `claude mcp list` - show every Alfred-looking server (name, address, connected or not); for each, say how to fix a failed one |
| `remove <name>` | ask, then `claude mcp remove <name> -s <its scope>` (`claude mcp get <name>` says the scope) |
| `rename <old> <new>` | remove and add again with the same address |

## Connect `<url>`

1. **Normalise** the address: add `http://` when there is no scheme, drop any path (`/board?…` → the origin). Keep the
   port. `localhost` and `127.0.0.1` are this machine.

2. **Is it an Alfred, and does it answer?** `curl -s -m 5 <url>/health` must give `{"status":"ok"}`.
   - No answer: say why it might be - Alfred not running there, wrong port, a firewall on the LAN machine, the
     machine's own `localhost` (a LAN Alfred must be reached by its LAN address), Settings → Server "Listen on" set to
     this machine only. Stop.
   - It answers but is not Alfred (no `/health`, HTML): say so and stop.

3. **Which kind of instance?** Probe its MCP relay:
   ```bash
   curl -s -m 5 -o /dev/null -w "%{http_code}" -X POST <url>/mcp -H "Content-Type: application/json" \
     -H "Accept: application/json, text/event-stream" \
     -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"alfred-connect","version":"1"}}}'
   ```
   - **200** → a native install with its own MCP server: connect over HTTP (4a).
   - **502 / 404** → a Docker install (it has no MCP server of its own): run Alfred's MCP server here, pointed at that
     instance's API (4b).

4. **Name it** (unless the user gave one): `alfred` for `http://localhost:3000` when no `alfred` exists yet;
   otherwise `alfred-<host>-<port>` with the host shortened - `alfred-local-3001`, `alfred-lan-80` (last part of a LAN
   IP), `alfred-<tunnel subdomain>`. Check `claude mcp list`:
   - the **same address** is already registered → say under which name; offer to keep it (done) or replace it;
   - the **name** is taken by another address → pick the next free name or ask.

   Scope: `user` (every project on this machine) unless the user gave `--project <folder>` (then `project`, written to
   that repo's `.mcp.json` - shared with everyone who clones it).

   **4a - HTTP (native install)**. Show and, on OK, run:
   ```bash
   claude mcp add --transport http --scope user <name> <url>/mcp
   ```

   **4b - Docker / no relay**. The MCP server must run on this machine from an Alfred checkout or install:
   - an Alfred source checkout here (a folder with `setup_mcp.py` and `mcp-server/`) → show and, on OK, run
     `python setup_mcp.py --alfred-url <url> --name <name> --no-skill` in it (add `--scope project --project-dir
     <folder>` for project scope);
   - a native install here → its server can reach the other Alfred the same way: `claude mcp add --scope user <name>
     -e ALFRED_URL=<url> -- <node> <install>/app/mcp/dist/mcp-server.mjs`, where `<node>` is
     `<install>/runtime/node/node.exe` on Windows or `<install>/runtime/node/bin/node` on Linux (ask for `<install>`, the
     folder `alfred` runs from, if unsure);
   - neither → say what is needed (clone Alfred, or install it) and stop.

5. **Check it**: `claude mcp list` shows `<name>` ✔ Connected. Not connected → the error line, and the likely cause
   (the address from this machine, a firewall, the instance's "Listen on").

6. **Tell the user**: start a **new** Claude Code session to get the tools (`mcp__<name>__…`); the `/alfred-*` skills
   use the instance named in the repo's `CLAUDE.md` (`Alfred: <name>`) or ask which when several are connected -
   offer to add that line to the current repo's `CLAUDE.md` if this instance is the one for this project.

## Never

Never send a secret or token anywhere; never edit `~/.claude.json` by hand (only through `claude mcp`); never
remove a server the user did not name.
