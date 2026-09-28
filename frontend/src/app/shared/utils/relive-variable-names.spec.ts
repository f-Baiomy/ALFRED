import { reliveVariableNames } from './relive-variable-names';
import { ReliveCycle } from './relive-types';

describe('reliveVariableNames', () => {
  it('includes defined, extracted, and Relive action variables without exposing local actions', () => {
    const cycle = {
      variables: [{ name: 'secret', value: 'value', secret: true }],
      steps: [{
        extract: [{ as: 'bookingId' }],
        callRule: { actions: [
          { type: 'SET_REQUEST_VARIABLE', name: 'sessionId', scope: 'RELIVE' },
          { type: 'SET_REQUEST_VARIABLE', name: 'localOnly', scope: 'LOCAL' },
        ] },
      }],
      cycleRules: [],
      unexpectedCalls: { rules: [] },
    } as unknown as ReliveCycle;
    expect([...reliveVariableNames(cycle)]).toEqual([
      ['secret', true], ['bookingId', false], ['sessionId', false],
    ]);
  });
});
