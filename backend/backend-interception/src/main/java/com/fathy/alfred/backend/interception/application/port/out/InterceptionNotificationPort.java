package com.fathy.alfred.backend.interception.application.port.out;

/**
 * Tells connected frontends that something changed, so they refetch.
 *
 * <p>Same shape as every other slice's notification port: a payload-free "something changed" push
 * that triggers a refetch, never a merge of individual records (see docs/frontend-architecture.md
 * - there is no polling anywhere in Alfred, and a list is cheap to refetch).
 *
 * <p>The paused signal is separate from the rules signal because they have completely different
 * urgency. A rule edit is rare and the list is small. A pause means somebody's connection is open
 * RIGHT NOW with a countdown running, and the UI has to react immediately rather than on the next
 * convenient refetch.
 */
public interface InterceptionNotificationPort {

    void rulesChanged();

    void pausedCallsChanged();
}
