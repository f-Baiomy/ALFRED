package com.fathy.alfred.backend.dbcapture.domain.model;

/** How many of a call's statements failed, and how many of those the call swallowed (answered under 500 anyway). */
public record FailureCounts(int failed, int swallowed) {

    public static final FailureCounts NONE = new FailureCounts(0, 0);
}
