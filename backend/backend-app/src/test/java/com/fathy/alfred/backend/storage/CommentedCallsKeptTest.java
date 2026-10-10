package com.fathy.alfred.backend.storage;

import com.fathy.alfred.backend.comments.application.port.out.CommentsStorePort;
import com.fathy.alfred.backend.comments.domain.model.Comment;
import com.fathy.alfred.backend.interception.application.port.out.StoredAnswersStorePort;
import com.fathy.alfred.backend.interception.domain.model.StoredAnswer;
import com.fathy.alfred.backend.relive.application.port.in.ManageReliveCyclesUseCase;
import com.fathy.alfred.backend.relive.domain.model.ReliveCycle;
import com.fathy.alfred.backend.relive.domain.model.ReliveCycleSummary;
import com.fathy.alfred.backend.relive.domain.model.Step;
import com.fathy.alfred.backend.relive.domain.model.StepSource;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/** What no limit or clean-up deletes: a call with a comment, a Relive step's source, a stored answer's source. */
class CommentedCallsKeptTest {

    @TempDir
    Path dir;

    private StorageFiles files() {
        String d = dir.toString() + "/";
        return new StorageFiles(d + "calls.db", d + "i.db", d + "c.db", d + "l.db", d + "t.db", d + "s.db", d + "m.db",
                d + "r.db", d + "sc.db", d + "se.db", d + "p.db", d + "re.db", d + "in.db");
    }

    @Test
    void keepsCommentedCallsAndTheSourcesOfReliveStepsAndStoredAnswers() {
        CommentsStorePort comments = mock(CommentsStorePort.class);
        when(comments.findAll()).thenReturn(List.of(new Comment("c", "commented", "body", 0, "x", "n", "t")));
        ManageReliveCyclesUseCase relive = mock(ManageReliveCyclesUseCase.class);
        ReliveCycleSummary summary = mock(ReliveCycleSummary.class);
        when(summary.id()).thenReturn("cyc");
        when(relive.list()).thenReturn(List.of(summary));
        Step step = mock(Step.class);
        when(step.source()).thenReturn(new StepSource("recorded-from", null, "inbound"));
        ReliveCycle cycle = mock(ReliveCycle.class);
        when(cycle.steps()).thenReturn(List.of(step));
        when(relive.get("cyc")).thenReturn(Optional.of(cycle));
        StoredAnswersStorePort answers = mock(StoredAnswersStorePort.class);
        StoredAnswer answer = mock(StoredAnswer.class);
        when(answer.sourceCallId()).thenReturn("answered-from");
        when(answers.listMeta()).thenReturn(List.of(answer));
        CommentedCallsKept kept = new CommentedCallsKept(comments, files());
        kept.setReferences(relive, answers);

        assertThat(kept.kept()).containsExactlyInAnyOrder("commented", "recorded-from", "answered-from");
    }

    @Test
    void theRuleTurnedOffKeepsNothing() {
        StorageFiles files = files();
        files.saveBudget(new StorageBudget(null, "recommended", Map.of(), 0, 0, 0, Map.of(),
                new StorageBudget.Rules(false, "", 10, 2, true, false, List.of(), false)));
        CommentsStorePort comments = mock(CommentsStorePort.class);
        when(comments.findAll()).thenReturn(List.of(new Comment("c", "commented", "body", 0, "x", "n", "t")));

        assertThat(new CommentedCallsKept(comments, files).kept()).isEmpty();
    }
}
