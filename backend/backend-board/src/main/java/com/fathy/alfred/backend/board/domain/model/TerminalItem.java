package com.fathy.alfred.backend.board.domain.model;

import java.time.Instant;

/**
 * Something the chat sends to the terminal session (specs/022 FR-050, FR-051): every exchange mirrored in full prose
 * ({@code mirror}), or an urgent item the terminal acts on before its next step. The text is masked before it is stored
 * (the MCP server's masking) - the runner writes it to its chat log as it is.
 *
 * @param state WAITING while no terminal session is open (handed over at the next one), QUEUED while the terminal is busy
 *              (coalesced into its next turn), SENT once stored for a running
 *              terminal, DELIVERED when the runner wrote it to the chat log, READ after the terminal's next step, UNDONE
 *              when taken back before it was read
 */
public record TerminalItem(long id, ChatKey chat, Long messageId, boolean urgent, boolean mirror, String text, String reason, State state,
                           Instant createdAt, Instant deliveredAt, Instant readAt) {

    public enum State { WAITING, QUEUED, SENT, DELIVERED, READ, UNDONE }

    /** The longest item text kept - prose only; bodies and payloads travel as references. */
    public static final int MAX_TEXT = 64 * 1024;

    public TerminalItem {
        text = text == null ? "" : text;
        if (text.length() > MAX_TEXT) {
            text = text.substring(0, MAX_TEXT);
        }
    }

    public boolean canUndo() {
        return state != State.READ && state != State.UNDONE;
    }
}
