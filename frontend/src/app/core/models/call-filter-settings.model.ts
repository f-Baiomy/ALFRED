export type FilterMode = 'ACCEPT_ALL' | 'ACCEPT_ONLY';

export interface UrlRule {
  readonly id: string;
  readonly host: string;
  readonly enabled: boolean;
}

export interface CallFilterSettings {
  readonly mode: FilterMode;
  readonly whitelist: UrlRule[];
  readonly blacklist: UrlRule[];
}
