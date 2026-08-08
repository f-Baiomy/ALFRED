package com.alfred.pennyworth.sessioncycles.domain.model;

/** Empty is deliberately not a stored value here - it's a frontend-computed label (Paused + zero captured calls). */
public enum SessionCycleStatus {
    RECORDING,
    PAUSED
}
