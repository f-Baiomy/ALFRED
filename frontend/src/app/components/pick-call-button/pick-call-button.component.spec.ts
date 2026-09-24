import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { CallRecord } from '../../core/models/call.model';
import { CallPickerService } from '../../core/services/call-picker.service';
import { CALL_ORIGIN } from '../../core/state/call-origin.token';
import { PickCallButtonComponent } from './pick-call-button.component';

describe('PickCallButtonComponent', () => {
  const call: CallRecord = { id: 'c1', original_url: 'u', url: 'https://a.com/x', method: 'GET', timestamp: 't', duration_ms: 1, source: 'external' };

  function create(cycleId: string | null) {
    sessionStorage.removeItem('alfred_call_picker');
    TestBed.configureTestingModule({
      imports: [PickCallButtonComponent],
      providers: [
        { provide: Router, useValue: { navigateByUrl: () => true } },
        ...(cycleId ? [{ provide: CALL_ORIGIN, useValue: { cycleId: signal(cycleId), label: signal('Cycle "x"') } }] : []),
      ],
    });
    const fixture = TestBed.createComponent(PickCallButtonComponent);
    fixture.componentRef.setInput('call', call);
    fixture.detectChanges();
    return { fixture, picker: TestBed.inject(CallPickerService) };
  }

  afterEach(() => sessionStorage.removeItem('alfred_call_picker'));

  it('renders nothing unless something is picking', () => {
    const { fixture } = create(null);
    expect(fixture.nativeElement.querySelector('button')).toBeNull();
  });

  it("picks with the page's cycle and label, and shows it picked", () => {
    const { fixture, picker } = create('cy1');
    picker.start({ requester: 't', title: 't', mode: 'single', returnUrl: '/', returnLabel: 't' });
    fixture.detectChanges();

    fixture.nativeElement.querySelector('button').click();
    fixture.detectChanges();

    expect(picker.picked()[0].ref).toEqual({ source: 'external', callId: 'c1', cycleId: 'cy1' });
    expect(picker.picked()[0].originLabel).toBe('Cycle "x"');
    expect(fixture.nativeElement.textContent).toContain('Picked');
  });

  it('is disabled with the reason when its origin is refused', () => {
    const { fixture, picker } = create('cy1');
    picker.start({ requester: 't', title: 't', mode: 'multi', returnUrl: '/', returnLabel: 't', refuseOrigin: { cycleId: 'cy1', reason: 'Already in this cycle' } });
    fixture.detectChanges();

    const button: HTMLButtonElement = fixture.nativeElement.querySelector('button');
    expect(button.disabled).toBeTrue();
    expect(button.title).toBe('Already in this cycle');
  });
});
