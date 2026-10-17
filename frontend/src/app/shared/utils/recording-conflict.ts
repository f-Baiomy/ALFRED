/** The cycle already recording the same project, from a 409 RECORDING_CONFLICT answer (specs/027 FR-008); null otherwise. */
export interface RunningCycle {
  readonly id: string;
  readonly name: string;
  readonly boards?: readonly string[];
}

export function recordingConflict(e: unknown): RunningCycle | null {
  const err = e as { status?: number; error?: { error?: string; running?: { id?: string; cycleId?: string; name?: string; boards?: string[] } } };
  if (err?.status !== 409 || err.error?.error !== 'RECORDING_CONFLICT' || !err.error.running) return null;
  const r = err.error.running;
  const id = r.id ?? r.cycleId;
  return id ? { id, name: r.name || id.slice(0, 8), boards: r.boards } : null;
}
