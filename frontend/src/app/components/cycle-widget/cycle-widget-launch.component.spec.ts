import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { CycleWidgetLaunchComponent } from './cycle-widget-launch.component';
import { CycleWidgetWindowService } from '../../core/services/cycle-widget-window.service';

describe('CycleWidgetLaunchComponent', () => {
  function render(state: { isOpen?: boolean; recording?: boolean; repin?: boolean; notice?: string | null }) {
    const win = {
      pipSupported: true,
      isOpen: signal(state.isOpen ?? false),
      recording: signal(state.recording ?? false),
      repinRequested: signal(state.repin ?? false),
      notice: signal(state.notice ?? null),
      open: jasmine.createSpy('open').and.resolveTo(),
    };
    TestBed.configureTestingModule({ imports: [CycleWidgetLaunchComponent], providers: [{ provide: CycleWidgetWindowService, useValue: win }] });
    const fixture = TestBed.createComponent(CycleWidgetLaunchComponent);
    fixture.detectChanges();
    return { fixture, win, host: fixture.nativeElement as HTMLElement };
  }

  it('is the edge tab that opens the widget', () => {
    const { host, win } = render({});
    expect(host.classList).toContain('cw-launch');
    expect(host.textContent).toContain('Cycle widget');
    host.click();
    expect(win.open).toHaveBeenCalled();
  });

  it('shows a recording dot only while the open widget\'s cycle records', () => {
    expect(render({ isOpen: true, recording: true }).host.querySelector('.cw-launch-rec')).not.toBeNull();
    TestBed.resetTestingModule();
    expect(render({ isOpen: false, recording: true }).host.querySelector('.cw-launch-rec')).toBeNull();
  });

  it('asks for the re-pin click, and shows a notice when no window could open', () => {
    expect(render({ isOpen: true, repin: true }).host.textContent).toContain('Pin on top');
    TestBed.resetTestingModule();
    expect(render({ notice: 'Your browser blocked the widget window.' }).host.querySelector('.cw-launch-notice')!.textContent).toContain('blocked');
  });
});
