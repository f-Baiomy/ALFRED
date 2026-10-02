// Keeps the Angular CLI disk cache (.angular/cache) from filling the disk (review P12).
//
// The cache makes rebuilds and test runs much faster, but it never deletes anything: each test
// run used to add a new webpack cache next to the old ones until the disk was full, so the cache
// had been switched off altogether. Run before `ng build`, `ng serve` and `ng test` (npm pre*
// scripts), this drops caches left by other Angular versions and empties the cache once it grows
// past NG_CACHE_MAX_MB (default 1024).
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const root = join(process.cwd(), '.angular', 'cache');
const limitBytes = Number(process.env.NG_CACHE_MAX_MB ?? 1024) * 1024 * 1024;

function sizeOf(path) {
  const stat = statSync(path, { throwIfNoEntry: false });
  if (!stat) return 0;
  if (!stat.isDirectory()) return stat.size;
  return readdirSync(path).reduce((total, name) => total + sizeOf(join(path, name)), 0);
}

function angularVersion() {
  try {
    return createRequire(import.meta.url)('@angular/core/package.json').version;
  } catch {
    return null;
  }
}

if (existsSync(root)) {
  const current = angularVersion();
  for (const entry of readdirSync(root)) {
    if (current && entry !== current) {
      rmSync(join(root, entry), { recursive: true, force: true });
    }
  }
  const size = sizeOf(root);
  if (size > limitBytes) {
    rmSync(root, { recursive: true, force: true });
    console.log(`Angular cache was ${Math.round(size / 1048576)} MB, over ${Math.round(limitBytes / 1048576)} MB: cleared.`);
  }
}
