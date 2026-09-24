import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { CallRecord } from '../../core/models/call.model';
import { CallPickerService } from '../../core/services/call-picker.service';
import { PickBarComponent } from './pick-bar.component';

describe('PickBarComponent', () => {
  const call: CallRecord = { id: 'c1', original_url: 'u', url: 'https://api.supplier.com/v2/fares?x=1', method: 'POST', timestamp: 't', duration_ms: 1, response: { status: 500 } };

  beforeEach(() => {
    sessionStorage.removeItem('alfred_call_picker');
    TestBed.configureTestingModule({
      imports: [PickBarComponent],
      providers: [{ provide: Router, useValue: { navigateByUrl: () => true } }],
    });
  });

  afterEach(() => sessionStorage.removeItem('alfred_call_picker'));

  it('shows nothing until something is picking, then what for, what is picked and from where', () => {
    const fixture = TestBed.createComponent(PickBarComponent);
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent.trim()).toBe('');

    const picker = TestBed.inject(CallPickerService);
    picker.start({ requester: 't', title: 'Call to resend', mode: 'single', returnUrl: '/', returnLabel: 'the resend dialog' });
    fixture.detectChanges();
    const returnButton = [...fixture.nativeElement.querySelectorAll('button')].find((b: HTMLButtonElement) => b.textContent!.includes('Return'));
    expect(returnButton.disabled).toBeTrue();

    picker.toggle(call, 'cy1', 'Cycle "checkout-bug"');
    fixture.detectChanges();
    const text = fixture.nativeElement.textContent;
    expect(text).toContain('Picking: Call to resend');
    expect(text).toContain('api.supplier.com/v2/fares');
    expect(text).toContain('Cycle "checkout-bug"');
    expect(returnButton.disabled).toBeFalse();
  });
});
