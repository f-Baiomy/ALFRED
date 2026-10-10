package com.fathy.alfred.backend.board.application.service;

import com.fathy.alfred.backend.board.application.port.in.CommentOnCardUseCase;
import com.fathy.alfred.backend.board.application.port.in.UpdateCardUseCase;
import com.fathy.alfred.backend.board.domain.model.Actor;
import com.fathy.alfred.backend.board.domain.model.CardChange;
import com.fathy.alfred.backend.board.domain.model.CardKind;
import com.fathy.alfred.backend.board.domain.model.MentionRef;
import com.fathy.alfred.backend.board.domain.model.MentionType;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Path;

import static org.assertj.core.api.Assertions.assertThat;

class BoardServiceMentionsTest {

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
    void theLinkedListIsEveryMentionInTextAndCommentsPlusDirectLinks() {
        String id = f.add(Actor.USER, "p", CardKind.BUG, "t", "see @[call:in:a1|POST /orders · 201] and @[stmt:a1/88|INSERT #88]")
                .card().id();
        f.board.comment(Actor.USER, id, new CommentOnCardUseCase.Comment("also @[spec:c-1/spec.md#acceptance|spec §Acceptance]",
                null, null, null, null));
        f.board.link(Actor.USER, id, new MentionRef(MentionType.CYCLE, "c-1", "order-flow-3"));

        assertThat(f.board.get(id).orElseThrow().links()).extracting(MentionRef::ref)
                .containsExactly("in:a1", "a1/88", "c-1/spec.md#acceptance", "c-1");
    }

    @Test
    void rewritingTheDescriptionReplacesItsMentions() {
        String id = f.add(Actor.USER, "p", CardKind.BUG, "t", "@[call:in:a1|x]").card().id();
        f.board.update(Actor.USER, id, new UpdateCardUseCase.CardEdit(null, "now @[call:in:b2|y]", null, null, null, null, null));

        assertThat(f.board.get(id).orElseThrow().links()).extracting(MentionRef::ref).containsExactly("in:b2");
        assertThat(f.board.mentionedLiveCallIds()).containsExactly("b2");
    }

    @Test
    void onlyLiveCallsAreKeptAndEveryChangeOfThemIsAnnounced() {
        int before = f.mentionedCallsChanged;
        String id = f.add(Actor.USER, "p", CardKind.BUG, "t", "@[call:in:live1|x] @[call:out:cap1@c-1|captured]").card().id();
        assertThat(f.mentionedCallsChanged).isEqualTo(before + 1);
        assertThat(f.board.mentionedLiveCallIds()).containsExactly("live1");

        f.board.delete(Actor.USER, id);

        assertThat(f.board.mentionedLiveCallIds()).isEmpty();
        assertThat(f.mentionedCallsChanged).isEqualTo(before + 2);
    }

    @Test
    void aDirectLinkCanBeRemovedAndABadOneIsRefused() {
        String id = f.add(Actor.USER, "p", CardKind.BUG, "t", "").card().id();
        f.board.link(Actor.USER, id, new MentionRef(MentionType.RULE, "r-1", "pricing-mock"));

        assertThat(f.board.unlink(Actor.USER, id, "rule", "r-1").outcome()).isEqualTo(CardChange.Outcome.OK);
        assertThat(f.board.get(id).orElseThrow().links()).isEmpty();
        assertThat(f.board.unlink(Actor.USER, id, "rule", "r-1").outcome()).isEqualTo(CardChange.Outcome.NOT_FOUND);
        assertThat(f.board.link(Actor.USER, id, new MentionRef(MentionType.RULE, "r-1", " ")).outcome()).isEqualTo(CardChange.Outcome.INVALID);
    }

    @Test
    void theFirstCallMentionGivesTheCardItsSignature() {
        f.signatures.put("a1", "5xx|POST /api/orders");
        String id = f.add(Actor.USER, "p", CardKind.BUG, "t", "").card().id();
        assertThat(f.board.get(id).orElseThrow().card().signature()).isNull();

        f.board.comment(Actor.USER, id, new CommentOnCardUseCase.Comment("@[call:in:a1|POST]", null, null, null, null));

        assertThat(f.board.get(id).orElseThrow().card().signature()).isEqualTo("5xx|POST /api/orders");
    }
}
