package com.fathy.alfred.backend.board.domain.model;

import com.fasterxml.jackson.annotation.JsonUnwrapped;

import java.time.Instant;
import java.util.List;

/**
 * What changed on the boards after a cursor: every history entry (comments, moves, flags, links, proposals) with the
 * card it belongs to, and every brief, spec file, checklist mark or suggestion written in a cycle. {@code cursor} is
 * where the next call continues; {@code more} says the page was full.
 *
 * <p>specs/022: {@code chats} are the chat messages waiting for Claude (a user's message or a task), {@code fromChat} what
 * a cycle's chat sent its terminal session and the terminal has not read yet - shown, never a reason to wake a wait.
 * Both are additive: older readers ignore them.
 */
public record BoardChanges(List<Entry> entries, List<CycleChange> cycles, List<ChatChange> chats, List<TerminalItem> fromChat, String cursor,
                           boolean more) {

    public BoardChanges {
        entries = List.copyOf(entries);
        cycles = List.copyOf(cycles);
        chats = chats == null ? List.of() : List.copyOf(chats);
        fromChat = fromChat == null ? List.of() : List.copyOf(fromChat);
    }

    public BoardChanges(List<Entry> entries, List<CycleChange> cycles, String cursor, boolean more) {
        this(entries, cycles, List.of(), List.of(), cursor, more);
    }

    public boolean isEmpty() {
        return entries.isEmpty() && cycles.isEmpty() && chats.isEmpty();
    }

    /** One history entry and its card. */
    public record Entry(@JsonUnwrapped ActivityEntry entry, String project, int number, String title, CardStatus status, String cycleId) {
    }

    /** {@code what}: brief, spec, mark or suggestion; {@code name} is the spec file (and item) it concerns. */
    public record CycleChange(String cycleId, String what, String name, String detail, Instant at) {
    }
}
