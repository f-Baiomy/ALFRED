import { recordingConflict } from './recording-conflict';

describe('recordingConflict', () => {
  it('reads the running cycle of a session-cycles 409', () => {
    expect(recordingConflict({ status: 409, error: { error: 'RECORDING_CONFLICT', running: { id: 'c2', name: 'rec 14 Oct' } } }))
      .toEqual({ id: 'c2', name: 'rec 14 Oct', boards: undefined });
  });

  it('reads the running cycle of a board record 409', () => {
    expect(recordingConflict({ status: 409, error: { error: 'RECORDING_CONFLICT', running: { cycleId: 'c2', name: '', boards: ['b1'] } } }))
      .toEqual({ id: 'c2', name: 'c2', boards: ['b1'] });
  });

  it('ignores any other error', () => {
    expect(recordingConflict({ status: 404 })).toBeNull();
    expect(recordingConflict({ status: 409, error: { error: 'conflict' } })).toBeNull();
    expect(recordingConflict(null)).toBeNull();
  });
});
