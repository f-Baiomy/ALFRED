package com.fathy.alfred.backend.teamboards.spi.model;

/** A relation of a work item: Parent, Child, Related, PullRequest, Commit... {@code toId} is the other item or an URL. */
public record Link(String toId, String kind) {
}
