package com.fathy.alfred.backend.comments.application.port.out;

/**
 * Outbound port: how the application core says "this call's comments changed" - today, a
 * WebSocket broadcast. Carries only the call id, never the comment: an open view that already
 * shows that call re-fetches its comments, any other view ignores it. Without it a comment written
 * by another client (another browser, or Claude through the MCP server) stayed invisible in an
 * already-open call until a reload - the frontend's BroadcastChannel only reaches tabs of the
 * same browser.
 */
public interface CommentNotificationPort {

    void notifyCommentsChanged(String callId);
}
