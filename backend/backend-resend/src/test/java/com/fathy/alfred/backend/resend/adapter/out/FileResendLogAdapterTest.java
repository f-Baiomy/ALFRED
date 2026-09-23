package com.fathy.alfred.backend.resend.adapter.out;

import com.fathy.alfred.backend.resend.domain.model.ResendOutcome;
import com.fathy.alfred.backend.resend.domain.model.ResendRequest;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.test.util.ReflectionTestUtils;

import java.nio.file.Path;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;

class FileResendLogAdapterTest {

    @Test
    void savedRequestRoundTripsThroughFindRequest(@TempDir Path tempDir) {
        FileResendLogAdapter adapter = new FileResendLogAdapter();
        ReflectionTestUtils.setField(adapter, "resendsFile", tempDir.resolve("resends.log").toString());

        ResendRequest request = new ResendRequest("req-1", "call-1", "2026-01-01T00:00:00Z", null);
        adapter.saveRequest(request);

        Optional<ResendRequest> found = adapter.findRequest("req-1");
        assertThat(found).isPresent();
        assertThat(found.get().originalCallId()).isEqualTo("call-1");
    }

    @Test
    void savedOutcomeRoundTripsThroughFindOutcomeByNewCallId(@TempDir Path tempDir) {
        FileResendLogAdapter adapter = new FileResendLogAdapter();
        ReflectionTestUtils.setField(adapter, "resendsFile", tempDir.resolve("resends.log").toString());

        ResendOutcome outcome = new ResendOutcome("out-1", "new-call-1", "req-1", "call-1", "2026-01-01T00:00:00Z");
        adapter.saveOutcome(outcome);

        Optional<ResendOutcome> found = adapter.findOutcomeByNewCallId("new-call-1");
        assertThat(found).isPresent();
        assertThat(found.get().originalCallId()).isEqualTo("call-1");
        assertThat(found.get().resendRequestId()).isEqualTo("req-1");
    }

    @Test
    void findRequestReturnsEmptyWhenFileDoesNotExist(@TempDir Path tempDir) {
        FileResendLogAdapter adapter = new FileResendLogAdapter();
        ReflectionTestUtils.setField(adapter, "resendsFile", tempDir.resolve("missing.log").toString());

        assertThat(adapter.findRequest("anything")).isEmpty();
    }
}
