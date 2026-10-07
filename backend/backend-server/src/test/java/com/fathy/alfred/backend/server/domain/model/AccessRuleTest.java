package com.fathy.alfred.backend.server.domain.model;

import org.junit.jupiter.api.Test;

import java.util.Set;

import static org.assertj.core.api.Assertions.assertThat;

class AccessRuleTest {

    private static final Set<String> NO_HEADERS = Set.of("Accept", "Host");
    private static final Set<String> OWN = Set.of("192.168.1.80");

    private static EditAccess decide(String setting, String peer) {
        return AccessRule.parse(setting).decide(peer, NO_HEADERS, OWN, RuntimeMode.NATIVE);
    }

    @Test
    void localCoversLoopbackAndTheMachinesOwnAddresses() {
        assertThat(decide("local", "127.0.0.1").reason()).isEqualTo(EditAccess.Reason.LOCAL);
        assertThat(decide("local", "::1").allowed()).isTrue();
        assertThat(decide("local", "192.168.1.80").allowed()).isTrue();
        assertThat(decide("local", "192.168.1.23").reason()).isEqualTo(EditAccess.Reason.NOT_LISTED);
    }

    @Test
    void lanCoversThePrivateRangesOnly() {
        assertThat(decide("lan", "10.1.2.3").reason()).isEqualTo(EditAccess.Reason.LAN);
        assertThat(decide("lan", "172.16.0.1").allowed()).isTrue();
        assertThat(decide("lan", "172.31.255.255").allowed()).isTrue();
        assertThat(decide("lan", "172.32.0.1").allowed()).isFalse();
        assertThat(decide("lan", "192.168.7.9").allowed()).isTrue();
        assertThat(decide("lan", "fd12::1").allowed()).isTrue();
        assertThat(decide("lan", "8.8.8.8").allowed()).isFalse();
        assertThat(decide("lan", "127.0.0.1").allowed()).as("lan alone is not this machine").isFalse();
    }

    @Test
    void explicitAddressesAndRanges() {
        assertThat(decide("local,192.168.1.0/24", "192.168.1.23").reason()).isEqualTo(EditAccess.Reason.LISTED);
        assertThat(decide("local,192.168.1.0/24", "192.168.2.23").allowed()).isFalse();
        assertThat(decide("203.0.113.7", "203.0.113.7").allowed()).isTrue();
        assertThat(decide("2001:db8::/32", "2001:db8::5").allowed()).isTrue();
    }

    @Test
    void theTunnelIsRefusedEvenFromLoopback() {
        for (String header : new String[]{"CF-Connecting-IP", "cf-ray", "CDN-Loop"}) {
            EditAccess access = AccessRule.parse("local,lan").decide("127.0.0.1", Set.of(header), OWN, RuntimeMode.NATIVE);
            assertThat(access.allowed()).isFalse();
            assertThat(access.reason()).isEqualTo(EditAccess.Reason.TUNNEL);
            assertThat(access.howToEdit()).contains("SSH tunnel");
        }
    }

    @Test
    void aForwardedForHeaderChangesNothing() {
        EditAccess access = AccessRule.parse("local").decide("8.8.8.8", Set.of("X-Forwarded-For"), OWN, RuntimeMode.NATIVE);
        assertThat(access.allowed()).isFalse();
    }

    @Test
    void dockerModeRefusesEveryWrite() {
        EditAccess access = AccessRule.parse("local,lan").decide("127.0.0.1", NO_HEADERS, OWN, RuntimeMode.DOCKER);
        assertThat(access.reason()).isEqualTo(EditAccess.Reason.DOCKER_MODE);
        assertThat(access.howToEdit()).contains("restart.py");
    }

    @Test
    void tokensAreValidatedAndNamesAreNeverLookedUp() {
        assertThat(AccessRule.validToken("local")).isTrue();
        assertThat(AccessRule.validToken("LAN")).isTrue();
        assertThat(AccessRule.validToken("10.0.0.0/8")).isTrue();
        assertThat(AccessRule.validToken("10.0.0.0/33")).isFalse();
        assertThat(AccessRule.validToken("example.com")).isFalse();
        assertThat(AccessRule.validToken("everyone")).isFalse();
        assertThat(decide("local", "not-an-address").allowed()).isFalse();
    }
}
