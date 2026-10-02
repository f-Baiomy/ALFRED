import { TestBed } from '@angular/core/testing';
import { CallRecord } from '../models/call.model';
import { Step } from '../../shared/utils/relive-types';
import { ReliveCallSourceService } from './relive-call-source.service';
import { ReliveFingerprintFlow } from './relive-fingerprint-flow.service';
import { ReliveQuickActionsService } from './relive-quick-actions.service';
import { ReliveSelectionDialogService } from './relive-selection-dialog.service';

function call(id: string, source: 'internal' | 'external'): CallRecord {
  return {
    id,
    source,
    url: `https://host.example/${id}`,
    method: 'POST',
    timestamp: '2026-10-02T10:00:00Z',
    request: { headers: {}, body: '{}' },
    response: { status: 200, headers: {}, body: '{}' },
  } as unknown as CallRecord;
}

describe('ReliveQuickActionsService', () => {
  let freezePicked: jasmine.Spy;
  let createAndOpen: jasmine.Spy;
  let service: ReliveQuickActionsService;
  const children = [{ key: 'in-1' }, { key: 'out-1', parentKey: 'in-1' }] as unknown as Step[];

  beforeEach(() => {
    freezePicked = jasmine.createSpy('freezePicked').and.resolveTo(children);
    createAndOpen = jasmine.createSpy('createAndOpen').and.resolveTo(undefined);
    TestBed.configureTestingModule({
      providers: [
        { provide: ReliveCallSourceService, useValue: { freezePicked } },
        { provide: ReliveFingerprintFlow, useValue: { createAndOpen } },
        { provide: ReliveSelectionDialogService, useValue: { open: jasmine.createSpy('open') } },
      ],
    });
    service = TestBed.inject(ReliveQuickActionsService);
  });

  it('Relive now on an inbound call brings its correlated outbound children (FR-003b)', async () => {
    service.reliveNow([call('in-1', 'internal')]);
    await new Promise((resolve) => setTimeout(resolve));

    expect(freezePicked).toHaveBeenCalledWith(
      [jasmine.objectContaining({ ref: { source: 'internal', callId: 'in-1', cycleId: null } })], jasmine.anything());
    expect(createAndOpen.calls.mostRecent().args[0].steps).toEqual(children);
    expect(createAndOpen.calls.mostRecent().args[1]).toEqual({ transient: true, start: true });
  });

  it('a selection of outbound calls only is frozen as it is', async () => {
    service.newCycleFromSelection([call('out-1', 'external')]);
    await new Promise((resolve) => setTimeout(resolve));

    expect(freezePicked).not.toHaveBeenCalled();
    expect(createAndOpen.calls.mostRecent().args[0].steps.length).toBe(1);
  });
});
