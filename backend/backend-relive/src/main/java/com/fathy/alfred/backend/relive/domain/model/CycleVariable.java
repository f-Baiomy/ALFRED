package com.fathy.alfred.backend.relive.domain.model;

/** A cycle-scoped variable. {@code value} is the initial value; a run's own value lives in the
 *  run's variable timeline, never written back here. */
public record CycleVariable(String name, String value, boolean secret, String note) {
}
