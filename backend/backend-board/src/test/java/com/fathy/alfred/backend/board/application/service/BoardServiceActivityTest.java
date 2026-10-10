package com.fathy.alfred.backend.board.application.service;

import com.fathy.alfred.backend.board.application.port.in.CommentOnCardUseCase;
import com.fathy.alfred.backend.board.domain.ClaudeRules;
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

import static org.assertj.core.api.Assertions.assertThat;

class BoardServiceActivityTest {

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
    void claudesCommentIsStoredAsDidFoundNextAndImpact() {
        String id = f.add(Actor.USER, "p", CardKind.BUG, "t", "").card().id();

        CommentOnCardUseCase.CommentOutcome out = f.board.comment(Actor.CLAUDE, id,
                new CommentOnCardUseCase.Comment(null, "Read the call", "discount is NULL", "Re-run the cycle", "shared service"));

        assertThat(out.outcome()).isEqualTo(CardChange.Outcome.OK);
        assertThat(out.entry().actor()).isEqualTo(Actor.CLAUDE);
        assertThat(out.entry().text()).isEqualTo("**Did** Read the call\n\n**Found** discount is NULL\n\n**Next** Re-run the cycle"
                + "\n\n**Impact** shared service");
    }

    @Test
    void claudeMayNotPostFreeText() {
        String id = f.add(Actor.USER, "p", CardKind.BUG, "t", "").card().id();

        CommentOnCardUseCase.CommentOutcome out = f.board.comment(Actor.CLAUDE, id,
                new CommentOnCardUseCase.Comment("just text", null, null, null, null));

        assertThat(out.outcome()).isEqualTo(CardChange.Outcome.REFUSED_FOR_CLAUDE);
        assertThat(out.message()).isEqualTo(ClaudeRules.STRUCTURED_COMMENT);
    }

    @Test
    void aCommentHasALimitAndText() {
        String id = f.add(Actor.USER, "p", CardKind.BUG, "t", "").card().id();

        assertThat(f.board.comment(Actor.USER, id, new CommentOnCardUseCase.Comment(" ", null, null, null, null)).outcome())
                .isEqualTo(CardChange.Outcome.INVALID);
        assertThat(f.board.comment(Actor.USER, id, new CommentOnCardUseCase.Comment("x".repeat(BoardService.MAX_TEXT + 1), null, null,
                null, null)).outcome()).isEqualTo(CardChange.Outcome.INVALID);
        assertThat(f.board.comment(Actor.USER, "nope", new CommentOnCardUseCase.Comment("x", null, null, null, null)).outcome())
                .isEqualTo(CardChange.Outcome.NOT_FOUND);
    }

    @Test
    void historyIsShownInFullOldestFirstAndPaged() {
        String id = f.add(Actor.USER, "p", CardKind.BUG, "t", "").card().id();
        for (int i = 0; i < 49; i++) {
            f.board.comment(Actor.USER, id, new CommentOnCardUseCase.Comment("c" + i, null, null, null, null));
        }

        List<ActivityEntry> all = f.board.activity(id, 0, 5000).orElseThrow().entries();

        assertThat(all).hasSize(50);
        assertThat(all.get(0).kind()).isEqualTo(ActivityKind.CREATED);
        assertThat(all.get(49).text()).isEqualTo("c48");
        assertThat(f.board.activity(id, 10, 5).orElseThrow().entries()).hasSize(5);
        assertThat(f.board.activity(id, 0, 5).orElseThrow().total()).isEqualTo(50);
        assertThat(f.board.activity("nope", 0, 5)).isEmpty();
    }
}
