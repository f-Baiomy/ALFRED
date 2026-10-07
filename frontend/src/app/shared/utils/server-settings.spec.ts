import { ServerSetting } from '../../core/models/server-settings.model';
import {
  buildEdits,
  filterSettings,
  formatBytes,
  keepEdits,
  parseFolders,
  parseProjects,
  parseSize,
  sameValue,
  serializeFolders,
  serializeProjects,
} from './server-settings';

function setting(key: string, kind: ServerSetting['kind'], value: string | null, extra: Partial<ServerSetting> = {}): ServerSetting {
  return {
    key, kind, value, group: 'STORAGE', label: key, help: '', applies: 'LIVE', enumValues: [], min: null, max: null,
    isSet: value !== null, defaultValue: value, source: 'DEFAULT', differsFromDefault: false, pending: null, ...extra,
  };
}

describe('server-settings utils', () => {
  it('formats and parses sizes in binary units', () => {
    expect(formatBytes('2147483648')).toBe('2 GB');
    expect(formatBytes(1610612736)).toBe('1.5 GB');
    expect(formatBytes(524288000)).toBe('500 MB');
    expect(formatBytes(512)).toBe('512 B');
    expect(parseSize('2 GB')).toBe(2147483648);
    expect(parseSize('500mb')).toBe(524288000);
    expect(parseSize('10737418240')).toBe(10737418240);
    expect(parseSize('lots')).toBeNull();
  });

  it('round-trips projects, with and without an outbound address', () => {
    const value = 'a:9001:8080,b:9002:8081:127.0.0.3,c:9003:8082:127.0.0.4:8443';
    const rows = parseProjects(value);
    expect(rows[1]).toEqual({ name: 'b', listenPort: '9002', upstreamPort: '8081', outbound: '127.0.0.3' });
    expect(rows[2].outbound).toBe('127.0.0.4:8443');
    expect(serializeProjects(rows)).toBe(value);
    expect(serializeProjects([...rows, { name: '', listenPort: '', upstreamPort: '', outbound: '' }])).toBe(value);
  });

  it('splits folders on the first colon so Windows paths survive', () => {
    const rows = parseFolders('wildfly:/opt/wildfly/standalone/log,app:C:\\logs\\app');
    expect(rows).toEqual([{ name: 'wildfly', path: '/opt/wildfly/standalone/log' }, { name: 'app', path: 'C:\\logs\\app' }]);
    expect(serializeFolders(rows)).toBe('wildfly:/opt/wildfly/standalone/log,app:C:\\logs\\app');
  });

  it('treats 2 GB and its bytes as the same value', () => {
    const size = setting('ALFRED_CALLS_MAX_SIZE_BYTES', 'SIZE_BYTES', '2147483648');
    expect(sameValue(size, '2 GB')).toBeTrue();
    expect(sameValue(size, '3 GB')).toBeFalse();
  });

  it('builds edits only for changed fields, resets winning, secrets never sent', () => {
    const settings = [
      setting('ALFRED_CALLS_MAX_SIZE_BYTES', 'SIZE_BYTES', '2147483648'),
      setting('ALFRED_MEMORY', 'MEMORY', '2g'),
      setting('INTERNAL_CALLS_RETENTION_ROWS', 'INTEGER', '5000'),
      setting('WEBHOOK_SECRET', 'SECRET', null),
    ];
    const edits = buildEdits(settings,
      { ALFRED_CALLS_MAX_SIZE_BYTES: '2 GB', ALFRED_MEMORY: '3g ', INTERNAL_CALLS_RETENTION_ROWS: '8000', WEBHOOK_SECRET: 'x' },
      new Set(['INTERNAL_CALLS_RETENTION_ROWS']));
    expect(edits).toEqual([
      { key: 'ALFRED_MEMORY', value: '3g' },
      { key: 'INTERNAL_CALLS_RETENTION_ROWS', reset: true },
    ]);
  });

  it('filters by label, key or value, and by changed-from-default', () => {
    const settings = [
      setting('ALFRED_UI_PORT', 'PORT', '3000', { label: 'Web UI port' }),
      setting('ALFRED_MEMORY', 'MEMORY', '3g', { label: 'Memory', differsFromDefault: true }),
    ];
    expect(filterSettings(settings, 'port', false).map(s => s.key)).toEqual(['ALFRED_UI_PORT']);
    expect(filterSettings(settings, '3g', false).map(s => s.key)).toEqual(['ALFRED_MEMORY']);
    expect(filterSettings(settings, '', true).map(s => s.key)).toEqual(['ALFRED_MEMORY']);
    expect(filterSettings(settings, '', true, { ALFRED_UI_PORT: '3100' }).map(s => s.key)).toEqual(['ALFRED_UI_PORT', 'ALFRED_MEMORY']);
  });

  it('loads server values but keeps what the user edited', () => {
    const before = { A: '1', B: '2' };
    const mine = { A: '1', B: '5' };
    const server = { A: '9', B: '2' };
    expect(keepEdits(server, before, mine)).toEqual({ A: '9', B: '5' });
  });
});
