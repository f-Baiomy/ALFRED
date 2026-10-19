import { Provider } from '@angular/core';
import { EMPTY, of, Subject } from 'rxjs';
import { LinksApiService } from './links-api.service';
import { LinksSocketService } from './links-socket.service';

/**
 * For specs of components that show other Alfreds' items (origin pills, Shared with me): the real LinksStateService
 * over an api that knows no other Alfred and a socket that never connects. Pass answers by method name to change that.
 */
export function provideLinksTesting(answers: Record<string, unknown> = {}): Provider[] {
  const api = new Proxy({}, {
    get: (_t, name: string) => () => of(name in answers ? answers[name] : name === 'self' ? null : []),
  });
  const socket = {
    events$: new Subject(),
    reconnected$: new Subject<void>(),
    signals: () => EMPTY,
    viewing: () => undefined,
    stop: () => undefined,
  };
  return [
    { provide: LinksApiService, useValue: api },
    { provide: LinksSocketService, useValue: socket },
  ];
}
