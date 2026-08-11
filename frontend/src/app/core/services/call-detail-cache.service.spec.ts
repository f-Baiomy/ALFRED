import { of, Subject } from 'rxjs';
import { CallDetailCacheService } from './call-detail-cache.service';
import { CallDetail } from '../models/call.model';

function detail(body: string): CallDetail {
  return { request: { headers: {}, body: '' }, response: { status: 200, headers: {}, body } };
}

describe('CallDetailCacheService', () => {
  it('fetches from the network on first call', () => {
    const service = new CallDetailCacheService();
    let calls = 0;
    const fetcher = () => {
      calls++;
      return of(detail('a'));
    };

    let result: CallDetail | undefined;
    service.fetch('call-1', fetcher).subscribe((d) => (result = d));

    expect(calls).toBe(1);
    expect(result).toEqual(detail('a'));
  });

  it('serves a second fetch for the same id from the cache without calling the fetcher again', () => {
    const service = new CallDetailCacheService();
    let calls = 0;
    const fetcher = () => {
      calls++;
      return of(detail('a'));
    };

    service.fetch('call-1', fetcher).subscribe();
    service.fetch('call-1', fetcher).subscribe();

    expect(calls).toBe(1);
  });

  it('get() returns the cached value synchronously once resolved', () => {
    const service = new CallDetailCacheService();
    expect(service.get('call-1')).toBeUndefined();

    service.fetch('call-1', () => of(detail('a'))).subscribe();

    expect(service.get('call-1')).toEqual(detail('a'));
  });

  it('shares one in-flight request between concurrent callers instead of firing a second one', () => {
    const service = new CallDetailCacheService();
    let calls = 0;
    const subject = new Subject<CallDetail>();
    const fetcher = () => {
      calls++;
      return subject.asObservable();
    };

    let first: CallDetail | undefined;
    let second: CallDetail | undefined;
    service.fetch('call-1', fetcher).subscribe((d) => (first = d));
    service.fetch('call-1', fetcher).subscribe((d) => (second = d));

    expect(calls).toBe(1);
    subject.next(detail('a'));
    subject.complete();

    expect(first).toEqual(detail('a'));
    expect(second).toEqual(detail('a'));
  });

  it('keeps separate cache entries per call id', () => {
    const service = new CallDetailCacheService();
    service.fetch('call-1', () => of(detail('a'))).subscribe();
    service.fetch('call-2', () => of(detail('b'))).subscribe();

    expect(service.get('call-1')).toEqual(detail('a'));
    expect(service.get('call-2')).toEqual(detail('b'));
  });
});
