// Guards the Team tab's connector boundary and the no-polling rule (specs/027, SC-008 / SC-009).
//
// Each tracker connector (Azure DevOps first, Jira and ClickUp later) lives in its own folder under
// src/app/components/team/connectors/<kind>/ and reaches the rest of the app only through the
// TEAM_CONNECTORS DI token. Nothing outside that folder may import from it, so adding or removing a
// connector never touches the Team tab's core. And no Team or board-rework list may refresh on a
// timer: lists refetch on a WebSocket "something changed" signal (CLAUDE.md "No polling anywhere").
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const app = join(process.cwd(), 'src', 'app');
const connectors = join(app, 'components', 'team', 'connectors');
/** Folders whose code must never poll. */
const noPolling = [
  join(app, 'components', 'team'),
  join(app, 'pages', 'team'),
  join(app, 'core', 'team'),
  join(app, 'components', 'board', 'board-picker'),
  join(app, 'components', 'board', 'related-strip'),
  join(app, 'components', 'board', 'cycle-verdicts-dialog'),
  join(app, 'components', 'board', 'record-dialog'),
  join(app, 'components', 'board', 'board-activity'),
];
const POLLING = /\b(setInterval\s*\(|interval\s*\(|timer\s*\(\s*[^,)]+,\s*[^)]+\))/;

function* files(dir) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      yield* files(path);
    } else if (path.endsWith('.ts') && !path.endsWith('.spec.ts')) {
      yield path;
    }
  }
}

const problems = [];
for (const file of files(app)) {
  if (file.startsWith(connectors + sep)) {
    continue;
  }
  const text = readFileSync(file, 'utf8');
  for (const m of text.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
    // the one registry, components/team/connectors/index.ts, is provided once in app.config.ts
    const registry = /\/components\/team\/connectors$/.test(m[1]) && file === join(app, 'app.config.ts');
    if (!registry && (m[1].includes('/team/connectors') || m[1].includes('connectors/azure'))) {
      problems.push(`${relative(process.cwd(), file)} imports a connector (${m[1]}); go through TEAM_CONNECTORS`);
    }
  }
}
for (const dir of noPolling) {
  for (const file of files(dir)) {
    const text = readFileSync(file, 'utf8');
    if (POLLING.test(text)) {
      problems.push(`${relative(process.cwd(), file)} polls (interval/setInterval/periodic timer); refetch on a WebSocket signal instead`);
    }
  }
}
if (problems.length) {
  console.error('check-team-boundaries:\n  ' + problems.join('\n  '));
  process.exit(1);
}
