package com.fathy.alfred.backend.triagebridge;

import com.fathy.alfred.backend.sessioncycles.application.port.in.ListCapturedCallsUseCase;
import com.fathy.alfred.backend.sessioncycles.application.port.in.ListPagedCapturedInternalCallsUseCase;
import com.fathy.alfred.backend.sessioncycles.domain.model.CapturedCallSummary;
import com.fathy.alfred.backend.sessioncycles.domain.model.CapturedInternalCallSummary;

import java.util.function.Consumer;

/** Pages through every call a cycle captured (explicitly paged, whatever the UI pagination setting is). */
public final class CycleCallsReader {

    private static final int PAGE = 200;

    private final ListCapturedCallsUseCase capturedCalls;
    private final ListPagedCapturedInternalCallsUseCase capturedInternalCalls;

    public CycleCallsReader(ListCapturedCallsUseCase capturedCalls, ListPagedCapturedInternalCallsUseCase capturedInternalCalls) {
        this.capturedCalls = capturedCalls;
        this.capturedInternalCalls = capturedInternalCalls;
    }

    public void inbound(String cycleId, Consumer<CapturedInternalCallSummary> each) {
        int offset = 0;
        while (true) {
            var page = capturedInternalCalls.listCalls(cycleId,
                    new com.fathy.alfred.backend.internalcalls.domain.model.CallsQuery("", "", "oldest", offset, PAGE, "", "", "", "", ""), true);
            if (page.isEmpty() || page.get().calls().isEmpty()) {
                return;
            }
            page.get().calls().forEach(each);
            offset += page.get().calls().size();
            if (offset >= page.get().total()) {
                return;
            }
        }
    }

    public void outbound(String cycleId, Consumer<CapturedCallSummary> each) {
        int offset = 0;
        while (true) {
            var page = capturedCalls.listCalls(cycleId,
                    new com.fathy.alfred.backend.calls.domain.model.CallsQuery("", "", "oldest", offset, PAGE), true);
            if (page.isEmpty() || page.get().calls().isEmpty()) {
                return;
            }
            page.get().calls().forEach(each);
            offset += page.get().calls().size();
            if (offset >= page.get().total()) {
                return;
            }
        }
    }
}
