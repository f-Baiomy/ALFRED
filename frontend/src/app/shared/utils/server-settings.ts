/**
 * Pure helpers of the Settings tab's Server section (specs/012-server-program): the form edits values in the units a
 * person reads (2 GB, one row per project), while .env stores one canonical spelling (bytes, name:listen:upstream).
 * The backend normalises and validates again on save - these only shape the form.
 */
import { FolderRow, ProjectRow, ServerSetting, SettingEdit, SettingGroup } from '../../core/models/server-settings.model';

export const GROUP_ORDER: SettingGroup[] = ['PROJECTS', 'NETWORK', 'STORAGE', 'LOGS', 'WILDFLY', 'UPDATES'];

export const GROUP_TITLES: Record<SettingGroup, string> = {
  PROJECTS: 'Inbound projects (reverse proxy)',
  NETWORK: 'Network',
  STORAGE: 'Storage limits',
  LOGS: 'Logs',
  WILDFLY: 'WildFly',
  UPDATES: 'Updates',
  SECRETS: 'Secrets',
};

const UNITS: [string, number][] = [['TB', 1024 ** 4], ['GB', 1024 ** 3], ['MB', 1024 ** 2], ['KB', 1024]];

/** 2147483648 -> "2 GB"; 1610612736 -> "1.5 GB". */
export function formatBytes(bytes: number | string | null | undefined): string {
  const n = typeof bytes === 'string' ? Number(bytes) : bytes ?? NaN;
  if (!Number.isFinite(n) || n < 0) {
    return '';
  }
  for (const [unit, size] of UNITS) {
    if (n >= size) {
      const value = n / size;
      return `${Number.isInteger(value) ? value : Number(value.toFixed(2))} ${unit}`;
    }
  }
  return `${n} B`;
}

/** "2 GB", "500MB", "1.5gb", "2147483648" -> bytes; null when it is not a size. */
export function parseSize(text: string): number | null {
  const match = /^\s*(\d+(?:\.\d+)?)\s*(B|KB|MB|GB|TB)?\s*$/i.exec(text ?? '');
  if (!match) {
    return null;
  }
  const unit = (match[2] ?? 'B').toUpperCase();
  const factor = unit === 'B' ? 1 : UNITS.find(([u]) => u === unit)![1];
  return Math.floor(Number(match[1]) * factor);
}

export function parseProjects(value: string | null): ProjectRow[] {
  return splitList(value).map(entry => {
    const parts = entry.split(':').map(p => p.trim());
    const outbound = parts.length >= 4 && parts[3] ? (parts.length === 5 && parts[4] ? `${parts[3]}:${parts[4]}` : parts[3]) : '';
    return { name: parts[0] ?? '', listenPort: parts[1] ?? '', upstreamPort: parts[2] ?? '', outbound };
  });
}

export function serializeProjects(rows: ProjectRow[]): string {
  return rows
    .filter(r => r.name.trim() || r.listenPort.trim() || r.upstreamPort.trim())
    .map(r => [r.name.trim(), r.listenPort.trim(), r.upstreamPort.trim()].join(':') + (r.outbound.trim() ? `:${r.outbound.trim()}` : ''))
    .join(',');
}

/** "name:path" split on the FIRST colon, so a Windows path (C:\logs) keeps its drive letter. */
export function parseFolders(value: string | null): FolderRow[] {
  return splitList(value).map(entry => {
    const colon = entry.indexOf(':');
    return colon < 0 ? { name: '', path: entry } : { name: entry.slice(0, colon).trim(), path: entry.slice(colon + 1).trim() };
  });
}

export function serializeFolders(rows: FolderRow[]): string {
  return rows.filter(r => r.name.trim() || r.path.trim()).map(r => `${r.name.trim()}:${r.path.trim()}`).join(',');
}

function splitList(value: string | null): string[] {
  return (value ?? '').split(',').map(s => s.trim()).filter(Boolean);
}

/** The text a field shows for a stored value. */
export function displayValue(setting: ServerSetting): string {
  if (setting.value === null) {
    return '';
  }
  return setting.kind === 'SIZE_BYTES' ? formatBytes(setting.value) : setting.value;
}

/** True when the form value means the same as the stored one (2 GB == 2147483648). */
export function sameValue(setting: ServerSetting, text: string): boolean {
  if (setting.kind === 'SIZE_BYTES') {
    const parsed = parseSize(text);
    return parsed !== null && String(parsed) === (setting.value ?? '');
  }
  if (setting.kind === 'BOOLEAN') {
    return text === (setting.value ?? '');
  }
  return text.trim() === (setting.value ?? '');
}

/**
 * The edits a save sends: fields whose value changed, and fields reset to their default. A reset wins over an edit
 * of the same key.
 */
export function buildEdits(settings: ServerSetting[], form: Record<string, string>, resets: Set<string>): SettingEdit[] {
  const edits: SettingEdit[] = [];
  for (const setting of settings) {
    if (resets.has(setting.key)) {
      edits.push({ key: setting.key, reset: true });
      continue;
    }
    const text = form[setting.key];
    if (text === undefined || setting.kind === 'SECRET') {
      continue;
    }
    if (!sameValue(setting, text)) {
      // Sizes go as typed: the backend turns "2 GB" into bytes, so .env keeps one spelling.
      edits.push({ key: setting.key, value: text.trim() });
    }
  }
  return edits;
}

/** Search by label, key or current value, and optionally only settings that differ from their default (FR-027). */
export function filterSettings(settings: ServerSetting[], query: string, changedOnly: boolean, form: Record<string, string> = {}): ServerSetting[] {
  const q = query.trim().toLowerCase();
  return settings.filter(s => {
    if (changedOnly && !s.differsFromDefault && (form[s.key] === undefined || sameValue(s, form[s.key]))) {
      return false;
    }
    if (!q) {
      return true;
    }
    const haystack = [s.label, s.key, s.help, form[s.key] ?? displayValue(s)].join(' ').toLowerCase();
    return haystack.includes(q);
  });
}

/** "How it applies" badge text. */
export function applyLabel(applies: string): string {
  switch (applies) {
    case 'LIVE':
      return 'applies live';
    case 'PROXIES':
      return 'restarts proxies';
    default:
      return 'restart needed';
  }
}

/** Server values merged under the user's unsaved edits (the conflict banner's "load server values, keep my edits"). */
export function keepEdits(serverForm: Record<string, string>, previousServer: Record<string, string>, current: Record<string, string>): Record<string, string> {
  const merged: Record<string, string> = { ...serverForm };
  for (const key of Object.keys(current)) {
    if (current[key] !== previousServer[key]) {
      merged[key] = current[key];
    }
  }
  return merged;
}

/** "≈ 3 h 54 min of traffic at the current rate (1 284 calls/hour). Uses about 140 MB of memory." */
export function retentionText(detail: Record<string, unknown>): string {
  const memory = Number(detail['memoryBytes'] ?? NaN);
  const perHour = Number(detail['callsPerHour'] ?? -1);
  const hours = Number(detail['retentionHours'] ?? NaN);
  const parts: string[] = [];
  if (Number.isFinite(hours) && perHour > 0) {
    const h = Math.floor(hours);
    const m = Math.round((hours - h) * 60);
    parts.push(`≈ ${h} h ${m} min of traffic at the current rate (${perHour.toLocaleString('en-US').replace(/,/g, ' ')} calls/hour).`);
  }
  if (Number.isFinite(memory)) {
    parts.push(`Uses about ${formatBytes(Math.round(memory / (1024 * 1024)) * 1024 * 1024)} of memory.`);
  }
  return parts.join(' ');
}

/** "1.6 GB used of 2 GB (80%)" for a size cap, from a check's detail; '' when the use is unknown. */
export function usageText(detail: Record<string, unknown>, capText: string): string {
  const used = Number(detail['usedBytes'] ?? -1);
  const cap = parseSize(capText);
  if (used < 0 || cap === null || cap === 0) {
    return '';
  }
  return `${formatBytes(used) || '0 B'} used of ${formatBytes(cap)} (${Math.round((used / cap) * 100)}%)`;
}
