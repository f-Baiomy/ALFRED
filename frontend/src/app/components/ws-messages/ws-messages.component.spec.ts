import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { AppConfigService } from '../../core/services/app-config.service';
import { WsMessagesEventsService } from '../../core/services/ws-messages-events.service';
import { WsMessagesComponent } from './ws-messages.component';

const BACKEND = 'http://backend.test:5000';

describe('WsMessagesComponent', () => {
  let fixture: ComponentFixture<WsMessagesComponent>;
  let component: WsMessagesComponent;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [WsMessagesComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: AppConfigService, useValue: { backendUrl: BACKEND } },
      ],
    });
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(WsMessagesComponent);
    component = fixture.componentInstance;
    fixture.componentRef.setInput('callId', 'c1');
  });

  afterEach(() => http.verify());

  it('loads messages on init and shows the dropped count', () => {
    fixture.detectChanges();

    http
      .expectOne(`${BACKEND}/calls/c1/ws-messages?offset=0&limit=200`)
      .flush({
        messages: [{ seq: 1, direction: 'client', tsMillis: 1000, type: 'text', content: 'hi' }],
        total: 1,
        dropped: 3,
      });

    expect(component.messages().length).toBe(1);
    expect(component.dropped()).toBe(3);
  });

  it('re-fetches from scratch when its own callId is pushed over ws-messages-appended', () => {
    fixture.detectChanges();
    http.expectOne(`${BACKEND}/calls/c1/ws-messages?offset=0&limit=200`).flush({
      messages: [{ seq: 1, direction: 'client', tsMillis: 1000, type: 'text', content: 'hi' }],
      total: 1,
      dropped: 0,
    });

    TestBed.inject(WsMessagesEventsService).notifyAppended('c1');

    http.expectOne(`${BACKEND}/calls/c1/ws-messages?offset=0&limit=200`).flush({
      messages: [
        { seq: 1, direction: 'client', tsMillis: 1000, type: 'text', content: 'hi' },
        { seq: 2, direction: 'server', tsMillis: 2000, type: 'text', content: 'there' },
      ],
      total: 2,
      dropped: 0,
    });

    expect(component.messages().length).toBe(2);
  });

  it('ignores a push for a different call', () => {
    fixture.detectChanges();
    http.expectOne(`${BACKEND}/calls/c1/ws-messages?offset=0&limit=200`).flush({ messages: [], total: 0, dropped: 0 });

    TestBed.inject(WsMessagesEventsService).notifyAppended('other-call');

    http.expectNone(`${BACKEND}/calls/c1/ws-messages?offset=0&limit=200`);
  });
});
