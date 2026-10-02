import { signal } from '@angular/core';
import { TestBed, fakeAsync, tick } from '@angular/core/testing';
import { CallRecord } from '../../core/models/call.model';
import { PinService } from '../../core/services/pin.service';
import { CALL_LIST_CONTROLS_STATE } from '../../core/state/call-selection.tokens';
import { CallListComponent } from './call-list.component';

/** The loading skeleton (review B20/B21): no NG0600, real calls never wait behind it, and only an
 *  empty result is held back for a beat. */
describe('CallListComponent loading skeleton', () => {
  const calls = signal<readonly CallRecord[]>([]);
  const loading = signal(true);

  beforeEach(() => {
    calls.set([]);
    loading.set(true);
    TestBed.configureTestingModule({
      imports: [CallListComponent],
      providers: [
        { provide: CALL_LIST_CONTROLS_STATE, useValue: { calls, loading, error: signal(null), groupBySupplier: signal(false) } },
        { provide: PinService, useValue: { pinned: signal(new Map()) } },
      ],
    });
    TestBed.overrideComponent(CallListComponent, { set: { template: '', imports: [] } });
  });

  it('shows while loading empty, and real calls replace it at once', () => {
    const fixture = TestBed.createComponent(CallListComponent);
    fixture.detectChanges();
    expect(fixture.componentInstance.skeletonVisible()).toBeTrue();

    calls.set([{ id: 'c-1' } as CallRecord]);
    loading.set(false);
    fixture.detectChanges();
    expect(fixture.componentInstance.skeletonVisible()).toBeFalse();
  });

  it('holds an empty result briefly, then shows it again for the next empty load', fakeAsync(() => {
    const fixture = TestBed.createComponent(CallListComponent);
    fixture.detectChanges();
    loading.set(false);
    fixture.detectChanges();
    expect(fixture.componentInstance.skeletonVisible()).toBeTrue();
    tick(700);
    fixture.detectChanges();
    expect(fixture.componentInstance.skeletonVisible()).toBeFalse();

    loading.set(true);
    fixture.detectChanges();
    expect(fixture.componentInstance.skeletonVisible()).toBeTrue();
  }));
});
