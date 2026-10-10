package com.fathy.alfred.backend.board.domain.model;

import java.util.List;

/** One page of board rows, the total matching the filters, and the progress counts of the board (unfiltered). */
public record CardsPage(List<CardSummary> cards, int total, Progress counts) {

    /** open = Inbox to In progress, fixed = Fixed or Verified, done = Done or Closed. */
    public record Progress(int open, int fixed, int done) {
    }
}
