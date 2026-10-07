// npm run test:http - the whole test suite again, every tool call over the HTTP transport the native install uses
// (specs/012-server-program SC-008). The harness (test/harness.ts) switches on ALFRED_MCP_TRANSPORT.
import { spawnSync } from 'node:child_process';

const result = spawnSync('npx', ['tsx', '--test', '--test-timeout=60000', 'test/*.test.ts'], {
  stdio: 'inherit',
  shell: true,
  env: { ...process.env, ALFRED_MCP_TRANSPORT: 'http' },
});
process.exit(result.status ?? 1);
