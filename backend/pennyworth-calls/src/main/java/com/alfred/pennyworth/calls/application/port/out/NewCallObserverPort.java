package com.alfred.pennyworth.calls.application.port.out;

import com.alfred.pennyworth.calls.domain.model.CallRecord;

import java.util.List;

/**
 * Outbound port: lets other slices react to a newly-received call without pennyworth-calls
 * knowing they exist. Spring injects the list of every implementing bean (empty if none are on
 * the classpath), so CallsService works unchanged whether or not anything implements this.
 */
public interface NewCallObserverPort {

    /** @return the ids of whatever this observer captured the call into (e.g. recording session-cycles), or an empty list. */
    List<String> onNewCall(CallRecord call);
}
