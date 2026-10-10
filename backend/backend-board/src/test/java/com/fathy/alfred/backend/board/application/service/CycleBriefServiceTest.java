package com.fathy.alfred.backend.board.application.service;

import com.fathy.alfred.backend.board.application.port.in.CreateCardUseCase;
import com.fathy.alfred.backend.board.domain.model.ActivityEntry;
import com.fathy.alfred.backend.board.domain.model.ActivityKind;
import com.fathy.alfred.backend.board.domain.model.Actor;
import com.fathy.alfred.backend.board.domain.model.CardChange;
import com.fathy.alfred.backend.board.domain.model.CardKind;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Path;
import java.util.List;
import java.util.Set;

import static org.assertj.core.api.Assertions.assertThat;

class CycleBriefServiceTest {

    @TempDir
    Path dir;

    private BoardFixture f;

    @BeforeEach
    void setUp() {
        f = new BoardFixture(dir);
    }

    @AfterEach
    void tearDown() throws Exception {
        f.close();
    }

    @Test
    void aBriefIsSavedWithItsMentionsAndClaudeOnlyReadsIt() {
        assertThat(f.briefs.brief("c-1").text()).isEmpty();
        assertThat(f.briefs.putBrief(Actor.USER, "c-1", "ODY-482 @[call:in:z9|POST]").outcome()).isEqualTo(CardChange.Outcome.OK);

        assertThat(f.briefs.brief("c-1").text()).startsWith("ODY-482");
        assertThat(f.board.mentionedLiveCallIds()).containsExactly("z9");
        assertThat(f.briefs.putBrief(Actor.CLAUDE, "c-1", "x").outcome()).isEqualTo(CardChange.Outcome.REFUSED_FOR_CLAUDE);
        assertThat(f.briefs.putBrief(Actor.USER, "c-1", "x".repeat(256 * 1024 + 1)).outcome()).isEqualTo(CardChange.Outcome.INVALID);
    }

    @Test
    void specFileNamesAreCheckedAndOnlyMdAndTxtAreTaken() {
        assertThat(f.briefs.put(Actor.USER, "c-1", "spec.md", "# hi").outcome()).isEqualTo(CardChange.Outcome.OK);
        assertThat(f.briefs.put(Actor.USER, "c-1", "notes.TXT", "x").outcome()).isEqualTo(CardChange.Outcome.OK);
        for (String bad : List.of("spec.pdf", "../x.md", "a/b.md", "a\\b.md", "", "x".repeat(201) + ".md")) {
            var out = f.briefs.put(Actor.USER, "c-1", bad, "x");
            assertThat(out.outcome()).as(bad).isEqualTo(CardChange.Outcome.INVALID);
        }
        assertThat(f.briefs.put(Actor.USER, "c-1", "spec.pdf", "x").message()).contains(".md").contains(".txt");
        assertThat(f.briefs.put(Actor.USER, "c-1", "big.md", "x".repeat(5 * 1024 * 1024 + 1)).outcome()).isEqualTo(CardChange.Outcome.INVALID);
        assertThat(f.briefs.put(Actor.CLAUDE, "c-1", "c.md", "x").outcome()).isEqualTo(CardChange.Outcome.REFUSED_FOR_CLAUDE);
    }

    @Test
    void aCycleHoldsAtMostFiftySpecFilesButReplacingOneIsAlwaysAllowed() {
        for (int i = 0; i < 50; i++) {
            f.briefs.put(Actor.USER, "c-1", "s" + i + ".md", "x");
        }
        assertThat(f.briefs.put(Actor.USER, "c-1", "one-more.md", "x").outcome()).isEqualTo(CardChange.Outcome.INVALID);
        assertThat(f.briefs.put(Actor.USER, "c-1", "s3.md", "y").replaced()).isTrue();
    }

    @Test
    void replacingASpecIsRecordedOnEveryCardThatMentionsIt() {
        f.briefs.put(Actor.USER, "c-1", "spec.md", "v1");
        String mentions = f.add(Actor.USER, "p", CardKind.BUG, "t", "see @[spec:c-1/spec.md#acceptance|spec]").card().id();
        String other = f.add(Actor.USER, "p", CardKind.BUG, "t", "@[spec:c-1/other.md|other]").card().id();

        var out = f.briefs.put(Actor.USER, "c-1", "spec.md", "v2");

        assertThat(out.replaced()).isTrue();
        assertThat(f.briefs.spec("c-1", "spec.md").orElseThrow().content()).isEqualTo("v2");
        assertThat(kinds(mentions)).contains(ActivityKind.SPEC_REPLACED);
        assertThat(kinds(other)).doesNotContain(ActivityKind.SPEC_REPLACED);
    }

    @Test
    void deletingTheCycleRemovesItsBriefAndSpecsButKeepsItsCards() {
        f.briefs.putBrief(Actor.USER, "c-1", "brief @[call:in:z1|x]");
        f.briefs.put(Actor.USER, "c-1", "spec.md", "## Acceptance\n- a");
        String card = f.board.create(Actor.USER, new CreateCardUseCase.NewCard("p", CardKind.BUG, "in cycle", "", Set.of(), "c-1", null,
                List.of())).card().card().id();

        f.briefs.cycleRemoved("c-1");

        assertThat(f.briefs.brief("c-1").text()).isEmpty();
        assertThat(f.briefs.specs("c-1")).isEmpty();
        assertThat(f.board.get(card).orElseThrow().card().cycleDeleted()).isTrue();
        assertThat(f.board.mentionedLiveCallIds()).isEmpty();
    }

    private List<ActivityKind> kinds(String id) {
        return f.board.activity(id, 0, 100).orElseThrow().entries().stream().map(ActivityEntry::kind).toList();
    }
}
