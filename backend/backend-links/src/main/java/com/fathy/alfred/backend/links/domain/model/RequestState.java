package com.fathy.alfred.backend.links.domain.model;

/** A request waits until it is answered or withdrawn (D13); an accepted one can be undone (D12). */
public enum RequestState {
    WAITING, ACCEPTED, REJECTED, WITHDRAWN, UNDONE, FAILED;

    public boolean open() {
        return this == WAITING;
    }
}
