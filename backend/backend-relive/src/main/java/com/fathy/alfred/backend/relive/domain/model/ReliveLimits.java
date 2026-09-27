package com.fathy.alfred.backend.relive.domain.model;

/** Server-side clamps (constitution I). See data-model.md's per-field "Rules" column. */
public final class ReliveLimits {

    public static final int MAX_STEPS = 500;
    public static final int MAX_VARIABLES = 200;
    public static final int MAX_CYCLE_RULES = 200;
    public static final int MAX_LIST_LIMIT = 100;

    private ReliveLimits() {
    }
}
