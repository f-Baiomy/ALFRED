import { CallLogsApiService } from '../../core/services/call-logs-api.service';
import { CallFocusService } from '../../core/services/call-focus.service';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ApplicationRef } from '@angular/core';
import { of } from 'rxjs';
import { LogLineDataComponent } from './log-line-data.component';
import { LogsApiService } from '../../core/services/logs-api.service';
import { ProfilesApiService } from '../../core/services/profiles-api.service';
import { FieldDef, LogLine, LogStructure } from '../../core/models/logs.model';

const LONG = 'UnrecognizedPropertyException : Unrecognized field "error" (class com.ws.ErrorType), not marked as ignorable\n'
  + ' at [Source: (String)"{"error": "Blocked"}"; line: 1, column: 12]\n'
  + ' (through reference chain: com.ws.ErrorType["error"])\n'
  + 'and a fourth line';

function field(index: number, path: string): FieldDef {
  return {
    index, path, label: path, type: 'STRING', typeSource: 'AUTO', format: '', matchRate: 1, invalidCount: 0, suggestBoolean: false,
    searchMode: 'NONE', role: null, sensitive: false, duplicateOf: null, firstSeenLine: 0, sample: null, roleRank: 0,
  };
}

describe('LogLineDataComponent - long values', () => {
  let fixture: ComponentFixture<LogLineDataComponent>;

  function el(selector: string): HTMLElement | null {
    return fixture.nativeElement.querySelector(selector);
  }

  function links(): HTMLButtonElement[] {
    return Array.from(fixture.nativeElement.querySelectorAll('.lg-vmore .lg-link')) as HTMLButtonElement[];
  }

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [LogLineDataComponent],
      providers: [
        { provide: LogsApiService, useValue: {} },
        { provide: CallLogsApiService, useValue: { forLine: () => of(null) } },
        { provide: CallFocusService, useValue: {} },
        { provide: ProfilesApiService, useValue: { list: () => of([]) } },
      ],
    });
    fixture = TestBed.createComponent(LogLineDataComponent);
    const structure: LogStructure = {
      id: 's', fields: [field(0, 'level'), field(1, 'exception')], groupLevels: [], template: '', columns: [],
      defaultDataView: 'TABLE', timeZone: 'UTC', defaultFieldLayout: 'FLAT',
    };
    const line: LogLine = {
      lineId: 'l1', inputId: 'i', byteOffset: 0, ts: 0, level: 'ERROR', groupLevel: 0, groupPath: '', missingLevel: null,
      pinned: false, unparsed: false, shape: 1, fields: { level: 'ERROR', exception: LONG },
      raw: JSON.stringify({ level: 'ERROR', exception: LONG }), rawUnavailable: null,
    };
    fixture.componentRef.setInput('sourceId', 'src');
    fixture.componentRef.setInput('line', line);
    fixture.componentRef.setInput('structure', structure);
    fixture.detectChanges();
  });

  it('shows a long value folded to its first lines, its size, and Show all / Open - a short one as it is', () => {
    const clamped = fixture.nativeElement.querySelectorAll('.lg-vclamp');
    expect(clamped.length).toBe(1);
    // The text is the value exactly as stored - nothing reformatted, nothing cut.
    expect((clamped[0] as HTMLElement).textContent).toBe(LONG);
    expect(el('.lg-vsize')!.textContent).toContain(`${LONG.length} chars`);
    expect(links().map((b) => b.textContent!.trim())).toEqual(['Show all ▾', '⤢ Open']);
    expect(el('.lg-drawer')).toBeNull();
    expect(fixture.nativeElement.textContent).not.toContain('Open in drawer');
  });

  it('opens it in place and folds it back', () => {
    links()[0].click();
    fixture.detectChanges();
    expect(el('.lg-vclamp')).toBeNull();
    expect(links()[0].textContent!.trim()).toBe('Show less ▴');
    links()[0].click();
    fixture.detectChanges();
    expect(el('.lg-vclamp')).not.toBeNull();
  });

  it('opens it in its own window, line by line, with find', () => {
    links()[1].click();
    fixture.detectChanges();
    const lines = Array.from(fixture.nativeElement.querySelectorAll('.lg-vbody .lg-vline')) as HTMLElement[];
    expect(lines.length).toBe(4);
    expect(lines.map((l) => l.querySelector('span:last-child')!.textContent).join('\n')).toBe(LONG);

    fixture.componentInstance.openedFind.set('error');
    fixture.detectChanges();
    expect(fixture.componentInstance.openedHits()).toBe(5); // case-insensitive: the "Error" of ErrorType counts too
    expect(fixture.nativeElement.querySelectorAll('.lg-vbody mark').length).toBe(5);

    fixture.componentInstance.opened.set(null);
    fixture.detectChanges();
    expect(el('.lg-vbody')).toBeNull();
  });
});

describe('LogLineDataComponent - value window formats', () => {
  let fixture: ComponentFixture<LogLineDataComponent>;
  const BODY = JSON.stringify({ pnr: { supplier: 'TravelportNdc', pnr: 'BNB8NC', passengers: [{ first: 'RADWAN' }, { first: 'RANA' }] }, padding: 'x'.repeat(300) });
  const XML = '<soap:Envelope xmlns:soap="urn:s"><soap:Body><Ping Code="1G">' + 'y'.repeat(300) + '</Ping></soap:Body></soap:Envelope>';
  const CUT = '{"pnr":{"name":{"first":"' + 'R'.repeat(300);

  function open(value: string): void {
    fixture.componentInstance.openValue('message.context.returnValue', value);
    fixture.detectChanges();
  }

  function q(selector: string): HTMLElement | null {
    return fixture.nativeElement.querySelector(selector);
  }

  function button(text: string): HTMLButtonElement {
    return (Array.from(fixture.nativeElement.querySelectorAll('.lg-vwin button')) as HTMLButtonElement[]).find((b) => b.textContent!.trim() === text)!;
  }

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [LogLineDataComponent],
      providers: [
        { provide: LogsApiService, useValue: {} },
        { provide: CallLogsApiService, useValue: { forLine: () => of(null) } },
        { provide: CallFocusService, useValue: {} },
        { provide: ProfilesApiService, useValue: { list: () => of([]) } },
      ],
    });
    fixture = TestBed.createComponent(LogLineDataComponent);
    const structure: LogStructure = {
      id: 's', fields: [field(0, 'level')], groupLevels: [], template: '', columns: [], defaultDataView: 'TABLE', timeZone: 'UTC',
    };
    fixture.componentRef.setInput('sourceId', 'src');
    fixture.componentRef.setInput('line', {
      lineId: 'l1', inputId: 'i', byteOffset: 0, ts: 0, level: 'INFO', groupLevel: 0, groupPath: '', missingLevel: null,
      pinned: false, unparsed: false, shape: 1, fields: { level: 'INFO' }, raw: '{"level":"INFO"}', rawUnavailable: null,
    } as LogLine);
    fixture.componentRef.setInput('structure', structure);
    fixture.detectChanges();
  });

  it('recognises JSON as it opens - still showing it exactly as stored - and offers Format, Tree or Keep as is', () => {
    open(BODY);
    expect(q('.lg-vbar')!.textContent).toContain('✓ JSON');
    expect(q('.lg-vbar')!.textContent).toContain('object with 2 keys');
    expect(fixture.nativeElement.querySelectorAll('.lg-vbody .lg-vline').length).toBe(1); // the original, one line
    expect(q('.lg-vcheck')).toBeNull();

    button('Format').click();
    fixture.detectChanges();
    const lines = Array.from(fixture.nativeElement.querySelectorAll('.lg-vbody .lg-vline')) as HTMLElement[];
    expect(lines.length).toBe(JSON.stringify(JSON.parse(BODY), null, 2).split('\n').length);
    expect(q('.lg-vbar')).toBeNull(); // the offer is gone once a choice is made
    expect(fixture.nativeElement.querySelector('.lg-vbody .k')).not.toBeNull(); // coloured like call bodies

    button('Original').click(); // the "unformat"
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelectorAll('.lg-vbody .lg-vline').length).toBe(1);
  });

  it('shows JSON as a tree that expands and collapses as a whole', () => {
    open(BODY);
    button('Tree').click();
    fixture.detectChanges();
    const details = () => Array.from(fixture.nativeElement.querySelectorAll('.lg-vbody details')) as HTMLDetailsElement[];
    expect(details().length).toBeGreaterThan(2);
    button('Collapse all').click();
    expect(details().slice(1).every((d) => !d.open)).toBeTrue();
    expect(details()[0].open).toBeTrue();
    button('Expand all').click();
    expect(details().every((d) => d.open)).toBeTrue();
  });

  it('recognises XML, formats it and shows its elements as a tree with @attributes', () => {
    open(XML);
    expect(q('.lg-vbar')!.textContent).toContain('✓ XML');
    button('Format').click();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelectorAll('.lg-vbody .lg-vline').length).toBeGreaterThan(3);
    button('Tree').click();
    fixture.detectChanges();
    expect(q('.lg-vbody')!.textContent).toContain('@Code');
    expect(q('.lg-vbody')!.textContent).toContain('<Ping>');
  });

  it('goes to each match in turn - in the formatted view and inside collapsed tree nodes', () => {
    open(BODY);
    const render = () => {
      fixture.detectChanges();
      TestBed.inject(ApplicationRef).tick(); // the afterNextRender that counts the matches and jumps
    };
    button('Format').click();
    render();
    fixture.componentInstance.setOpenedFind('first');
    render();
    const c = fixture.componentInstance;
    expect(c.openedTotal()).toBe(2);
    expect(c.openedCur()).toBe(0);
    expect(fixture.nativeElement.querySelectorAll('.lg-vbody mark.lg-cur').length).toBe(1);
    fixture.detectChanges();
    expect(q('.lg-vcount')!.textContent!.trim()).toBe('1 of 2');
    c.stepMatch(1);
    expect(c.openedCur()).toBe(1);
    c.stepMatch(1);
    expect(c.openedCur()).toBe(0); // wraps
    c.stepMatch(-1);
    expect(c.openedCur()).toBe(1);

    button('Tree').click();
    render();
    button('Collapse all').click();
    c.stepMatch(1);
    const cur = q('.lg-vbody mark.lg-cur')!;
    expect(cur).not.toBeNull();
    // Every tree node around the match was opened to show it.
    for (let d = cur.closest('details'); d; d = d.parentElement?.closest('details') ?? null) expect(d.open).toBeTrue();
  });

  it('leaves anything else as it is, and Check format says why - e.g. JSON cut off by the logger', () => {
    open(CUT);
    expect(q('.lg-vbar')).toBeNull();
    expect(q('.lg-seg button')!.textContent).not.toBe('Original');
    q('.lg-vcheck')!.click();
    fixture.detectChanges();
    const bar = q('.lg-vbar.warn')!;
    expect(bar.textContent).toContain('ends too early');
    expect(bar.textContent).toContain("logger's length limit");
  });
});

