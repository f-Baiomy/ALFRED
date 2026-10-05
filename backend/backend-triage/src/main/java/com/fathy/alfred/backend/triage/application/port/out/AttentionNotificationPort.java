package com.fathy.alfred.backend.triage.application.port.out;

import java.util.Collection;

/** "These calls' marks changed" for /ws/triage - ids only, so an open page re-reads just what it shows. */
public interface AttentionNotificationPort {

    void attentionChanged(Collection<String> callIds);
}
