import { Injectable } from '@angular/core';
import { Subject } from 'rxjs';

/**
 * Fan-out for the payload-free `ws-messages-appended` push (see CallsWsMessage) - a call's own
 * WsMessagesComponent, if its panel is open, re-fetches when its id comes through here. Not
 * folded into CallsStateService/SessionCycleDetailStateService's own state: a WsMessagesComponent
 * is embedded from either context (or, for a captured call, neither pushes this event at all), so
 * a single app-root service is simpler than threading the event through every CallListControlsState
 * implementation.
 */
@Injectable({ providedIn: 'root' })
export class WsMessagesEventsService {
  private readonly appendedSubject = new Subject<string>();
  readonly appended$ = this.appendedSubject.asObservable();

  notifyAppended(callId: string): void {
    this.appendedSubject.next(callId);
  }
}
