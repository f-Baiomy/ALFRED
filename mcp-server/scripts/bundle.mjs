// Bundles the MCP server for the native install (specs/012-server-program research R2/R13): src/ plus the
// frontend/src code it imports (export builders, redaction, analysis - shared on purpose so Claude and the UI never
// disagree) become one ES module. This package's own dependencies stay external and ship beside it from a production
// install (npm ci --omit=dev): jsdom in particular loads files at runtime that a bundler cannot follow. What the
// frontend sources import from the frontend's node_modules (a few @angular/core symbols) is bundled, so the frontend
// must have had `npm ci` first.
//
//   node scripts/bundle.mjs [outfile]      default: dist/mcp-server.mjs
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';

const outfile = process.argv[2] || 'dist/mcp-server.mjs';
const ownDependencies = Object.keys(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).dependencies);

await build({
  entryPoints: ['src/index.ts'],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external: ownDependencies.flatMap(name => [name, `${name}/*`]),
  sourcemap: false,
  legalComments: 'none',
  logLevel: 'info',
});
