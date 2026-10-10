import { provideHttpClient } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { of } from 'rxjs';
import { CallRecord } from '../models/call.model';
import { PickedCall } from '../models/call-ref.model';
import { BoardApiService } from './board-api.service';
import { BOARD_PICK_REQUESTER, BoardMentionsService, pickedMention } from './board-mentions.service';
import { CallPickerService } from './call-picker.service';

const call = (id: string, status: number | null, url = 'http://localhost:8080/api/orders?x=1'): CallRecord =>
  ({ id, method: 'POST', url, original_url: url, timestamp: '', duration_ms: 1, response: status === null ? undefined : { status } } as CallRecord);

describe('BoardMentionsService - Pick from anywhere', () => {
  beforeEach(() => sessionStorage.removeItem('alfred_call_picker'));

  it('writes a picked call as a call mention, with its cycle when it was picked inside one', () => {
    const live: PickedCall = { ref: { source: 'internal', callId: 'a1', cycleId: null }, call: call('a1', 500), originLabel: 'Live calls' };
    const inCycle: PickedCall = { ref: { source: 'external', callId: 'b2', cycleId: 'c-9' }, call: call('b2', null), originLabel: 'Cycle' };
    expect(pickedMention(live)).toEqual({ type: 'call', ref: 'in:a1', label: 'POST /api/orders · 500' });
    expect(pickedMention(inCycle)).toEqual({ type: 'call', ref: 'out:b2@c-9', label: 'POST /api/orders · …' });
  });

  it('from "+ link": a multi pick that returns to the card, links every picked call and opens the card', () => {
    const link = jasmine.createSpy('link').and.returnValue(of({}));
    TestBed.configureTestingModule({ providers: [provideRouter([]), provideHttpClient(), { provide: BoardApiService, useValue: { link } }] });
    const router = TestBed.inject(Router);
    spyOn(router, 'navigateByUrl').and.returnValue(Promise.resolve(true));
    const picker = TestBed.inject(CallPickerService);
    const mentions = TestBed.inject(BoardMentionsService);

    mentions.pickForCard({ id: 'card-1', project: 'odeysys', number: 7, cycleId: null }, { kind: 'links' });
    expect(picker.request()?.mode).toBe('multi');
    expect(picker.request()?.returnUrl).toBe('/board?project=odeysys&card=7');

    picker.toggle({ ...call('a1', 201), source: 'internal' }, null, 'Live calls');
    picker.toggle({ ...call('b2', 404), source: 'external' }, 'c-9', 'Cycle');
    picker.finish();
    TestBed.flushEffects();

    expect(link.calls.allArgs().map(([id, m]) => [id, m.ref])).toEqual([['card-1', 'in:a1'], ['card-1', 'out:b2@c-9']]);
    expect(mentions.cardToOpen()).toEqual({ project: 'odeysys', number: 7 });
    expect(picker.hasResult(BOARD_PICK_REQUESTER)).toBeFalse();
  });

  it('from the comment box: the picks come back written into the comment where the @ was, and nothing is linked', () => {
    const link = jasmine.createSpy('link').and.returnValue(of({}));
    TestBed.configureTestingModule({ providers: [provideRouter([]), provideHttpClient(), { provide: BoardApiService, useValue: { link } }] });
    spyOn(TestBed.inject(Router), 'navigateByUrl').and.returnValue(Promise.resolve(true));
    const picker = TestBed.inject(CallPickerService);
    const mentions = TestBed.inject(BoardMentionsService);

    mentions.pickForCard({ id: 'card-1', project: 'p', number: 7, cycleId: null }, { kind: 'text', field: 'comment', text: 'see  please', at: 4 });
    picker.toggle({ ...call('a1', 201), source: 'internal' }, null, 'Live calls');
    picker.finish();
    TestBed.flushEffects();

    expect(link).not.toHaveBeenCalled();
    expect(mentions.cardToOpen()).toEqual({ project: 'p', number: 7 });
    expect(mentions.takePickedText('other-card')).toBeNull();
    expect(mentions.takePickedText('card-1')).toEqual({ cardId: 'card-1', field: 'comment', text: 'see @[call:in:a1|POST /api/orders · 201]  please' });
    expect(mentions.takePickedText('card-1')).toBeNull();
  });

  it('a cancelled pick from the description still gives the text back untouched', () => {
    TestBed.configureTestingModule({ providers: [provideRouter([]), provideHttpClient(), { provide: BoardApiService, useValue: { link: () => of({}) } }] });
    spyOn(TestBed.inject(Router), 'navigateByUrl').and.returnValue(Promise.resolve(true));
    const picker = TestBed.inject(CallPickerService);
    const mentions = TestBed.inject(BoardMentionsService);

    mentions.pickForCard({ id: 'card-1', project: 'p', number: 7, cycleId: null }, { kind: 'text', field: 'description', text: 'half written', at: 12 });
    picker.cancel();
    TestBed.flushEffects();

    expect(mentions.takePickedText('card-1')).toEqual({ cardId: 'card-1', field: 'description', text: 'half written' });
  });
});
