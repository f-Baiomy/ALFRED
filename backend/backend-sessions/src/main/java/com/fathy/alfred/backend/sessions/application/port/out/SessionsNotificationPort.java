package com.fathy.alfred.backend.sessions.application.port.out;

/**
 * "Something changed" for the pages (specs/031, /ws/sessions): {@code what} is holders, sessions, commands, keys or
 * settings; {@code boardId} when one board is concerned. Never carries a user's settings or keys - the page re-reads what
 * it may see.
 */
public interface SessionsNotificationPort {

    void changed(String what, String boardId);
}
