package com.fathy.alfred.backend.board.domain.model;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

/** What a call mention names: the live call kept out of retention, the call and cycle its badges and verdicts use. */
class MentionRefTest {

    private static MentionRef call(String ref) {
        return new MentionRef(MentionType.CALL, ref, "GET /x");
    }

    @Test
    void aLiveCallAndACycleCall() {
        assertThat(call("in:abc").liveCallId()).isEqualTo("abc");
        assertThat(call("in:abc").callId()).isEqualTo("abc");
        assertThat(call("in:abc").cycleId()).isNull();
        assertThat(call("out:abc@c1").liveCallId()).isNull();
        assertThat(call("out:abc@c1").callId()).isEqualTo("abc");
        assertThat(call("out:abc@c1").cycleId()).isEqualTo("c1");
        assertThat(call("out:abc@c1").direction()).isEqualTo("out");
    }

    @Test
    void aCallOfAnotherAlfredsCycleIsTheOwnersCallInThatLinkedCycle() {
        // specs/035: the owner's call id - what the linked cycle's calls carry when this board judges them - and the
        // cycle with its link; never a live call of this Alfred to keep
        MentionRef r = call("in:abc@c1@stg-83");
        assertThat(r.callId()).isEqualTo("abc");
        assertThat(r.cycleId()).isEqualTo("c1@stg-83");
        assertThat(r.liveCallId()).isNull();
        assertThat(call("in:abc@c1@stg-83@pc-1").cycleId()).isEqualTo("c1@stg-83@pc-1");
    }
}
