package com.fathy.alfred.backend.resendbridge;

import com.fathy.alfred.backend.calls.application.port.in.FindRecentRequestHeadersUseCase;
import com.fathy.alfred.backend.calls.domain.model.RecentRequestHeaders;
import com.fathy.alfred.backend.resend.domain.model.SessionValue;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;
import java.util.Set;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

class SessionValueLookupAdapterTest {

    private final com.fathy.alfred.backend.calls.application.port.in.FindRecentRequestHeadersUseCase outbound =
            mock(FindRecentRequestHeadersUseCase.class);
    private final com.fathy.alfred.backend.internalcalls.application.port.in.FindRecentRequestHeadersUseCase inbound =
            mock(com.fathy.alfred.backend.internalcalls.application.port.in.FindRecentRequestHeadersUseCase.class);
    private final SessionValueLookupAdapter adapter = new SessionValueLookupAdapter(outbound, inbound);

    @Test
    void returnsTheNewestValuePerNameSkippingTheExcludedCall() {
        when(outbound.findRecent("api.test", 200)).thenReturn(List.of(
                new RecentRequestHeaders("c-exclude", "t3", Map.of("Cookie", "should-not-be-used")),
                new RecentRequestHeaders("c-9", "t2", Map.of("Cookie", "session=new")),
                new RecentRequestHeaders("c-1", "t1", Map.of("Cookie", "session=old"))
        ));

        List<SessionValue> found = adapter.newest("outbound", "api.test", Set.of("cookie"), "c-exclude");

        assertThat(found).containsExactly(new SessionValue("cookie", "session=new", "c-9"));
    }

    @Test
    void headerNameMatchingIsCaseInsensitive() {
        when(outbound.findRecent("api.test", 200)).thenReturn(List.of(
                new RecentRequestHeaders("c-1", "t1", Map.of("COOKIE", "session=x"))
        ));

        List<SessionValue> found = adapter.newest("outbound", "api.test", Set.of("cookie"), "none");

        assertThat(found).containsExactly(new SessionValue("cookie", "session=x", "c-1"));
    }

    @Test
    void stopsOnceEveryNameIsFound() {
        when(outbound.findRecent("api.test", 200)).thenReturn(List.of(
                new RecentRequestHeaders("c-2", "t2", Map.of("Cookie", "session=new", "Authorization", "Bearer new")),
                new RecentRequestHeaders("c-1", "t1", Map.of("Cookie", "should-not-be-reached"))
        ));

        List<SessionValue> found = adapter.newest("outbound", "api.test", Set.of("cookie", "authorization"), "none");

        assertThat(found).containsExactlyInAnyOrder(
                new SessionValue("cookie", "session=new", "c-2"),
                new SessionValue("authorization", "Bearer new", "c-2"));
    }

    @Test
    void nothingFoundReturnsAnEmptyList() {
        when(outbound.findRecent("api.test", 200)).thenReturn(List.of());

        assertThat(adapter.newest("outbound", "api.test", Set.of("cookie"), "none")).isEmpty();
    }
}
