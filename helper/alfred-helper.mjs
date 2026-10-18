#!/usr/bin/env node
// Alfred helper (specs/031, docs/server.md "Board sessions"): runs on the user's own PC - never on Alfred's server - and
// connects OUT to an Alfred (this machine, a LAN host like 192.168.1.80, Docker). It holds the user's key, takes the
// commands the user queues from Alfred's pages for THIS PC (start a board's Claude session, open it in Claude Desktop or
// a terminal, stop it, pick a folder), runs `claude` here in the user's repo folder with the user's own Claude account,
// and reports the sessions back. Alfred never reaches into the PC: it only queues; the helper maps each command kind to
// its own fixed action - never a command line from the server. No dependencies: Node 18+ only.
//
//   node alfred-helper.mjs connect --server <url> --token <t>   what Alfred's "Connect this PC" file runs: all of the
//                                       below at once - the browser paired, the skills and Alfred's MCP server installed
//   node alfred-helper.mjs install --server <url> --user <email> [--machine NAME] [--mcp NAME] [--autostart]
//   node alfred-helper.mjs pair    [--server url]        a six-digit code that pairs one browser with this helper
//   node alfred-helper.mjs run     [--server url]        the helper itself, in the foreground
//   node alfred-helper.mjs start | stop | status [--server url]
//   node alfred-helper.mjs url <alfred-helper://connect?server=...>   (the browser's "Start helper" link)
//   node alfred-helper.mjs token set | clear | status [--server url]   the Azure DevOps token, kept on this PC only
//   node alfred-helper.mjs uninstall [--server url]
//
// One writer per session (spike S2): a session that runs interactively in Claude Desktop or a terminal is never written
// to by the helper. Board answers come from the /alfred-live runner, which answers in forks of the session; the helper
// writes into the session itself only for its first turn and for a sync the user asks for while it is not open.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, hostname, platform } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const VERSION = '1.1.0';
const WINDOWS = platform() === 'win32';
const MAC = platform() === 'darwin';
const HEARTBEAT_MS = 30_000;
const CLAIM_WAIT_S = 50;

// --------------------------------------------------------------------------------------------------- config and files

export function configDir(env = process.env) {
  if (env.ALFRED_HELPER_HOME) return env.ALFRED_HELPER_HOME;
  if (WINDOWS) return join(env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'alfred-helper');
  return join(env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'alfred-helper');
}

const configFile = () => join(configDir(), 'config.json');

/** Where a "Connect this PC" file puts the helper (and Node): the helper updates itself only when it runs from here. */
export function appDir(env = process.env) {
  if (WINDOWS) return join(env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'alfred-helper', 'app');
  return join(configDir(env), 'app');
}

/** The first 16 hex of the SHA-256 of a text - how Alfred names the helper's and the skills' versions. */
export const shortHash = (text) => createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);

export function readConfig() {
  try {
    return JSON.parse(readFileSync(configFile(), 'utf8'));
  } catch {
    return { servers: {}, default: null };
  }
}

export function writeConfig(c) {
  mkdirSync(configDir(), { recursive: true });
  writeFileSync(configFile(), JSON.stringify(c, null, 2));
  if (!WINDOWS) chmodSync(configFile(), 0o600); // the key: this user only (Windows: the profile folder already is)
}

export function normalizeServer(url) {
  let u = String(url ?? '').trim();
  if (!u) return '';
  if (!/^https?:\/\//i.test(u)) u = `http://${u}`;
  return u.replace(/\/+$/, '');
}

/** The server entry to use: --server, else the default, else the only one. */
export function serverOf(config, wanted) {
  const name = normalizeServer(wanted) || config.default || Object.keys(config.servers ?? {})[0] || '';
  const entry = config.servers?.[name];
  if (!entry) throw new Error(name ? `No helper installed for ${name} - run: alfred helper install --server ${name} --user <email>`
    : 'No helper installed - run: alfred helper install --server <Alfred address> --user <email>');
  return { url: name, ...entry };
}

export const slug = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'board';

function log(line) {
  const text = `${new Date().toISOString()} ${line}`;
  process.stdout.write(`${text}\n`);
  try {
    mkdirSync(configDir(), { recursive: true });
    appendFileSync(join(configDir(), 'helper.log'), `${text}\n`);
  } catch { /* logging never stops the helper */ }
}

// ------------------------------------------------------------------------------------------------- Alfred over HTTP

export class AlfredApi {
  constructor(url, key) {
    this.url = url;
    this.key = key;
  }

  async call(method, path, { query, body, timeoutMs = 20_000 } = {}) {
    const u = new URL(this.url + path);
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== null) u.searchParams.set(k, String(v));
    const res = await fetch(u, {
      method, signal: AbortSignal.timeout(timeoutMs),
      headers: { Accept: 'application/json', ...(this.key ? { 'X-Alfred-Key': this.key } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (res.status === 204) return null;
    const text = await res.text();
    if (!res.ok) {
      let message = text;
      let code;
      try { const j = JSON.parse(text); message = j.message ?? text; code = j.error; } catch { /* plain text */ }
      const e = new Error(`${method} ${path} → ${res.status}: ${String(message).slice(0, 300)}`);
      e.status = res.status;
      e.code = code;
      throw e;
    }
    return text ? JSON.parse(text) : null;
  }
}

// --------------------------------------------------------------------------------------------- this PC: Claude, Desktop

/** The Claude account this PC's Claude Code is signed in with, from ~/.claude.json - never its credentials. */
export function claudeAccount(home = homedir()) {
  try {
    const j = JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8'));
    return j.oauthAccount?.emailAddress ?? '';
  } catch {
    return '';
  }
}

/** The Alfred MCP server Claude Code has for this Alfred: the entry of ~/.claude.json whose url (or ALFRED_URL) is it. */
export function mcpNameFor(serverUrl, home = homedir()) {
  try {
    const j = JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8'));
    const want = normalizeServer(serverUrl);
    for (const [name, e] of Object.entries(j.mcpServers ?? {})) {
      const url = normalizeServer(String(e.url ?? '').replace(/\/mcp\/?$/, '')) || normalizeServer(e.env?.ALFRED_URL ?? '');
      if (url && url === want) return name;
    }
  } catch { /* none */ }
  return null;
}

/**
 * The claude command to run here: on the PATH, else the one Claude Desktop carries (a Desktop-only PC). Null without
 * either - the connect file then says to install Claude Code.
 */
export function findClaude(env = process.env) {
  const onPath = spawnSync(WINDOWS ? 'where' : 'which', ['claude'], { encoding: 'utf8' });
  if (onPath.status === 0 && onPath.stdout.trim()) return 'claude';
  const root = WINDOWS ? join(env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'Claude', 'claude-code') : null;
  if (!root || !existsSync(root)) return null;
  let best = null;
  const walk = (dir, depth) => {
    for (const n of readdirSync(dir)) {
      const p = join(dir, n);
      let st;
      try { st = statSync(p); } catch { continue; }
      if (st.isDirectory() && depth < 3) walk(p, depth + 1);
      else if (/^claude\.exe$/i.test(n) && (!best || st.mtimeMs > best.t)) best = { p, t: st.mtimeMs };
    }
  };
  walk(root, 0);
  return best?.p ?? null;
}

/** The name a new Alfred MCP server gets: alfred-local-3000, alfred-lan-80, alfred-<host>. */
export function mcpDefaultName(serverUrl) {
  const u = new URL(normalizeServer(serverUrl));
  const port = u.port || (u.protocol === 'https:' ? '443' : '80');
  if (/^(localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname)) return `alfred-local-${port}`;
  const ip = u.hostname.match(/^\d+\.\d+\.\d+\.(\d+)$/);
  if (ip) return `alfred-lan-${ip[1]}${port === '3000' ? '' : `-${port}`}`;
  return `alfred-${slug(u.hostname)}`;
}

/**
 * Makes sure Claude Code has Alfred's MCP server, sending this user's key so their own sessions (Desktop, a terminal)
 * may write on the boards they hold. An existing HTTP entry without the key is added again with it; a local (stdio) one
 * is left as it is - the MCP server reads the key from this helper's config. Returns the server's name.
 */
export function ensureMcp(serverUrl, key, claude = 'claude', home = homedir(), run = (args) => {
  const r = claudeInvocation(claude, args);
  return spawnSync(r.command, r.args, { encoding: 'utf8', shell: r.shell, timeout: 60_000 });
}) {
  const url = `${normalizeServer(serverUrl)}/mcp`;
  let servers = {};
  try { servers = JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8')).mcpServers ?? {}; } catch { /* none yet */ }
  const add = (name) => {
    const r = run(['mcp', 'add', '--scope', 'user', '--transport', 'http', name, url, '--header', `X-Alfred-Key: ${key}`]);
    if (r.status !== 0) throw new Error(`claude mcp add failed: ${(r.stderr || r.stdout || '').trim().slice(0, 300)}`);
  };
  const name = mcpNameFor(serverUrl, home);
  if (name) {
    const e = servers[name] ?? {};
    const hasKey = Object.entries(e.headers ?? {}).some(([h, v]) => h.toLowerCase() === 'x-alfred-key' && v === key);
    if (!e.url || hasKey) return { name, changed: false };
    run(['mcp', 'remove', name, '--scope', 'user']);
    add(name);
    return { name, changed: true };
  }
  let fresh = mcpDefaultName(serverUrl);
  for (let i = 2; servers[fresh]; i++) fresh = `${mcpDefaultName(serverUrl)}-${i}`;
  add(fresh);
  return { name: fresh, changed: true };
}

const SKILL_MARKER = '.alfred-skill';
const RETIRED_SKILLS = ['alfred-qa'];

/**
 * Writes Alfred's /alfred-* skills ({version, files: {"alfred-live/SKILL.md": text}}) into ~/.claude/skills: an
 * Alfred-installed copy (it has the marker) is replaced, a folder of that name someone else wrote is never touched -
 * the same rule as alfred_skill.py. Returns one line per skill.
 */
export function installSkills(skills, root = join(homedir(), '.claude', 'skills')) {
  const byName = new Map();
  for (const [path, text] of Object.entries(skills?.files ?? {})) {
    const [name, ...rest] = String(path).split('/');
    if (!/^alfred-[a-z0-9-]+$/.test(name) || !rest.length || rest.some((p) => !p || p === '.' || p === '..' || /[\\:]/.test(p))) continue;
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name).push([rest, text]);
  }
  const lines = [];
  for (const [name, files] of byName) {
    const dest = join(root, name);
    if (existsSync(dest) && !existsSync(join(dest, SKILL_MARKER))) {
      lines.push(`skipped /${name}: a skill of that name exists and was not installed by Alfred`);
      continue;
    }
    rmSync(dest, { recursive: true, force: true });
    for (const [rel, text] of files) {
      const f = join(dest, ...rel);
      mkdirSync(dirname(f), { recursive: true });
      writeFileSync(f, text);
    }
    writeFileSync(join(dest, SKILL_MARKER), `alfred-${skills.version}\n`);
    lines.push(`installed /${name}`);
  }
  for (const old of RETIRED_SKILLS) {
    const dest = join(root, old);
    if (existsSync(join(dest, SKILL_MARKER))) {
      rmSync(dest, { recursive: true, force: true });
      lines.push(`removed the retired /${old}`);
    }
  }
  return lines;
}

export function desktopSessionsRoot(env = process.env) {
  if (WINDOWS) return join(env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'Claude', 'claude-code-sessions');
  if (MAC) return join(homedir(), 'Library', 'Application Support', 'Claude', 'claude-code-sessions');
  return null; // no Claude Desktop on Linux
}

/** The account/org folder of the signed-in Desktop account: the one holding the most recently written session record. */
export function desktopAccountDir(root = desktopSessionsRoot()) {
  if (!root || !existsSync(root)) return null;
  let best = null;
  for (const a of readdirSync(root)) {
    const ad = join(root, a);
    if (!statSync(ad).isDirectory()) continue;
    for (const o of readdirSync(ad)) {
      const od = join(ad, o);
      if (!statSync(od).isDirectory()) continue;
      for (const f of readdirSync(od)) {
        if (!/^local_.*\.json$/.test(f)) continue;
        const t = statSync(join(od, f)).mtimeMs;
        if (!best || t > best.t) best = { dir: od, t };
      }
    }
  }
  return best?.dir ?? null;
}

/**
 * Shows a Claude Code session in Claude Desktop (spike S1): the record the official `/desktop` command writes - the
 * Desktop id is `local_<cli id>`, adopted from another surface. Desktop reads new records when it starts, and runs a
 * session only in a folder the user trusted there. Returns the Desktop id, or null without Desktop.
 */
export function writeDesktopRecord({ cliSessionId, cwd, title, model }, dir = desktopAccountDir()) {
  if (!dir) return null;
  const id = `local_${cliSessionId}`;
  const file = join(dir, `${id}.json`);
  if (existsSync(file)) return id;
  const now = Date.now();
  writeFileSync(file, JSON.stringify({ sessionId: id, cliSessionId, cwd, originCwd: cwd, createdAt: now, lastActivityAt: now, lastFocusedAt: now,
    model: model || 'claude-opus-5-5', effort: 'medium', isArchived: false, title: title || 'Alfred board session', titleSource: 'user',
    permissionMode: 'default', adoptedFromOtherSurface: true, completedTurns: 1 }));
  return id;
}

/** The transcript of a Claude Code session on this PC, if it is here. */
export function transcriptOf(cliSessionId, home = homedir()) {
  const root = join(home, '.claude', 'projects');
  if (!existsSync(root)) return null;
  for (const d of readdirSync(root)) {
    const f = join(root, d, `${cliSessionId}.jsonl`);
    if (existsSync(f)) return f;
  }
  return null;
}

/** Tokens a transcript used today (UTC): input + output of every assistant turn written today. */
export function tokensToday(file, today = new Date().toISOString().slice(0, 10)) {
  if (!file || !existsSync(file)) return 0;
  let n = 0;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.includes('"usage"') || !line.includes(today)) continue;
    try {
      const j = JSON.parse(line);
      if (String(j.timestamp ?? '').startsWith(today)) {
        const u = j.message?.usage ?? {};
        n += (u.input_tokens ?? 0) + (u.output_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
      }
    } catch { /* a partial line */ }
  }
  return n;
}

/** The command lines of this PC's claude processes - read once per heartbeat. */
export function claudeProcessLines() {
  try {
    const out = WINDOWS
      ? execFileSync('powershell.exe', ['-NoProfile', '-Command',
        "Get-CimInstance Win32_Process -Filter \"Name like '%claude%' or Name like '%node%'\" | ForEach-Object { $_.CommandLine }"],
      { encoding: 'utf8', timeout: 20_000 })
      : execFileSync('ps', ['-eo', 'args'], { encoding: 'utf8', timeout: 5_000 });
    return out.split(/\r?\n/).filter((l) => /claude/i.test(l));
  } catch {
    return [];
  }
}

/** Is this session open interactively here right now (Desktop or a terminal)? A claude process naming it, not a -p run. */
export function openInteractively(cliSessionId, lines = claudeProcessLines()) {
  return lines.some((l) => l.includes(cliSessionId) && !/\s-p(\s|$)|--print/.test(l) && !/alfred-helper|alfred-live|alfred-listen/.test(l));
}

/** How to run claude here: an .exe directly; a .cmd/.ps1 shim (npm) through the shell with every argument quoted. */
export function claudeInvocation(claude, args) {
  if (!WINDOWS) return { command: claude, args, shell: false };
  const found = spawnSync('where', [claude], { encoding: 'utf8' });
  const first = found.status === 0 ? found.stdout.split(/\r?\n/).find((l) => l.trim()) : null;
  if (first && /\.exe$/i.test(first.trim())) return { command: first.trim(), args, shell: false };
  const quote = (a) => `"${String(a).replace(/"/g, '\\"')}"`;
  return { command: quote(first?.trim() || claude), args: args.map(quote), shell: true };
}

function openUrl(url) {
  if (WINDOWS) spawn('cmd.exe', ['/c', 'start', '""', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  else spawn(MAC ? 'open' : 'xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
}

/**
 * Restarts Claude Desktop so it reads the sessions Alfred added (it reads them only when it starts), then opens one.
 * Only Desktop's own window process is stopped - never a claude CLI (Desktop's bundled one included).
 */
async function restartDesktop(desktopId) {
  if (!WINDOWS) throw new Error('Restarting Claude Desktop from Alfred works on Windows - quit and reopen it yourself');
  spawnSync('powershell.exe', ['-NoProfile', '-Command',
    "Get-Process -Name Claude -ErrorAction SilentlyContinue | Where-Object { $_.Path -match '(\\\\app|AnthropicClaude)\\\\Claude\\.exe$' -and $_.Path -notmatch 'claude-code' } | Stop-Process -Force"],
  { encoding: 'utf8', timeout: 30_000 });
  await new Promise((r) => setTimeout(r, 3000));
  openUrl(desktopId ? `claude://claude.ai/epitaxy/${desktopId}` : 'claude://');
}

function openTerminal(cwd, cliSessionId, claude = 'claude') {
  const cmd = `${/\s/.test(claude) ? `"${claude}"` : claude} --resume ${cliSessionId}`;
  if (WINDOWS) {
    const wt = spawnSync('where', ['wt.exe'], { encoding: 'utf8' }).status === 0;
    if (wt) spawn('wt.exe', ['-d', cwd, 'cmd', '/k', cmd], { detached: true, stdio: 'ignore' }).unref();
    else spawn('cmd.exe', ['/c', 'start', 'cmd', '/k', `cd /d "${cwd}" && ${cmd}`], { detached: true, stdio: 'ignore' }).unref();
  } else if (MAC) {
    spawn('osascript', ['-e', `tell application "Terminal" to do script "cd '${cwd}' && ${cmd}"`], { detached: true, stdio: 'ignore' }).unref();
  } else {
    spawn('x-terminal-emulator', ['-e', `bash -lc "cd '${cwd}' && ${cmd}; exec bash"`], { detached: true, stdio: 'ignore' }).unref();
  }
}

function pickFolder() {
  if (WINDOWS) {
    const r = spawnSync('powershell.exe', ['-NoProfile', '-STA', '-Command',
      'Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.FolderBrowserDialog; '
      + '$d.Description = "Repo folder for Alfred board sessions"; if ($d.ShowDialog() -eq "OK") { $d.SelectedPath }'], { encoding: 'utf8', timeout: 600_000 });
    return r.stdout.trim() || null;
  }
  const r = MAC
    ? spawnSync('osascript', ['-e', 'POSIX path of (choose folder with prompt "Repo folder for Alfred board sessions")'], { encoding: 'utf8', timeout: 600_000 })
    : spawnSync('zenity', ['--file-selection', '--directory'], { encoding: 'utf8', timeout: 600_000 });
  return r.status === 0 ? r.stdout.trim().replace(/\/$/, '') || null : null;
}

/** A Windows toast, a macOS notification or notify-send - best effort, never a failure. */
export function notify(title, text) {
  try {
    if (WINDOWS) {
      const esc = (s) => String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]);
      const xml = `<toast><visual><binding template="ToastGeneric"><text>${esc(title)}</text><text>${esc(text)}</text></binding></visual></toast>`;
      spawn('powershell.exe', ['-NoProfile', '-Command',
        '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null; '
        + '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null; '
        + `$x = New-Object Windows.Data.Xml.Dom.XmlDocument; $x.LoadXml('${xml.replace(/'/g, "''")}'); `
        + '[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe").Show([Windows.UI.Notifications.ToastNotification]::new($x))'],
      { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    } else if (MAC) {
      spawn('osascript', ['-e', `display notification ${JSON.stringify(text)} with title ${JSON.stringify(title)}`], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('notify-send', [title, text], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch { /* no notifications here */ }
}

// ------------------------------------------------------------------------------------------- the Azure token (DPAPI)

const tokenFile = (server) => join(configDir(), `azure-token.${slug(server)}.bin`);

/** Encrypts for this Windows user (DPAPI); elsewhere a file only this user may read. */
export function protect(secret) {
  if (!WINDOWS) return Buffer.from(secret, 'utf8').toString('base64');
  const r = spawnSync('powershell.exe', ['-NoProfile', '-Command',
    'Add-Type -AssemblyName System.Security; $s = [Console]::In.ReadToEnd(); '
    + '[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($s), $null, "CurrentUser"))'],
  { input: secret, encoding: 'utf8', timeout: 30_000 });
  if (r.status !== 0) throw new Error('Could not encrypt the token for this Windows user');
  return r.stdout.trim();
}

export function unprotect(blob) {
  if (!WINDOWS) return Buffer.from(blob, 'base64').toString('utf8');
  const r = spawnSync('powershell.exe', ['-NoProfile', '-Command',
    'Add-Type -AssemblyName System.Security; $b = [Console]::In.ReadToEnd().Trim(); '
    + '[Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($b), $null, "CurrentUser"))'],
  { input: blob, encoding: 'utf8', timeout: 30_000 });
  if (r.status !== 0) throw new Error('Could not read the saved token');
  return r.stdout;
}

function readToken(server) {
  try {
    return unprotect(readFileSync(tokenFile(server), 'utf8'));
  } catch {
    return null;
  }
}

// -------------------------------------------------------------------------------------------------------- git worktree

/** The board's own folder: a git worktree of the repo under .alfred-worktrees/<slug>, so two boards never share files. */
export function boardWorktree(repo, name, run = (args) => spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' })) {
  const isGit = run(['rev-parse', '--is-inside-work-tree']).stdout?.trim() === 'true';
  if (!isGit) return { cwd: repo, worktree: false };
  const path = join(repo, '.alfred-worktrees', slug(name));
  if (existsSync(path)) return { cwd: path, worktree: true };
  const branch = `alfred/${slug(name)}`;
  const has = run(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).status === 0;
  const r = run(has ? ['worktree', 'add', path, branch] : ['worktree', 'add', '-b', branch, path]);
  if (r.status !== 0) throw new Error(`git worktree add failed: ${(r.stderr || r.stdout || '').trim().slice(0, 300)}`);
  // keep the worktrees out of the repo's own status, locally (never a committed .gitignore change)
  const exclude = run(['rev-parse', '--git-path', 'info/exclude']).stdout?.trim();
  if (exclude) {
    const file = resolve(repo, exclude);
    const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
    if (!text.split(/\r?\n/).includes('.alfred-worktrees/')) {
      mkdirSync(dirname(file), { recursive: true });
      appendFileSync(file, `${text.endsWith('\n') || !text ? '' : '\n'}.alfred-worktrees/\n`);
    }
  }
  return { cwd: path, worktree: true, branch };
}

// --------------------------------------------------------------------------------------------- settings from Alfred

/** This PC's folder for a project, from My settings: {projects: [{project, machine, folder, openIn}]}. */
export function projectFolder(settings, project, machine) {
  const rows = Array.isArray(settings?.projects) ? settings.projects : [];
  const mine = rows.find((r) => r.project === project && String(r.machine ?? '').toLowerCase() === machine.toLowerCase())
    ?? rows.find((r) => r.project === project && !r.machine);
  return mine ? { folder: mine.folder, openIn: mine.openIn ?? 'DESKTOP', worktrees: mine.worktrees !== false } : null;
}

/** The model for a kind of job, from My settings' models (chat, setup, fix ...). */
export const modelFor = (settings, job) => settings?.models?.[job] || settings?.models?.default || undefined;

// --------------------------------------------------------------------------------------------------------- the helper

export class Helper {
  constructor({ server, api, machine, mcp, skillsDir, claude = 'claude', primary, desktop, notify: toast }) {
    this.server = server;
    // the PC's first-connected Alfred: the one whose skills and helper version this PC follows (several Alfreds may be
    // connected at once, each with its own helper process - only one may rewrite the shared files)
    this.primary = primary ?? (readConfig().default ?? server) === server;
    this.api = api;
    this.machine = machine;
    this.mcp = mcp;
    this.skillsDir = skillsDir;
    this.claude = claude;
    this.sessions = new Map(); // cliSessionId → { boardId, project, cwd, title, runner: bool }
    // what reaches the user's screen - a folder dialog, Claude Desktop, a terminal, a toast; tests replace them all
    this.pickFolder = pickFolder;
    this.desktop = desktop ?? { record: writeDesktopRecord, open: openUrl, terminal: openTerminal, restart: restartDesktop };
    this.notify = toast ?? notify;
    this.stopped = false;
  }

  async settings() {
    try {
      return await this.api.call('GET', '/board/me/settings');
    } catch {
      return {};
    }
  }

  async heartbeat() {
    const info = { version: VERSION, claudeAccount: claudeAccount(), desktop: !!desktopAccountDir(), node: process.version,
      platform: platform(), mcp: this.mcp, azureToken: !!readToken(this.server),
      sessions: [...this.sessions.entries()].map(([id, s]) => ({ cliSessionId: id, boardId: s.boardId })) };
    const me = await this.api.call('PUT', '/board/helpers/heartbeat', { body: info });
    await this.keepCurrent(me?.versions).catch((e) => log(`could not update from Alfred: ${e.message}`));
    const settings = await this.settings();
    await this.requestsToToasts(me?.user, settings).catch(() => {});
    // the daily budget (My settings): over it, every session of this user on this PC stops answering until tomorrow or a raise
    const budget = Number(settings?.budget?.dailyTokens ?? 0);
    const used = [...this.sessions.keys()].reduce((n, id) => n + tokensToday(transcriptOf(id)), 0);
    if (budget > 0 && used >= budget) {
      for (const [id, s] of this.sessions) {
        if (!s.runner) continue;
        this.stopRunner(id);
        await this.report(id, { state: 'WAITING_BUDGET', tokensToday: tokensToday(transcriptOf(id)) }).catch(() => {});
        this.notify('Alfred', `Daily budget reached (${used.toLocaleString()} of ${budget.toLocaleString()} tokens) - ${s.title ?? s.boardId} waits`);
      }
    }
    // where each of our sessions runs now: open in Desktop/a terminal means that session answers itself
    const lines = this.sessions.size ? claudeProcessLines() : [];
    for (const [id, s] of this.sessions) {
      const open = openInteractively(id, lines);
      const tokens = tokensToday(transcriptOf(id));
      if (open !== s.open || tokens !== s.tokens) {
        s.open = open;
        s.tokens = tokens;
        await this.report(id, { openIn: open ? (s.openIn === 'TERMINAL' ? 'TERMINAL' : 'DESKTOP') : 'NONE', tokensToday: tokens }).catch(() => {});
      }
    }
  }

  /**
   * Alfred says what the helper and the skills are now (content hashes); when they changed, this PC takes them: the
   * skills into ~/.claude/skills (only for the PC's default Alfred, so two Alfreds never fight over them), and the
   * helper replaces its own file and restarts - only the copy a Connect file installed, never a source checkout's.
   */
  async keepCurrent(versions) {
    if (!versions) return;
    const config = readConfig();
    const entry = config.servers?.[this.server];
    if (versions.skills && entry && this.primary && entry.skills !== versions.skills) {
      const skills = await this.api.call('GET', '/board/connect/skills', { timeoutMs: 60_000 });
      for (const line of installSkills(skills)) log(`skills: ${line}`);
      entry.skills = skills.version;
      writeConfig(config);
    }
    const self = fileURLToPath(import.meta.url);
    // only the primary Alfred's helper replaces the shared file - two Alfreds at different versions would otherwise swap
    // it back and forth on every heartbeat
    if (!versions.helper || !this.primary || this.busy || !resolve(self).startsWith(resolve(appDir()))) return;
    if (shortHash(readFileSync(self, 'utf8')) === versions.helper) return;
    const res = await fetch(`${this.server}/board/connect/alfred-helper.mjs`, { signal: AbortSignal.timeout(60_000) });
    const text = res.ok ? await res.text() : '';
    if (shortHash(text) !== versions.helper) return; // changed again meanwhile: the next heartbeat takes it
    writeFileSync(self, text);
    log('helper updated from Alfred - restarting');
    spawn(process.execPath, [self, 'run', '--server', this.server], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    this.stopped = true;
    setTimeout(() => process.exit(0), 200);
  }

  /** A toast once per new request for a board this user holds (My settings ▸ Tell me ▸ board requests). */
  async requestsToToasts(user, settings) {
    if (!user || settings?.notify?.requests === false) return;
    this.seenRequests = this.seenRequests ?? new Set();
    const holders = await this.api.call('GET', '/board/holders', { query: { project: '' } });
    for (const h of holders ?? []) {
      if (h.user !== user || !h.request) continue;
      const key = `${h.boardId}|${h.request.user}|${h.request.at}`;
      if (this.seenRequests.has(key)) continue;
      this.seenRequests.add(key);
      this.notify('Alfred', `${h.request.user} asks for board ${h.boardId}${h.request.note ? `: ${h.request.note}` : ''}`);
    }
  }

  report(cliSessionId, fields) {
    const s = this.sessions.get(cliSessionId) ?? {};
    return this.api.call('PUT', '/board/sessions', { body: { boardId: s.boardId, project: s.project, cliSessionId, cwd: s.cwd, title: s.title, ...fields } });
  }

  /** A skill's runner script: the user's installed skills first (what their Claude Code runs), else Alfred's own copy. */
  skillScript(skill, file) {
    const candidates = [join(homedir(), '.claude', 'skills', skill, file), this.skillsDir && join(this.skillsDir, skill, file)];
    return candidates.find((p) => p && existsSync(p)) ?? null;
  }

  liveRunner() {
    return this.skillScript('alfred-live', 'alfred-live.mjs');
  }

  /** Starts the /alfred-live runner for the board, answering in forks of this session with the user's key. */
  startRunner(cliSessionId) {
    const s = this.sessions.get(cliSessionId);
    const runner = this.liveRunner();
    if (!runner || !this.mcp) return 'the board is not answered yet: ' + (!runner ? 'install the Alfred skills (alfred skill install)' : `register Alfred's MCP server (claude mcp add ... ${this.server}/mcp)`);
    const args = [runner, 'start', '--server', this.mcp, '--project', s.project, '--chat', cliSessionId, '--cwd', s.cwd];
    if (s.boardId && !s.boardId.startsWith('default:')) args.push('--cycle', s.boardId);
    if (s.model) args.push('--model', s.model);
    const r = spawnSync(process.execPath, args, { cwd: s.cwd, encoding: 'utf8', timeout: 60_000, env: { ...process.env, ...this.env(cliSessionId) } });
    s.runner = r.status === 0;
    return r.status === 0 ? null : `the runner did not start: ${(r.stderr || r.stdout || '').trim().slice(0, 300)}`;
  }

  stopRunner(cliSessionId) {
    const s = this.sessions.get(cliSessionId);
    const runner = this.liveRunner();
    if (!runner || !this.mcp || !s) return;
    spawnSync(process.execPath, [runner, 'stop', '--server', this.mcp, '--project', s.project], { cwd: s.cwd, encoding: 'utf8', timeout: 60_000,
      env: { ...process.env, ...this.env(cliSessionId) } });
    s.runner = false;
  }

  env(cliSessionId) {
    return { ALFRED_KEY: this.api.key, ALFRED_VIA: cliSessionId, ALFRED_URL: this.server };
  }

  /** One headless turn in the session - only while it is not open anywhere (one writer, spike S2). */
  turn(cliSessionId, prompt, { create = false, model, cwd, readOnly = true } = {}) {
    if (!create && openInteractively(cliSessionId)) throw new Error('The session is open in Claude Desktop or a terminal - it answers there; nothing was written into it');
    const args = ['-p', create ? '--session-id' : '--resume', cliSessionId];
    if (model) args.push('--model', model);
    if (readOnly) args.push('--allowedTools', 'mcp__*', 'Read', 'Grep', 'Glob');
    args.push(prompt);
    const run = claudeInvocation(this.claude, args);
    const r = spawnSync(run.command, run.args, { cwd, encoding: 'utf8', timeout: 15 * 60_000, env: { ...process.env, ...this.env(cliSessionId) }, shell: run.shell });
    if (r.status !== 0) throw new Error(`claude exited ${r.status}: ${(r.stderr || r.stdout || '').trim().slice(0, 300)}`);
    return r.stdout.trim();
  }

  async handle(c) {
    const args = (() => { try { return JSON.parse(c.args || '{}'); } catch { return {}; } })();
    switch (c.kind) {
      case 'START':
      case 'CONTINUE_FROM_COPY':
        return this.start(c, args);
      case 'RESUME':
      case 'ATTACH':
        return this.resume(c, args);
      case 'OPEN_DESKTOP': {
        const s = await this.known(c, args);
        const id = this.desktop.record({ cliSessionId: s.cliSessionId, cwd: s.cwd, title: s.title, model: s.model });
        if (!id) return 'Claude Desktop is not on this PC - open it in a terminal instead';
        this.desktop.open(`claude://claude.ai/epitaxy/${id}`);
        this.track(s).openIn = 'DESKTOP';
        await this.report(s.cliSessionId, { desktopId: id });
        return `Opened in Claude Desktop. If it is not in the sidebar, restart Claude Desktop once; the first time, Desktop asks you to trust ${s.cwd}.`;
      }
      case 'OPEN_TERMINAL': {
        const s = await this.known(c, args);
        this.desktop.terminal(s.cwd, s.cliSessionId, this.claude);
        this.track(s).openIn = 'TERMINAL';
        return `Opened a terminal: claude --resume ${s.cliSessionId}`;
      }
      case 'STOP': {
        const s = await this.known(c, args);
        this.track(s);
        this.stopRunner(s.cliSessionId);
        await this.report(s.cliSessionId, { state: 'STOPPED' });
        return 'Stopped answering. The session is kept - ▶ resumes it.';
      }
      case 'STOP_ALL': {
        const ids = [...this.sessions.keys()];
        for (const id of ids) {
          this.stopRunner(id);
          await this.report(id, { state: 'STOPPED' }).catch(() => {});
        }
        return `Stopped ${ids.length} session(s) on ${this.machine}. Sessions are kept; boards stay yours.`;
      }
      case 'RESTART_DESKTOP': {
        const s = c.sessionId || args.cliSessionId ? await this.known(c, args).catch(() => null) : null;
        await this.desktop.restart(s ? `local_${s.cliSessionId}` : null);
        return 'Claude Desktop restarted - every session Alfred added is in its sidebar now.';
      }
      case 'PICK_FOLDER': {
        const folder = pickFolder();
        if (!folder) throw new Error('No folder picked');
        return folder;
      }
      case 'SYNC': {
        const s = await this.known(c, args);
        this.track(s);
        const settings = await this.settings();
        this.turn(s.cliSessionId, `/alfred-resume ${args.boardRef ?? s.boardId}`, { cwd: s.cwd, model: modelFor(settings, 'chat') });
        await this.report(s.cliSessionId, { state: 'IDLE', lastChatSeq: args.chatSeq ?? null });
        return 'Synced: the session read what changed on the board since it last saw it.';
      }
      case 'LISTEN': {
        // /alfred-listen as a background lane of the board's session, on this PC: it judges in forks, never in the session
        const s = await this.known(c, args);
        this.track(s);
        if (!args.cycleId) throw new Error('Which cycle should Claude listen to?');
        const listen = this.skillScript('alfred-listen', 'alfred-listen.mjs');
        if (!listen || !this.mcp) throw new Error('Install the Alfred skills and register Alfred\'s MCP server on this PC first');
        const settings = await this.settings();
        const r = spawnSync(process.execPath, [listen, 'start', '--server', this.mcp, '--project', s.project, '--cycle', args.cycleId, '--cwd', s.cwd,
          ...(modelFor(settings, 'chat') ? ['--model', modelFor(settings, 'chat')] : [])],
        { cwd: s.cwd, encoding: 'utf8', timeout: 60_000, env: { ...process.env, ...this.env(s.cliSessionId) } });
        if (r.status !== 0) throw new Error(`listen did not start: ${(r.stderr || r.stdout || '').trim().slice(0, 300)}`);
        this.sessions.get(s.cliSessionId).listening = args.cycleId;
        return `Listening to cycle ${args.cycleName ?? args.cycleId} on ${this.machine}. Findings land on the board.`;
      }
      case 'STOP_LISTEN': {
        const s = await this.known(c, args);
        const listen = this.skillScript('alfred-listen', 'alfred-listen.mjs');
        const cycle = args.cycleId ?? this.sessions.get(s.cliSessionId)?.listening;
        if (listen && this.mcp && cycle) {
          spawnSync(process.execPath, [listen, 'stop', '--server', this.mcp, '--cycle', cycle], { cwd: s.cwd, encoding: 'utf8', timeout: 60_000,
            env: { ...process.env, ...this.env(s.cliSessionId) } });
        }
        if (this.sessions.get(s.cliSessionId)) this.sessions.get(s.cliSessionId).listening = null;
        return 'Stopped listening.';
      }
      case 'HANDOVER': {
        // the leaving session writes where things stand, then the board goes to the requester and this session stops
        const s = await this.known(c, args);
        this.track(s);
        let wrote = 'no handover note (the session is open in Desktop or a terminal - write it there)';
        if (!openInteractively(s.cliSessionId)) {
          const settings = await this.settings();
          this.turn(s.cliSessionId, `You are handing this board (${args.boardRef ?? s.boardId}) over to ${args.to ?? 'another user'}. `
            + 'Write a handover note for the next session: the stage, what is done and verified, what is fixed but not re-tested, what is open and '
            + 'why, and the one next step. Add it with board_add as ONE note card titled "Handover note" (kind NOTE), with the cards it is about as '
            + 'mentions. Then stop.', { cwd: s.cwd, model: modelFor(settings, 'setup'), readOnly: false });
          wrote = 'handover note written on the board';
        }
        await this.api.call('POST', '/board/holders/answer', { body: { boardId: s.boardId, answer: 'HAND_OVER' } });
        this.stopRunner(s.cliSessionId);
        await this.report(s.cliSessionId, { state: 'STOPPED' });
        return `Handed over - ${wrote}. Their ▶ alfred-live starts with /alfred-resume, which reads it.`;
      }
      case 'SEND_TRANSCRIPT':
      case 'BRING_TRANSCRIPT':
        throw new Error('Moving a transcript between PCs is not built - use "Continue here from Alfred\'s copy"');
      default:
        throw new Error(`Unknown command ${c.kind}`);
    }
  }

  track(s) {
    const t = this.sessions.get(s.cliSessionId) ?? {};
    const merged = { ...t, boardId: s.boardId, project: s.project, cwd: s.cwd, title: s.title, model: s.model ?? t.model };
    this.sessions.set(s.cliSessionId, merged);
    return merged;
  }

  /** The session a command names, as Alfred has it, checked to be on this PC. */
  async known(c, args) {
    const list = await this.api.call('GET', '/board/sessions', { query: { boardId: c.boardId ?? '' } });
    const s = list.find((x) => x.id === c.sessionId || x.cliSessionId === (args.cliSessionId ?? c.sessionId))
      ?? list.find((x) => x.current) ?? null;
    if (!s) throw new Error('No session for this board yet - press ▶ alfred-live');
    if (!transcriptOf(s.cliSessionId)) {
      const e = new Error(`NOT_HERE: session ${s.cliSessionId.slice(0, 8)} is not on ${this.machine}${s.machine ? ` (it was on ${s.machine})` : ''}`);
      e.notHere = true;
      throw e;
    }
    return s;
  }

  /** The first ▶ for a project on this PC: the folder picker opens here, and the answer is kept in My settings. */
  async askFolder(project, settings) {
    this.notify('Alfred', `Pick the repo folder for ${project} on ${this.machine}`);
    const folder = this.pickFolder();
    if (!folder) throw new Error(`NO_FOLDER: no repo folder for ${project} on ${this.machine} - pick one, or set it in 👤 Me`);
    const projects = [...(settings?.projects ?? []), { project, machine: this.machine, folder, openIn: 'DESKTOP', worktrees: true }];
    await this.api.call('PUT', '/board/me/settings', { body: { ...(settings ?? {}), projects } });
    return { folder, openIn: 'DESKTOP', worktrees: true };
  }

  async start(c, args) {
    const settings = await this.settings();
    const max = Number(settings?.maxSessions ?? 4);
    if ([...this.sessions.values()].filter((s) => s.runner).length >= max) throw new Error(`${max} sessions already run on ${this.machine} (My settings ▸ Max at once)`);
    let where = args.folder ? { folder: args.folder, openIn: args.openIn ?? 'DESKTOP', worktrees: args.worktrees !== false }
      : projectFolder(settings, c.project, this.machine);
    if (!where?.folder) where = await this.askFolder(c.project, settings);
    if (!existsSync(where.folder)) throw new Error(`NO_FOLDER: ${where.folder} does not exist on ${this.machine}`);
    const title = args.title || c.boardId;
    const isProject = String(c.boardId ?? '').startsWith('default:');
    // a board of another Alfred gets its own worktree even when its name matches one of the primary Alfred's boards
    const tag = this.primary ? '' : `${mcpDefaultName(this.server).replace(/^alfred-/, '')} `;
    const place = where.worktrees && !isProject ? boardWorktree(where.folder, tag + (args.worktreeName || title)) : { cwd: where.folder };
    const cliSessionId = randomUUID();
    // the first turn reads the whole task (the setup model); the board's answers afterwards are chat work (the chat model)
    const model = modelFor(settings, isProject ? 'chat' : 'setup');
    const s = { boardId: c.boardId, project: c.project, cwd: place.cwd, title, model: modelFor(settings, 'chat'), openIn: where.openIn };
    this.sessions.set(cliSessionId, s);
    await this.report(cliSessionId, { state: 'STARTING', openIn: 'NONE', makeCurrent: true });
    await this.api.call('POST', '/board/holders/take', { body: { boardId: c.boardId, project: c.project, sessionId: cliSessionId } });
    const first = args.firstPrompt || (isProject ? `You are the Alfred project chat session for ${c.project}. Read the project with task_context and wait.`
      : `/alfred-resume ${args.boardRef || c.boardId}`);
    this.turn(cliSessionId, first, { create: true, cwd: place.cwd, model });
    const problem = this.startRunner(cliSessionId);
    let desktopId = null;
    if (where.openIn === 'DESKTOP' || where.openIn === 'BOTH') {
      desktopId = this.desktop.record({ cliSessionId, cwd: place.cwd, title, model });
      if (desktopId) this.desktop.open(`claude://claude.ai/epitaxy/${desktopId}`);
    }
    if (where.openIn === 'TERMINAL' || where.openIn === 'BOTH') this.desktop.terminal(place.cwd, cliSessionId);
    await this.report(cliSessionId, { state: problem ? 'IDLE' : 'ANSWERING', desktopId, tokensToday: tokensToday(transcriptOf(cliSessionId)) });
    // ▶ on a board with no session: the run the user pressed follows, queued for the session that now answers the board
    if (!problem && args.thenRun?.command && !isProject) {
      await this.api.call('POST', '/board/skill-runs', { body: { project: c.project, cycleId: c.boardId, cardNumber: args.thenRun.cardNumber ?? null,
        command: args.thenRun.command, prompt: args.thenRun.prompt ?? args.thenRun.command } }).catch((e) => log(`the run did not queue: ${e.message}`));
    }
    this.notify('Alfred', `Session for ${title} is ready${desktopId ? ' - in Claude Desktop' : ''}`);
    return [`Started ${cliSessionId} in ${place.cwd}${place.branch ? ` (branch ${place.branch})` : ''}.`,
      desktopId ? 'Shown in Claude Desktop - restart Desktop once if it is not in the sidebar; Desktop asks you to trust the folder the first time.' : null,
      problem].filter(Boolean).join(' ');
  }

  async resume(c, args) {
    const cli = args.cliSessionId;
    let s;
    if (c.kind === 'ATTACH' && cli) {
      const file = transcriptOf(cli);
      if (!file) throw new Error(`NOT_HERE: no Claude session ${cli} on ${this.machine}`);
      s = { cliSessionId: cli, boardId: c.boardId, project: c.project, cwd: args.cwd || this.cwdOf(file), title: args.title || c.boardId };
      this.track(s);
      await this.report(cli, { state: 'IDLE', openIn: 'NONE', makeCurrent: true });
    } else {
      s = await this.known(c, args);
      this.track(s);
    }
    await this.api.call('POST', '/board/holders/take', { body: { boardId: s.boardId, project: s.project, sessionId: s.cliSessionId } });
    const problem = this.startRunner(s.cliSessionId);
    await this.report(s.cliSessionId, { state: problem ? 'IDLE' : 'ANSWERING', ...(args.makeCurrent ? { makeCurrent: true } : {}) });
    return problem ?? `Answering ${s.boardId} again with session ${s.cliSessionId.slice(0, 8)}.`;
  }

  /** A transcript's working folder (its first line that says). */
  cwdOf(file) {
    for (const line of readFileSync(file, 'utf8').split('\n').slice(0, 50)) {
      try {
        const j = JSON.parse(line);
        if (j.cwd) return j.cwd;
      } catch { /* keep looking */ }
    }
    return process.cwd();
  }

  async loop() {
    let beat = null;
    const tick = () => this.heartbeat().catch((e) => log(`heartbeat failed: ${e.message}`));
    await tick();
    beat = setInterval(tick, HEARTBEAT_MS);
    log(`helper ${VERSION} for ${this.server} as ${this.machine} - waiting for commands`);
    try {
      while (!this.stopped) {
        let commands = [];
        try {
          commands = await this.api.call('POST', '/board/helper-commands/claim', { body: { max: 5, waitSeconds: CLAIM_WAIT_S }, timeoutMs: (CLAIM_WAIT_S + 15) * 1000 });
        } catch (e) {
          log(`claim failed: ${e.message}`);
          if (e.status === 401) throw new Error('This helper\'s key was revoked - install it again');
          await new Promise((r) => setTimeout(r, 10_000));
          continue;
        }
        for (const c of commands ?? []) {
          log(`▶ ${c.kind} ${c.boardId ?? ''}`);
          this.busy = true;
          try {
            const result = await this.handle(c);
            await this.api.call('PUT', `/board/helper-commands/${c.id}`, { body: { state: 'DONE', result: String(result ?? '') } });
            log(`✓ ${c.kind}: ${result}`);
          } catch (e) {
            log(`✗ ${c.kind}: ${e.message}`);
            this.notify('Alfred', `${c.kind.toLowerCase().replace(/_/g, ' ')} failed: ${e.message}`);
            await this.api.call('PUT', `/board/helper-commands/${c.id}`, { body: { state: 'FAILED', result: e.message } }).catch(() => {});
          } finally {
            this.busy = false;
          }
        }
      }
    } finally {
      clearInterval(beat);
    }
  }
}

// ---------------------------------------------------------------------------------------------------- command line

export function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out[k] = 'true';
      else { out[k] = next; i++; }
    } else out._.push(a);
  }
  return out;
}

const pidFile = (server) => join(configDir(), `helper.${slug(server)}.pid`);

function runningPid(server) {
  try {
    const pid = Number(readFileSync(pidFile(server), 'utf8'));
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}

function startDetached(server) {
  if (runningPid(server)) return runningPid(server);
  mkdirSync(configDir(), { recursive: true });
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'run', '--server', server], { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  return child.pid;
}

/** Windows: the alfred-helper:// link and the start-with-Windows entry, for this user only (HKCU). */
function registerWindows(autostart) {
  const node = process.execPath;
  const script = fileURLToPath(import.meta.url);
  const reg = (args) => spawnSync('reg.exe', args, { encoding: 'utf8' });
  reg(['add', 'HKCU\\Software\\Classes\\alfred-helper', '/ve', '/d', 'URL:Alfred helper', '/f']);
  reg(['add', 'HKCU\\Software\\Classes\\alfred-helper', '/v', 'URL Protocol', '/d', '', '/f']);
  reg(['add', 'HKCU\\Software\\Classes\\alfred-helper\\shell\\open\\command', '/ve', '/d', `"${node}" "${script}" url "%1"`, '/f']);
  if (autostart) reg(['add', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', '/v', 'AlfredHelper', '/d', `"${node}" "${script}" start --all`, '/f']);
}

/**
 * What a "Connect this PC" file runs, once: who this is (the Claude account the PC is signed in with), a key for this PC
 * (the token also pairs the browser that downloaded the file), Alfred's MCP server and the skills, the alfred-helper://
 * link and start-with-Windows, then the helper itself in the background. Running it again replaces the key and keeps
 * the PC's browsers and sessions.
 */
async function connect(config, args) {
  const server = normalizeServer(args.server);
  if (!server || !args.token) throw new Error('This is run by the file Alfred gives you (Connect this PC) - download a new one');
  const claude = findClaude();
  if (!claude) throw new Error('Claude Code is not on this PC. Install it (https://claude.com/claude-code), sign in, then run this file again.');
  const user = args.user || claudeAccount();
  if (!user) throw new Error('Claude Code on this PC is not signed in. Run claude (or open Claude Desktop), sign in, then run this file again.');
  const machine = args.machine || hostname();
  console.log(`  you        ${user} (the Claude account signed in here)`);
  console.log(`  this PC    ${machine}`);
  const issued = await new AlfredApi(server, null).call('POST', '/board/helpers/register',
    { body: { user, machine, claudeAccount: claudeAccount(), connectToken: args.token } });
  config.servers = config.servers ?? {};
  const old = config.servers[server] ?? {};
  config.servers[server] = { ...old, keyId: issued.keyId, key: issued.key, user: issued.user, machine: issued.machine, claude };
  config.default = config.default && config.servers[config.default] ? config.default : server;
  writeConfig(config);
  console.log('  browser    paired - go back to Alfred');

  try {
    const mcp = ensureMcp(server, issued.key, claude);
    config.servers[server].mcp = mcp.name;
    console.log(`  MCP        ${mcp.name}${mcp.changed ? ' (added to Claude Code)' : ''}`);
  } catch (e) {
    console.log(`  MCP        not added: ${e.message}`);
  }
  try {
    const api = new AlfredApi(server, issued.key);
    const skills = await api.call('GET', '/board/connect/skills', { timeoutMs: 60_000 });
    const lines = installSkills(skills);
    if (config.default === server) config.servers[server].skills = skills.version;
    console.log(`  skills     ${lines.filter((l) => l.startsWith('installed')).length} /alfred-* skills in ${join(homedir(), '.claude', 'skills')}`);
    for (const l of lines.filter((x) => x.startsWith('skipped'))) console.log(`             ${l}`);
  } catch (e) {
    console.log(`  skills     not installed: ${e.message}`);
  }
  writeConfig(config);
  // ALFRED_HELPER_NO_REGISTER: an end-to-end test on a developer's PC leaves its registry alone
  if (WINDOWS && !process.env.ALFRED_HELPER_NO_REGISTER) registerWindows(true);

  const pid = runningPid(server);
  if (pid) {
    try { process.kill(pid); } catch { /* gone */ }
    try { unlinkSync(pidFile(server)); } catch { /* gone */ }
  }
  const started = startDetached(server);
  console.log(`  helper     running (pid ${started}), starts with Windows, updates itself from Alfred`);
}

async function main(argv) {
  const args = parseArgs(argv);
  const cmd = args._[0] ?? 'status';
  const config = readConfig();

  if (cmd === 'connect') {
    await connect(config, args);
    return;
  }

  if (cmd === 'install') {
    const server = normalizeServer(args.server);
    if (!server || !args.user) throw new Error('alfred helper install --server <Alfred address> --user <your email>');
    const machine = args.machine || hostname();
    const issued = await new AlfredApi(server, null).call('POST', '/board/helpers/register', { body: { user: args.user, machine, claudeAccount: claudeAccount() } });
    config.servers = config.servers ?? {};
    config.servers[server] = { keyId: issued.keyId, key: issued.key, user: issued.user, machine: issued.machine, mcp: args.mcp || mcpNameFor(server) };
    config.default = config.default ?? server;
    writeConfig(config);
    if (WINDOWS) registerWindows(args.autostart === 'true');
    const mcp = config.servers[server].mcp;
    console.log(`Installed for ${issued.user} on ${machine} → ${server}.`);
    console.log(mcp ? `Claude Code's MCP server for it: ${mcp}.` : `Register Alfred's MCP server first: claude mcp add --transport http alfred ${server}/mcp`);
    console.log('Next: alfred helper pair (pairs your browser), then alfred helper start.');
    return;
  }

  const entry = serverOf(config, args.server);
  const api = new AlfredApi(entry.url, entry.key);

  switch (cmd) {
    case 'pair': {
      const r = await api.call('POST', '/board/helpers/pair-code');
      console.log(`Pairing code: ${r.code.slice(0, 3)} ${r.code.slice(3)}  (valid until ${new Date(r.expiresAt).toLocaleTimeString()})`);
      console.log(`Enter it in Alfred (${entry.url}) ▸ My settings ▸ Pair this browser.`);
      return;
    }
    case 'run': {
      writeFileSync(pidFile(entry.url), String(process.pid));
      const helper = new Helper({ server: entry.url, api, machine: entry.machine, mcp: entry.mcp ?? mcpNameFor(entry.url), claude: entry.claude ?? 'claude',
        skillsDir: args.skills ?? join(dirname(dirname(fileURLToPath(import.meta.url))), 'skills') });
      const token = readToken(entry.url);
      if (token) await api.call('PUT', '/teamboards/me/token', { body: { token } }).catch((e) => log(`Azure token not handed over: ${e.message}`));
      const stop = () => { helper.stopped = true; try { unlinkSync(pidFile(entry.url)); } catch { /* gone */ } process.exit(0); };
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
      await helper.loop();
      return;
    }
    case 'start': {
      if (args.all === 'true') { // start with Windows: one helper per connected Alfred
        for (const server of Object.keys(config.servers ?? {})) console.log(`Helper running (pid ${startDetached(server)}) for ${server}.`);
        return;
      }
      const pid = startDetached(entry.url);
      console.log(`Helper running (pid ${pid}) for ${entry.url}. Log: ${join(configDir(), 'helper.log')}`);
      return;
    }
    case 'stop': {
      const pid = runningPid(entry.url);
      if (pid) process.kill(pid);
      try { unlinkSync(pidFile(entry.url)); } catch { /* gone */ }
      console.log(pid ? `Stopped helper ${pid}.` : 'The helper was not running.');
      return;
    }
    case 'status': {
      const me = await api.call('GET', '/board/me').catch((e) => ({ error: e.message }));
      console.log(JSON.stringify({ server: entry.url, user: entry.user, machine: entry.machine, mcp: entry.mcp ?? null, running: !!runningPid(entry.url),
        alfredSays: me, azureToken: !!readToken(entry.url) }, null, 2));
      return;
    }
    case 'url': {
      const u = new URL(args._[1] ?? '');
      const server = normalizeServer(u.searchParams.get('server') ?? entry.url);
      startDetached(config.servers?.[server] ? server : entry.url);
      return;
    }
    case 'token': {
      const sub = args._[1] ?? 'status';
      if (sub === 'set') {
        const secret = (args.value ?? readFileSync(0, 'utf8')).trim();
        if (!secret) throw new Error('Give the token on stdin: alfred helper token set < token.txt (it is never shown or logged)');
        writeFileSync(tokenFile(entry.url), protect(secret));
        await api.call('PUT', '/teamboards/me/token', { body: { token: secret } }).catch((e) => console.log(`Saved on this PC; Alfred will get it when reachable (${e.message})`));
        console.log('Azure DevOps token saved on this PC (encrypted for your Windows user) and handed to Alfred for your searches only.');
      } else if (sub === 'clear') {
        try { unlinkSync(tokenFile(entry.url)); } catch { /* none */ }
        await api.call('DELETE', '/teamboards/me/token').catch(() => {});
        console.log('Azure DevOps token removed from this PC and from Alfred.');
      } else {
        console.log(readToken(entry.url) ? 'An Azure DevOps token is saved on this PC.' : 'No Azure DevOps token on this PC.');
      }
      return;
    }
    case 'uninstall': {
      const pid = runningPid(entry.url);
      if (pid) process.kill(pid);
      delete config.servers[entry.url];
      if (config.default === entry.url) config.default = Object.keys(config.servers)[0] ?? null;
      writeConfig(config);
      try { unlinkSync(tokenFile(entry.url)); } catch { /* none */ }
      console.log(`Removed the helper for ${entry.url}. Revoke its key in Alfred ▸ My settings ▸ Devices if it was not done there.`);
      return;
    }
    default:
      throw new Error(`Unknown command ${cmd} - connect, install, pair, run, start, stop, status, url, token, uninstall`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(`alfred helper: ${e.message}`);
    process.exit(1);
  });
}

export { main, basename };
