package com.fathy.alfred.backend.dbcapture.application.port.in;

import com.fathy.alfred.backend.dbcapture.domain.model.CallOnThread;

import java.time.Instant;
import java.util.List;
import java.util.Optional;

/**
 * Which request thread handled a captured call, and which captured calls ran on a thread around a time - what log
 * lines are matched to calls by when they carry no call id (specs/008-logs-call-link, research R3).
 */
public interface CallThreadsUseCase {

    Optional<String> requestThread(String callId);

    /** Calls opened on {@code thread} in [from, to], oldest first. */
    List<CallOnThread> callsOnThread(String thread, Instant from, Instant to);

    /**
     * The last {@code limit} calls opened on {@code thread} before {@code before}, newest first - the calls whose window
     * may still reach that time (a thread serves one request at a time, so the latest ones are the only candidates).
     */
    List<CallOnThread> callsBefore(String thread, Instant before, int limit);
}
