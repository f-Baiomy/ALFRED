package com.fathy.alfred.dbagent.capture;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

class CallContextTest {

    @Test
    void parsesIdDbAndRunTag() {
        CallContext c = CallContext.fromHeader("id=7c1e; db=1; run=run-a/s-pay; future=x", 0);
        assertThat(c.callId()).isEqualTo("7c1e");
        assertThat(c.runTag()).isEqualTo("run-a/s-pay");
        assertThat(c.nextSeq()).isEqualTo(1);
        assertThat(c.nextSeq()).isEqualTo(2);
    }

    @Test
    void dbZeroOrMissingIdMeansNotCaptured() {
        assertThat(CallContext.fromHeader("id=7c1e; db=0", 0)).isNull();
        assertThat(CallContext.fromHeader("db=1", 0)).isNull();
        assertThat(CallContext.fromHeader("", 0)).isNull();
        assertThat(CallContext.fromHeader(null, 0)).isNull();
        assertThat(CallContext.fromHeader("garbage", 0)).isNull();
    }
}
