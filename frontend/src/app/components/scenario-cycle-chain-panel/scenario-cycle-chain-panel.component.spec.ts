import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ScenarioCycleChainPanelComponent } from './scenario-cycle-chain-panel.component';
import { BulkResendDialogService } from '../../core/services/bulk-resend-dialog.service';
import { CallRecord } from '../../core/models/call.model';
import { provideHttpClient } from '@angular/common/http';

const calls: CallRecord[] = [
  {
    id: 'c1', original_url: 'https://api.example.com/login', url: 'https://api.example.com/login', method: 'POST', timestamp: 't', duration_ms: 1,
    request: { headers: {} }, response: { status: 200, headers: {}, body: '{"accessToken":"abcdef1234567890"}' },
  } as CallRecord,
  {
    id: 'c2', original_url: 'https://api.example.com/profile', url: 'https://api.example.com/profile', method: 'GET', timestamp: 't', duration_ms: 1,
    request: { headers: { authorization: 'Bearer abcdef1234567890' } }, response: { status: 200, headers: {}, body: '{}' },
  } as CallRecord,
];

describe('ScenarioCycleChainPanelComponent', () => {
  let fixture: ComponentFixture<ScenarioCycleChainPanelComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [ScenarioCycleChainPanelComponent], providers: [provideHttpClient()] }).compileComponents();
    fixture = TestBed.createComponent(ScenarioCycleChainPanelComponent);
    fixture.componentRef.setInput('calls', calls);
    fixture.componentRef.setInput('cycleName', 'My cycle');
    fixture.detectChanges();
  });

  it('lists a detected chain, pre-accepted', () => {
    expect(fixture.nativeElement.querySelectorAll('.scenario-chain-item').length).toBe(1);
    expect(fixture.componentInstance.isChained(fixture.componentInstance.suggestions()[0].name)).toBeTrue();
  });

  it('toggling a suggestion off excludes it from the chained set', () => {
    const name = fixture.componentInstance.suggestions()[0].name;
    fixture.componentInstance.toggle(name);
    expect(fixture.componentInstance.isChained(name)).toBeFalse();
  });

  it('createScenario starts the bulk resend dialog with one sequential group named after the cycle', () => {
    const dialog = TestBed.inject(BulkResendDialogService);
    let closed = false;
    fixture.componentInstance.closed.subscribe(() => (closed = true));
    fixture.componentInstance.createScenario();
    expect(dialog.drafts().length).toBe(2);
    const groups = Object.values(dialog.groups());
    expect(groups.length).toBe(1);
    expect(groups[0].name).toBe('My cycle');
    expect(groups[0].mode).toBe('sequential');
    expect(dialog.drafts().every((d) => d.groupId === groups[0].id)).toBeTrue();
    expect(closed).toBeTrue();
  });
});
