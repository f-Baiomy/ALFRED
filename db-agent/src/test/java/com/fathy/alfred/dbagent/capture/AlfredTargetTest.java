package com.fathy.alfred.dbagent.capture;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

class AlfredTargetTest {

    @Test
    void readsTheUrlAndKeyTheProxyStamped() {
        AlfredTarget t = AlfredTarget.fromHeader("id=7c1e; db=1; log=1; alfred=http://127.0.0.1:3001/; key=1759860000.abc");
        assertThat(t.url).isEqualTo("http://127.0.0.1:3001");
        assertThat(t.key).isEqualTo("1759860000.abc");
    }

    @Test
    void aKeyIsOptionalAndAnythingElseIsIgnored() {
        AlfredTarget t = AlfredTarget.fromHeader("id=7c1e; db=0; alfred=https://alfred.example:3000; future=x");
        assertThat(t.url).isEqualTo("https://alfred.example:3000");
        assertThat(t.key).isNull();
    }

    @Test
    void nullWithoutAnHttpUrl() {
        assertThat(AlfredTarget.fromHeader("id=7c1e; db=1")).isNull();
        assertThat(AlfredTarget.fromHeader("id=7c1e; alfred=ftp://x; key=k")).isNull();
        assertThat(AlfredTarget.fromHeader("id=7c1e; alfred=")).isNull();
        assertThat(AlfredTarget.fromHeader("")).isNull();
        assertThat(AlfredTarget.fromHeader(null)).isNull();
    }
}
