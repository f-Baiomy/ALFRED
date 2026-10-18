import { TestBed } from '@angular/core/testing';
import { BannerComponent } from './banner.component';

describe('BannerComponent', () => {
  it('shows the line, its detail and action, and says errors as alerts', () => {
    const f = TestBed.createComponent(BannerComponent);
    f.componentRef.setInput('tone', 'error');
    f.componentRef.setInput('text', "Claude didn't start");
    f.componentRef.setInput('detail', 'The Claude account on your PC hit its weekly limit.');
    f.componentRef.setInput('action', 'Try again');
    let acted = 0;
    let dismissed = 0;
    f.componentInstance.act.subscribe(() => acted++);
    f.componentInstance.dismiss.subscribe(() => dismissed++);
    f.detectChanges();
    const el = f.nativeElement as HTMLElement;
    expect(el.querySelector('.banner')!.getAttribute('role')).toBe('alert');
    expect(el.textContent).toContain("Claude didn't start");
    expect(el.textContent).toContain('weekly limit');
    (el.querySelector('.banner__act') as HTMLButtonElement).click();
    (el.querySelector('.banner__x') as HTMLButtonElement).click();
    expect([acted, dismissed]).toEqual([1, 1]);
  });

  it('is a quiet status without an action', () => {
    const f = TestBed.createComponent(BannerComponent);
    f.componentRef.setInput('tone', 'ok');
    f.componentRef.setInput('text', 'Handed back');
    f.detectChanges();
    const el = f.nativeElement as HTMLElement;
    expect(el.querySelector('.banner')!.getAttribute('role')).toBe('status');
    expect(el.querySelector('.banner__act')).toBeNull();
  });
});
