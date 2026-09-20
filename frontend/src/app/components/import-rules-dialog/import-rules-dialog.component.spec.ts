import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { InterceptionRule } from '../../core/models/interception.model';
import { AppConfigService } from '../../core/services/app-config.service';
import { buildRulesFile } from '../../shared/utils/interception-rules-file';
import { ImportRulesDialogComponent } from './import-rules-dialog.component';

const BACKEND = 'http://backend.test:5000';

function rule(overrides: Partial<InterceptionRule> = {}): InterceptionRule {
  return {
    id: 'r1',
    name: 'Slow Amadeus',
    enabled: true,
    priority: 100,
    stopProcessing: false,
    match: { source: 'outbound', host: 'api.amadeus.com' },
    actions: [{ type: 'DELAY_REQUEST', durationMs: 2000 }],
    ...overrides,
  } as InterceptionRule;
}

const PAUSER = rule({
  id: 'r2',
  name: 'Pause Sabre orders',
  match: { source: 'outbound', host: 'api.sabre.com' },
  actions: [{ type: 'PAUSE_REQUEST', timeoutSeconds: 30, onTimeout: 'release' }],
});

describe('ImportRulesDialogComponent', () => {
  let fixture: ComponentFixture<ImportRulesDialogComponent>;
  let component: ImportRulesDialogComponent;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [ImportRulesDialogComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: AppConfigService, useValue: { backendUrl: BACKEND } },
      ],
    });
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(ImportRulesDialogComponent);
    component = fixture.componentInstance;
  });

  /** Flushes the state service's own startup fetches, with `existing` as the current rule list. */
  function load(existing: InterceptionRule[] = []): void {
    fixture.detectChanges();
    http.expectOne(`${BACKEND}/interception/rules`).flush(existing);
    http.expectOne(`${BACKEND}/interception/paused`).flush([]);
    http.expectOne(`${BACKEND}/interception/enabled`).flush({ enabled: true });
    http.match(`${BACKEND}/interception/action-types`).forEach((r) => r.flush([]));
    fixture.detectChanges();
  }

  /** Drops a file on the dialog the way the browser would, and waits for FileReader. */
  async function drop(contents: string, name = 'rules.json'): Promise<void> {
    const file = new File([contents], name, { type: 'application/json' });
    const transfer = { files: [file] } as unknown as DataTransfer;
    component.onDrop({ preventDefault: () => undefined, dataTransfer: transfer } as DragEvent);
    // FileReader is async even for a string already in memory, and how many macrotasks it takes
    // is not something to guess at - wait for it to have actually produced something.
    for (let tick = 0; tick < 50 && !component.hasFile() && !component.parseError(); tick++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    fixture.detectChanges();
  }

  afterEach(() => {
    http.verify({ ignoreCancelled: true });
  });

  const text = () => (fixture.nativeElement as HTMLElement).textContent ?? '';

  it('creates nothing until Import is pressed', async () => {
    // Reading the file has to be free. A dialog that imported on drop would make "let me see
    // what is in this" indistinguishable from "run this".
    load();
    await drop(JSON.stringify(buildRulesFile([rule(), PAUSER])));

    expect(component.previews().length).toBe(2);
    http.expectNone(`${BACKEND}/interception/rules/import`);
  });

  it('shows what each rule matches and does before it exists', async () => {
    load();
    await drop(JSON.stringify(buildRulesFile([rule()])));

    expect(text()).toContain('Slow Amadeus');
    expect(text()).toContain('api.amadeus.com');
    // Rendered by the same describeAction the rule list uses, so the preview reads exactly the
    // way the row will once it exists.
    expect(text()).toContain('Delay request 2,000 ms');
  });

  it('calls out a rule that can hold a caller, above the list', async () => {
    // Finding this out by scrolling is finding it out too late: a pause stops a real request
    // belonging to somebody who is not you.
    load();
    await drop(JSON.stringify(buildRulesFile([rule(), PAUSER])));

    expect(component.pausingCount()).toBe(1);
    expect(fixture.nativeElement.querySelector('.import-warn')).not.toBeNull();
    expect(text()).toContain("hold a caller's connection open");
  });

  it('says nothing alarming about a file that only delays', async () => {
    load();
    await drop(JSON.stringify(buildRulesFile([rule()])));

    expect(fixture.nativeElement.querySelector('.import-warn')).toBeNull();
  });

  it('warns when a rule would be the second one with that name', async () => {
    load([rule({ id: 'existing' })]);
    await drop(JSON.stringify(buildRulesFile([rule()])));

    expect(component.clashCount()).toBe(1);
    expect(text()).toContain('adds a second one');
  });

  it('refuses a calls export instead of half-reading it', async () => {
    load();
    await drop(JSON.stringify({ events: [{ callId: 'c1' }] }), 'calls.json');

    expect(component.parseError()).toContain('calls export');
    expect(component.hasFile()).toBeFalse();
  });

  it('imports off by default, and says so afterwards', async () => {
    load();
    await drop(JSON.stringify(buildRulesFile([PAUSER])));

    component.runImport();

    const request = http.expectOne(`${BACKEND}/interception/rules/import`);
    expect(request.request.body.enable).toBeFalse();
    expect(request.request.body.rules.length).toBe(1);
    request.flush({ imported: 1, rejected: 0, results: [{ index: 0, name: 'Pause Sabre orders', status: 'imported' }] });
    http.expectOne(`${BACKEND}/interception/rules`).flush([]);
    fixture.detectChanges();

    expect(text()).toContain('all switched off');
  });

  it('sends the whole file in one request rather than one per rule', async () => {
    load();
    await drop(JSON.stringify(buildRulesFile([rule(), PAUSER, rule({ name: 'Third' })])));

    component.runImport();

    const requests = http.match(`${BACKEND}/interception/rules/import`);
    expect(requests.length).toBe(1);
    expect(requests[0].request.body.rules.length).toBe(3);
    requests[0].flush({ imported: 3, rejected: 0, results: [] });
    http.expectOne(`${BACKEND}/interception/rules`).flush([]);
  });

  it('asks for them on only when the box is ticked', async () => {
    load();
    await drop(JSON.stringify(buildRulesFile([rule()])));
    component.enableAfterImport.set(true);

    component.runImport();

    const request = http.expectOne(`${BACKEND}/interception/rules/import`);
    expect(request.request.body.enable).toBeTrue();
    request.flush({ imported: 1, rejected: 0, results: [] });
    http.expectOne(`${BACKEND}/interception/rules`).flush([]);
  });

  it('names every rejected rule and why, rather than a count', async () => {
    // A quiet partial import is the failure this avoids. The good rules still landed.
    load();
    await drop(JSON.stringify(buildRulesFile([rule(), PAUSER])));

    component.runImport();
    http.expectOne(`${BACKEND}/interception/rules/import`).flush({
      imported: 1,
      rejected: 1,
      results: [
        { index: 0, name: 'Slow Amadeus', status: 'imported', id: 'new-1' },
        { index: 1, name: 'Pause Sabre orders', status: 'rejected', problems: ['A pause needs a timeout.'] },
      ],
    });
    http.expectOne(`${BACKEND}/interception/rules`).flush([]);
    fixture.detectChanges();

    expect(text()).toContain('1 rule imported');
    expect(text()).toContain('Pause Sabre orders');
    expect(text()).toContain('A pause needs a timeout.');
  });

  it('previews a malformed rule instead of rendering nothing at all', async () => {
    // Found on live traffic. A rule with no `match` threw out of describeMatch inside the
    // previews computed, and the throw took the whole dialog's rendering with it: a blank panel
    // where the preview of the untrusted file should be. The backend rejects such a rule with a
    // proper message, and getting that far is the entire point of this screen.
    load();
    await drop(
      JSON.stringify({
        alfredInterceptionRules: 1,
        rules: [{ name: 'Broken', actions: [{ type: 'PAUSE_REQUEST' }] }, { nothing: true }],
      })
    );

    expect(component.parseError()).toBeNull();
    expect(component.previews().length).toBe(2);
    expect(text()).toContain('Broken');
    // Still rendering everything below the preview, which is what the throw used to destroy.
    expect(text()).toContain('Turn these on after importing');
  });

  it('lets a file be swapped for another one', async () => {
    load();
    await drop(JSON.stringify(buildRulesFile([rule()])));

    component.clearFile();
    fixture.detectChanges();

    expect(component.hasFile()).toBeFalse();
    expect(component.fileName()).toBeNull();
  });
});
