package com.fathy.alfred.backend.dbcapture.adapter.in.web;

import org.junit.jupiter.api.Test;

import java.time.Instant;

import static org.assertj.core.api.Assertions.assertThat;

class AgentKeyTest {

    /** What proxy/log_and_route_reverse.py's agent_key('s3cret', now=1759860000) stamps - the two must agree. */
    private static final String PROXY_VECTOR = "1759860000.7860e503520592f85d834d41b530d76e26d961c66066445d3ac19661b1a14afc";

    @Test
    void matchesWhatTheProxyStamps() {
        assertThat(AgentKey.make("s3cret", Instant.ofEpochSecond(1759860000L + 1799))).isEqualTo(PROXY_VECTOR);
        assertThat(AgentKey.valid("s3cret", PROXY_VECTOR, Instant.ofEpochSecond(1759860000L + 3600))).isTrue();
        assertThat(AgentKey.valid("s3cret", PROXY_VECTOR.toUpperCase(), Instant.ofEpochSecond(1759860000L + 3600))).isTrue();
    }

    @Test
    void expiresAfterADayAndRefusesTheFutureAndOtherSecrets() {
        Instant issued = Instant.ofEpochSecond(1759860000L);
        String key = AgentKey.make("s3cret", issued);
        assertThat(AgentKey.valid("s3cret", key, issued.plusSeconds(AgentKey.VALID_SECONDS))).isTrue();
        assertThat(AgentKey.valid("s3cret", key, issued.plusSeconds(AgentKey.VALID_SECONDS + 1))).isFalse();
        assertThat(AgentKey.valid("s3cret", key, issued.minusSeconds(AgentKey.FUTURE_SECONDS + 1))).isFalse();
        assertThat(AgentKey.valid("other", key, issued)).isFalse();
        assertThat(AgentKey.valid("", key, issued)).isFalse();
        assertThat(AgentKey.valid("s3cret", null, issued)).isFalse();
        assertThat(AgentKey.valid("s3cret", "1759860000", issued)).isFalse();
        assertThat(AgentKey.valid("s3cret", "x.y", issued)).isFalse();
    }
}
