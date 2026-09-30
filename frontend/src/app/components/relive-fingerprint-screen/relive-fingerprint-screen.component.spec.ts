import { TestBed } from '@angular/core/testing';
import { ReliveFingerprintPrompt } from '../../core/services/relive-fingerprint-prompt.service';
import { ReliveFingerprintScreenComponent } from './relive-fingerprint-screen.component';

describe('ReliveFingerprintScreen', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [ReliveFingerprintScreenComponent] });
  });

  it('shows how many supplier steps are being fingerprinted', () => {
    const prompt = TestBed.inject(ReliveFingerprintPrompt);
    const fixture = TestBed.createComponent(ReliveFingerprintScreenComponent);
    void prompt.run(3, true, () => new Promise(() => undefined));
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('3 supplier steps');
    expect(fixture.nativeElement.textContent).toContain('Fingerprinting supplier steps');
  });

  it('warns before close, and close hides the screen', () => {
    const prompt = TestBed.inject(ReliveFingerprintPrompt);
    const fixture = TestBed.createComponent(ReliveFingerprintScreenComponent);
    void prompt.run(1, true, () => new Promise(() => undefined));
    fixture.detectChanges();

    const close: HTMLButtonElement = fixture.nativeElement.querySelector('button');
    close.click();
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('will not compute');
    expect(fixture.nativeElement.textContent).toContain('Fingerprint the cycle');
    expect(fixture.nativeElement.textContent).toContain('Keep waiting');

    const buttons = [...fixture.nativeElement.querySelectorAll('button')] as HTMLButtonElement[];
    buttons.find((button) => button.textContent?.trim() === 'Close')!.click();
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).not.toContain('Fingerprinting');
  });

  it('does not offer a close button when close is disabled, and does not promise a later run will fingerprint', () => {
    const prompt = TestBed.inject(ReliveFingerprintPrompt);
    const fixture = TestBed.createComponent(ReliveFingerprintScreenComponent);
    void prompt.run(2, false, () => new Promise(() => undefined));
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('button')).toBeNull();
    expect(fixture.nativeElement.textContent).toContain('Reading each supplier request');
    expect(fixture.nativeElement.textContent).not.toContain('before this run');
    expect(fixture.nativeElement.textContent).not.toContain('before your first run');
  });
});
