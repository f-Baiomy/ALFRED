package com.fathy.alfred.backend.board.application.service;

import com.fathy.alfred.backend.board.domain.model.Actor;
import com.fathy.alfred.backend.board.domain.model.CardChange;
import com.fathy.alfred.backend.board.domain.model.ChecklistFile;
import com.fathy.alfred.backend.board.domain.model.ChecklistItem;
import com.fathy.alfred.backend.board.domain.model.Mark;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Path;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

class ChecklistTest {

    private static final String SPEC = "# ODY-482\n## Acceptance\n1. POST /orders returns 201\n2. ORDERS.discount is stored\n## Out of scope\n- x";

    @TempDir
    Path dir;

    private BoardFixture f;

    @BeforeEach
    void setUp() {
        f = new BoardFixture(dir);
        f.briefs.put(Actor.USER, "c-1", "spec.md", SPEC);
    }

    @AfterEach
    void tearDown() throws Exception {
        f.close();
    }

    private List<ChecklistItem> items() {
        List<ChecklistFile> files = f.briefs.checklist("c-1");
        assertThat(files).hasSize(1);
        return files.get(0).items();
    }

    @Test
    void theAcceptanceItemsAreTheChecklistUnmarkedUntilTheUserMarksThem() {
        assertThat(items()).extracting(ChecklistItem::text).containsExactly("POST /orders returns 201", "ORDERS.discount is stored");
        assertThat(items()).allSatisfy(i -> assertThat(i.mark()).isNull());
    }

    @Test
    void aMarkKeepsItsEvidenceAndEveryChange() {
        String key = items().get(1).key();
        f.briefs.mark(Actor.USER, "c-1", "spec.md", key, Mark.FAIL, "@[stmt:a1/88|INSERT #88]");
        f.clock.advanceSeconds(5);
        var out = f.briefs.mark(Actor.USER, "c-1", "spec.md", key, Mark.PASS, "");

        assertThat(out.item().mark().mark()).isEqualTo(Mark.PASS);
        assertThat(out.item().mark().actor()).isEqualTo(Actor.USER);
        assertThat(out.item().mark().history()).extracting(c -> c.mark()).containsExactly(Mark.FAIL, Mark.PASS);
        assertThat(items().get(1).mark().mark()).isEqualTo(Mark.PASS);
    }

    @Test
    void claudeMarksNothingAndUnknownItemsOrHugeEvidenceAreRefused() {
        String key = items().get(0).key();
        assertThat(f.briefs.mark(Actor.CLAUDE, "c-1", "spec.md", key, Mark.PASS, "").outcome()).isEqualTo(CardChange.Outcome.REFUSED_FOR_CLAUDE);
        assertThat(f.briefs.mark(Actor.USER, "c-1", "spec.md", "nope", Mark.PASS, "").outcome()).isEqualTo(CardChange.Outcome.NOT_FOUND);
        assertThat(f.briefs.mark(Actor.USER, "c-1", "spec.md", key, Mark.PASS, "x".repeat(8 * 1024 + 1)).outcome())
                .isEqualTo(CardChange.Outcome.INVALID);
    }

    @Test
    void aReplaceKeepsTheMarksOfUnchangedItemsOnly() {
        List<ChecklistItem> before = items();
        f.briefs.mark(Actor.USER, "c-1", "spec.md", before.get(0).key(), Mark.PASS, "");
        f.briefs.mark(Actor.USER, "c-1", "spec.md", before.get(1).key(), Mark.FAIL, "");

        f.briefs.put(Actor.USER, "c-1", "spec.md", SPEC.replace("ORDERS.discount is stored", "ORDERS.discount is stored with the value"));

        List<ChecklistItem> after = items();
        assertThat(after.get(0).mark().mark()).isEqualTo(Mark.PASS);
        assertThat(after.get(1).mark()).isNull();
    }
}
