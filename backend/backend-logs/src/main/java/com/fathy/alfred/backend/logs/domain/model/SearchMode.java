package com.fathy.alfred.backend.logs.domain.model;

/** EXACT = B-tree index (fast whole-value filters, sorts, groups); TEXT = in the trigram index (fragment search); NONE = stored and filterable, slower (FR-013). */
public enum SearchMode {
    EXACT, TEXT, NONE
}
