package com.fathy.alfred.backend.board.domain.model;

/**
 * Where one of Claude's questions stands (specs/019). OPEN waits on the user; PENDING is a follow-up whose question is
 * not answered yet; LATER was put off until a time; ANSWERED, WITHDRAWN (by Claude, with a reason) and DROPPED (a
 * follow-up of an option the user did not pick) are done.
 */
public enum QuestionState {
    OPEN, PENDING, LATER, ANSWERED, WITHDRAWN, DROPPED
}
