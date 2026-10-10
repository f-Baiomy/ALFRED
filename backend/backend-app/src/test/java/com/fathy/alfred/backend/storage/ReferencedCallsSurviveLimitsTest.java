package com.fathy.alfred.backend.storage;

import com.fathy.alfred.backend.comments.application.port.out.CommentsStorePort;
import com.fathy.alfred.backend.interception.application.port.out.StoredAnswersStorePort;
import com.fathy.alfred.backend.interception.domain.model.StoredAnswer;
import com.fathy.alfred.backend.internalcalls.adapter.out.sqlite.SqliteInternalCallsRepository;
import com.fathy.alfred.backend.internalcalls.domain.model.CallRecord;
import com.fathy.alfred.backend.relive.application.port.in.ManageReliveCyclesUseCase;
import com.fathy.alfred.backend.relive.domain.model.ReliveCycle;
import com.fathy.alfred.backend.relive.domain.model.ReliveCycleSummary;
import com.fathy.alfred.backend.relive.domain.model.Step;
import com.fathy.alfred.backend.relive.domain.model.StepSource;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.nio.file.Path;
import java.time.Instant;
import java.util.List;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * End to end through the real inbound SQLite store and its call limit: the oldest call is the one a Relive step was
 * recorded from, the next the one a stored answer was copied from - the limit passes both and trims the next oldest.
 */
class ReferencedCallsSurviveLimitsTest {

    @TempDir
    Path dir;

    @Test
    void theInboundLimitKeepsTheCallsAReliveStepAndAStoredAnswerCameFrom() throws Exception {
        String d = dir.toString() + "/";
        StorageFiles files = new StorageFiles(d + "calls.db", d + "internal-calls.db", d + "c.db", d + "l.db", d + "t.db", d + "s.db",
                d + "m.db", d + "r.db", d + "sc.db", d + "se.db", d + "p.db", d + "re.db", d + "in.db");
        CommentsStorePort comments = mock(CommentsStorePort.class);
        when(comments.findAll()).thenReturn(List.of());

        ManageReliveCyclesUseCase relive = mock(ManageReliveCyclesUseCase.class);
        ReliveCycleSummary summary = mock(ReliveCycleSummary.class);
        when(summary.id()).thenReturn("cyc");
        when(relive.list()).thenReturn(List.of(summary));
        Step step = mock(Step.class);
        when(step.source()).thenReturn(new StepSource("c0", null, "inbound"));
        ReliveCycle cycle = mock(ReliveCycle.class);
        when(cycle.steps()).thenReturn(List.of(step));
        when(relive.get("cyc")).thenReturn(Optional.of(cycle));
        StoredAnswersStorePort answers = mock(StoredAnswersStorePort.class);
        StoredAnswer answer = mock(StoredAnswer.class);
        when(answer.sourceCallId()).thenReturn("c1");
        when(answers.listMeta()).thenReturn(List.of(answer));
        CommentedCallsKept kept = new CommentedCallsKept(comments, files);
        kept.setReferences(relive, answers);

        SqliteInternalCallsRepository repo = new SqliteInternalCallsRepository();
        set(repo, "dbFile", d + "internal-calls.db");
        set(repo, "retentionRows", 3);
        set(repo, "wsMaxMessages", 1000);
        set(repo, "maxSizeBytes", Long.MAX_VALUE);
        Method init = SqliteInternalCallsRepository.class.getDeclaredMethod("init");
        init.setAccessible(true);
        init.invoke(repo);
        repo.setKept(new CommentedCallsKept.Inbound(kept));
        try {
            for (int i = 0; i < 5; i++) {
                String at = Instant.parse("2026-10-10T08:00:00Z").plusSeconds(i).toString();
                repo.prepare(new CallRecord("c" + i, "http://p/x" + i, "http://w/x" + i, "GET", null, at, null, null, null, null));
            }

            assertThat(repo.findById("c0")).as("a Relive step was recorded from it").isPresent();
            assertThat(repo.findById("c1")).as("a stored answer was copied from it").isPresent();
            assertThat(repo.findById("c2")).as("the oldest call nothing uses").isEmpty();
            assertThat(repo.findById("c3")).isEmpty();
            assertThat(repo.findById("c4")).isPresent();
        } finally {
            repo.close();
        }
    }

    private static void set(Object target, String name, Object value) throws Exception {
        Field f = SqliteInternalCallsRepository.class.getDeclaredField(name);
        f.setAccessible(true);
        f.set(target, value);
    }
}
