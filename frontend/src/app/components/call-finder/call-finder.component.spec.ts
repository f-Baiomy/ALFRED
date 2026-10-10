import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { CallRecord } from '../../core/models/call.model';
import { CallsApiService } from '../../core/services/calls-api.service';
import { CallsPageResult } from '../../core/state/call-list-view';
import { CallFinderComponent, FoundCall } from './call-finder.component';

const call: CallRecord = {
  id: 'c1', original_url: 'http://x/api/orders', url: 'http://x/api/orders', method: 'POST', timestamp: '2026-10-10T09:00:00Z', duration_ms: 12,
  response: { status: 201 },
} as CallRecord;

describe('CallFinderComponent', () => {
  function create(pickOnClick: boolean) {
    const calls = jasmine.createSpyObj<CallsApiService>('CallsApiService', ['getCalls', 'getDetail']);
    calls.getCalls.and.returnValue(of({ calls: [call], total: 1 } as CallsPageResult));
    calls.getDetail.and.returnValue(of({ response: { status: 201, headers: {}, body: '{}' } }));
    TestBed.configureTestingModule({ imports: [CallFinderComponent], providers: [{ provide: CallsApiService, useValue: calls }] });
    const fixture = TestBed.createComponent(CallFinderComponent);
    fixture.componentRef.setInput('pickOnClick', pickOnClick);
    fixture.detectChanges();
    fixture.componentInstance.results.set([call]);
    fixture.detectChanges();
    const chosen: FoundCall[] = [];
    fixture.componentInstance.chosen.subscribe((c) => chosen.push(c));
    return { fixture, chosen, calls };
  }

  it('picks the call on a row click when the host asks for it (the @ mention picker)', () => {
    const { fixture, chosen, calls } = create(true);
    (fixture.nativeElement.querySelector('.answer-result') as HTMLButtonElement).click();
    expect(chosen.map((c) => c.call.id)).toEqual(['c1']);
    expect(calls.getDetail).not.toHaveBeenCalled();
  });

  it('opens the preview on a row click otherwise, and picks only from its button', () => {
    const { fixture, chosen, calls } = create(false);
    (fixture.nativeElement.querySelector('.answer-result') as HTMLButtonElement).click();
    expect(chosen).toEqual([]);
    expect(calls.getDetail).toHaveBeenCalled();
  });
});
