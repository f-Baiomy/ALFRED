import { ReliveCycle } from './relive-types';

/** Names a Relive run can produce, including values captured by rules and step extractions. */
export function reliveVariableNames(cycle: ReliveCycle): Map<string, boolean> {
  const names = new Map<string, boolean>();
  for (const variable of cycle.variables) names.set(variable.name, variable.secret);
  for (const step of cycle.steps) {
    for (const extraction of step.extract ?? []) names.set(extraction.as, names.get(extraction.as) ?? false);
  }
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    const object = value as Record<string, unknown>;
    if (object['scope'] === 'RELIVE' && typeof object['name'] === 'string'
        && /^[A-Za-z][A-Za-z0-9_]*$/.test(object['name'])) {
      names.set(object['name'], names.get(object['name']) ?? false);
    }
    Object.values(object).forEach(visit);
  };
  cycle.steps.forEach((step) => visit(step.callRule));
  cycle.cycleRules.forEach(visit);
  cycle.unexpectedCalls.rules.forEach(visit);
  return names;
}
