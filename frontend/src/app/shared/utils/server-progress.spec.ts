import { UpdateJob } from '../../core/models/server-settings.model';
import { ProgressInput, SLOW_START_MS, creep, progressPhase, progressView } from './server-progress';

const MB = 1024 * 1024;

function job(over: Partial<UpdateJob> = {}): UpdateJob {
  return { state: 'DOWNLOADING', version: '3.0.0', downloadedBytes: 0, totalBytes: 240 * MB, error: '', ...over };
}

function input(over: Partial<ProgressInput> = {}): ProgressInput {
  return { kind: 'UPDATE', job: job(), sizeBytes: 240 * MB, accepted: true, dropped: false, back: false, error: null, phaseMs: 0, ...over };
}

const states = (i: ProgressInput) => progressView(i).steps.map(s => s.state);

describe('progressView - the update dialog moves only on real events', () => {

  it('downloading: the real bytes fill the first 60% of the bar and the download step has its own bar', () => {
    const v = progressView(input({ job: job({ downloadedBytes: 120 * MB }), bytesPerSecond: 20 * MB }));
    expect(states(input({ job: job({ downloadedBytes: 120 * MB }) }))).toEqual(['active', 'pending', 'pending', 'pending']);
    expect(v.percent).toBe(30);
    expect(v.phase).toBe('Downloading');
    expect(v.steps[0].bar).toBe(50);
    expect(v.steps[0].detail).toBe('120 MB of 240 MB · 20 MB/s');
    expect(v.outcome).toBe('running');
  });

  it('before the size is known the bar creeps, never jumps to an invented number', () => {
    const v = progressView(input({ job: job({ totalBytes: 0 }), sizeBytes: 0, phaseMs: 5_000 }));
    expect(v.percent).toBeGreaterThan(0);
    expect(v.percent).toBeLessThan(30);
    expect(v.steps[0].bar).toBeUndefined();
  });

  it('verifying, installing and the drop each own their stretch of the bar', () => {
    const verifying = progressView(input({ job: job({ state: 'VERIFYING', downloadedBytes: 240 * MB }) }));
    expect(states(input({ job: job({ state: 'VERIFYING' }) }))).toEqual(['done', 'active', 'pending', 'pending']);
    expect(verifying.percent).toBe(60);
    expect(verifying.steps[0].bar).toBeUndefined();
    expect(verifying.steps[0].detail).toBe('240 MB');

    const installing = progressView(input({ job: job({ state: 'INSTALLING' }), phaseMs: 60_000 }));
    expect(installing.steps.map(s => s.state)).toEqual(['done', 'done', 'active', 'pending']);
    expect(installing.percent).toBeGreaterThan(70);
    expect(installing.percent).toBeLessThan(90);

    // the socket dropping means the installer stopped Alfred - even if the INSTALLING event was never seen
    const dropped = progressView(input({ job: job({ state: 'DOWNLOADING' }), dropped: true }));
    expect(dropped.steps.map(s => s.state)).toEqual(['done', 'done', 'done', 'active']);
    expect(dropped.percent).toBe(90);
    expect(dropped.phase).toBe('Starting Alfred');
  });

  it('back: every step done and the bar full; a slow start says so instead of only spinning', () => {
    const back = progressView(input({ job: job({ state: 'INSTALLING' }), dropped: true, back: true }));
    expect(back.steps.every(s => s.state === 'done')).toBeTrue();
    expect(back.percent).toBe(100);
    expect(back.outcome).toBe('ok');
    const slow = progressView(input({ dropped: true, phaseMs: SLOW_START_MS }));
    expect(slow.steps[3].detail).toContain('still starting');
    expect(slow.percent).toBeLessThan(100);
  });

  it('a checksum failure fails the verifying step with the reason and stops the bar', () => {
    const v = progressView(input({ job: job({ state: 'FAILED', downloadedBytes: 240 * MB, error: 'the downloaded installer\'s checksum is ab12…' }) }));
    expect(v.steps.map(s => s.state)).toEqual(['done', 'fail', 'pending', 'pending']);
    expect(v.steps[1].detail).toContain('checksum');
    expect(v.outcome).toBe('failed');
    expect(v.phase).toBe('Stopped');
  });

  it('back on the old version fails the last step with the reason, not a green done', () => {
    const v = progressView(input({ job: job({ state: 'INSTALLING' }), dropped: true, back: true, error: 'Alfred came back on 2.9.0, not 3.0.0' }));
    expect(v.steps.map(s => s.state)).toEqual(['done', 'done', 'done', 'fail']);
    expect(v.steps[3].detail).toContain('came back on 2.9.0');
    expect(v.outcome).toBe('failed');
    expect(v.percent).toBe(95);
  });

  it('a refused request fails the step it was on', () => {
    const v = progressView(input({ job: job({ state: 'IDLE' }), accepted: false, error: 'Alfred 3.0.0 is up to date' }));
    expect(v.steps[0]).toEqual(jasmine.objectContaining({ state: 'fail', detail: 'Alfred 3.0.0 is up to date' }));
  });
});

describe('progressView - restarts', () => {

  it('Restart Alfred: stopping, then starting after the drop, done when it answers', () => {
    const base: Partial<ProgressInput> = { kind: 'BACKEND', job: null };
    expect(states(input({ ...base, accepted: false }))).toEqual(['active', 'pending']);
    expect(states(input({ ...base, dropped: true }))).toEqual(['done', 'active']);
    const back = progressView(input({ ...base, dropped: true, back: true }));
    expect(back.steps.map(s => s.state)).toEqual(['done', 'done']);
    expect(back.percent).toBe(100);
  });

  it('Restart proxies: one step, done when the request answers', () => {
    expect(progressView(input({ kind: 'PROXIES', job: null, accepted: false })).outcome).toBe('running');
    const done = progressView(input({ kind: 'PROXIES', job: null, accepted: true }));
    expect(done.outcome).toBe('ok');
    expect(done.percent).toBe(100);
  });
});

describe('creep and phases', () => {
  it('creeps half way in halfMs and never reaches the end', () => {
    expect(creep(70, 90, 0, 1000)).toBe(70);
    expect(creep(70, 90, 1000, 1000)).toBe(80);
    expect(creep(70, 90, 1e9, 1000)).toBe(89);
  });

  it('names a new phase on every real event, so each stretch creeps from its own start', () => {
    expect(progressPhase(input())).toBe('DOWNLOADING');
    expect(progressPhase(input({ job: job({ state: 'INSTALLING' }) }))).toBe('INSTALLING');
    expect(progressPhase(input({ dropped: true }))).toBe('dropped');
    expect(progressPhase(input({ dropped: true, back: true }))).toBe('back');
    expect(progressPhase(input({ error: 'x' }))).toBe('failed');
  });
});
