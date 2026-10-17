package com.fathy.alfred.backend.board.adapter.out.sqlite;

import com.fasterxml.jackson.databind.json.JsonMapper;
import com.fathy.alfred.backend.board.domain.model.ActivityEntry;
import com.fathy.alfred.backend.board.domain.model.ActivityKind;
import com.fathy.alfred.backend.board.domain.model.Actor;
import com.fathy.alfred.backend.board.domain.model.Card;
import com.fathy.alfred.backend.board.domain.model.CardKind;
import com.fathy.alfred.backend.board.domain.model.CardQuery;
import com.fathy.alfred.backend.board.domain.model.CardStatus;
import com.fathy.alfred.backend.board.domain.model.Flag;
import com.fathy.alfred.backend.board.domain.model.MentionOwner;
import com.fathy.alfred.backend.board.domain.model.MentionRef;
import com.fathy.alfred.backend.board.domain.model.MentionType;
import com.fathy.alfred.backend.board.domain.model.Scope;
import com.fathy.alfred.backend.board.domain.model.SkillRun;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Path;
import java.time.Instant;
import java.util.List;
import java.util.Set;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;

class SqliteBoardRepositoryTest {

    @TempDir
    Path dir;

    private SqliteBoardRepository repo;

    @BeforeEach
    void setUp() {
        repo = new SqliteBoardRepository(JsonMapper.builder().findAndAddModules().build(), dir.resolve("board.db").toString());
        repo.init();
    }

    @AfterEach
    void tearDown() {
        repo.close();
    }

    static Card card(String project, int number, String title, String description) {
        Instant now = Instant.parse("2026-10-10T09:00:00Z");
        return new Card(UUID.randomUUID().toString(), project, number, CardKind.BUG, title, description, CardStatus.INBOX, null, null,
                Set.of(Flag.URGENT), Scope.NOT_DECIDED, Actor.USER, "c-1", false, null, now, now, Actor.USER);
    }

    @Test
    void numbersAreUniquePerProjectAndNeverReusedAfterADelete() {
        int one = repo.nextNumber("odeysys");
        Card first = card("odeysys", one, "first", "");
        repo.insert(first);
        int two = repo.nextNumber("odeysys");
        repo.insert(card("odeysys", two, "second", ""));
        repo.delete(repo.findByNumber("odeysys", two).orElseThrow().id());

        assertThat(one).isEqualTo(1);
        assertThat(two).isEqualTo(2);
        assertThat(repo.nextNumber("odeysys")).isEqualTo(3);
        assertThat(repo.nextNumber("billing")).isEqualTo(1);
    }

    @Test
    void deletingACardTakesItsActivityAndMentionsWithIt() {
        Card c = card("p", repo.nextNumber("p"), "t", "");
        repo.insert(c);
        repo.append(new ActivityEntry(0, c.id(), Actor.USER, ActivityKind.COMMENT, "hi", null, null, Instant.now()));
        repo.replaceMentions(MentionOwner.CARD, c.id(), c.id(), List.of(new MentionRef(MentionType.CALL, "in:abc", "POST /orders")));
        assertThat(repo.mentionedLiveCallIds()).containsExactly("abc");

        repo.delete(c.id());

        assertThat(repo.activityCount(c.id())).isZero();
        assertThat(repo.linksOf(c.id())).isEmpty();
        assertThat(repo.mentionedLiveCallIds()).isEmpty();
    }

    @Test
    void theBoardListNeverCarriesDescriptions() {
        assertThat(SqliteBoardRepository.SUMMARY_COLUMNS).doesNotContain("description");
        Card c = card("p", repo.nextNumber("p"), "t", "a long description");
        repo.insert(c);

        List<Card> rows = repo.query(new CardQuery("p", null, null, null, null, null, false, null, 0, 50));

        assertThat(rows).singleElement().satisfies(r -> assertThat(r.description()).isEmpty());
        assertThat(repo.find(c.id()).orElseThrow().description()).isEqualTo("a long description");
    }

    @Test
    void replacingMentionsTouchesOnlyThatOwner() {
        Card c = card("p", repo.nextNumber("p"), "t", "");
        repo.insert(c);
        repo.replaceMentions(MentionOwner.CARD, c.id(), c.id(), List.of(new MentionRef(MentionType.CYCLE, "c-1", "cycle")));
        repo.replaceMentions(MentionOwner.ACTIVITY, "7", c.id(), List.of(new MentionRef(MentionType.CARD, "p#2", "other")));
        repo.replaceMentions(MentionOwner.CARD, c.id(), c.id(), List.of());

        assertThat(repo.linksOf(c.id())).extracting(MentionRef::ref).containsExactly("p#2");
    }

    @Test
    void capturedCycleCallsAreNotLiveButStillGiveBadges() {
        Card c = card("p", repo.nextNumber("p"), "t", "");
        repo.insert(c);
        repo.replaceMentions(MentionOwner.CARD, c.id(), c.id(), List.of(new MentionRef(MentionType.CALL, "in:x1@c-9", "POST")));

        assertThat(repo.mentionedLiveCallIds()).containsExactly("x1"); // a captured copy keeps its live call (specs/027 R7)
        assertThat(repo.badgesOfCycle("c-9")).containsOnlyKeys("x1");
        assertThat(repo.badgesOfCycle("c-1")).containsOnlyKeys("x1"); // the card's own cycle
        assertThat(repo.badgesOfCalls(List.of("x1", "nope"))).containsOnlyKeys("x1");
    }

    @Test
    void filtersAndSearchNarrowTheList() {
        repo.insert(card("p", repo.nextNumber("p"), "Discount not saved", "ORDERS.discount is NULL"));
        Card task = new Card(UUID.randomUUID().toString(), "p", repo.nextNumber("p"), CardKind.TASK, "Retry email", "", CardStatus.TO_DO,
                null, null, Set.of(), Scope.IN_SCOPE, Actor.CLAUDE, null, false, null, Instant.now(), Instant.now(), Actor.CLAUDE);
        repo.insert(task);

        assertThat(repo.count(new CardQuery("p", null, Set.of(CardKind.TASK), null, null, null, false, null, 0, 10))).isEqualTo(1);
        assertThat(repo.count(new CardQuery("p", null, null, null, Set.of(Flag.URGENT), null, false, null, 0, 10))).isEqualTo(1);
        assertThat(repo.count(new CardQuery("p", null, null, null, null, Actor.CLAUDE, false, null, 0, 10))).isEqualTo(1);
        assertThat(repo.count(new CardQuery("p", null, null, null, null, null, true, null, 0, 10))).isEqualTo(1);
        assertThat(repo.count(new CardQuery("p", null, null, null, null, null, false, "discount%", 0, 10))).isZero();
        assertThat(repo.count(new CardQuery("p", null, null, null, null, null, false, "is null", 0, 10))).isEqualTo(1);
        assertThat(repo.progress("p", null).open()).isEqualTo(2);
    }

    @Test
    void skillRunsRoundTripAndTheQueueIsOldestFirst() {
        Instant t = Instant.parse("2026-10-14T10:00:00Z");
        SkillRun a = new SkillRun("a", "p", "cy", 35, "/alfred-fix 35", "/alfred-fix 35 · Alfred: x", "only the SQL", "opus", null,
                SkillRun.State.QUEUED, null, null, null, true, null, List.of(), false, null, t, null, null, t, "chat-a");
        SkillRun b = new SkillRun("b", "p", null, null, "/alfred-status", "/alfred-status", null, null, "laptop",
                SkillRun.State.SENT, null, null, null, false, null, List.of(), false, null, t.plusSeconds(1), null, null, t.plusSeconds(1), null);
        repo.saveRun(b);
        repo.saveRun(a);

        assertThat(repo.activeRuns("p")).extracting(SkillRun::id).containsExactly("a", "b");
        assertThat(repo.findRun("a")).get().isEqualTo(a);
        assertThat(repo.findRun("b").orElseThrow().cardNumber()).isNull();

        SkillRun done = a.with(SkillRun.State.DONE, "→ plan posted", null, null, "#35 [16]", List.of("reading #35", "planning"), false, "laptop",
                t.plusSeconds(2), t.plusSeconds(40), t.plusSeconds(40));
        repo.saveRun(done);
        assertThat(repo.findRun("a")).get().isEqualTo(done);
        assertThat(repo.activeRuns("p")).extracting(SkillRun::id).containsExactly("b");
        assertThat(repo.runs("p", 35, 10)).extracting(SkillRun::id).containsExactly("a");
        assertThat(repo.runs("p", null, 10)).extracting(SkillRun::id).containsExactly("b", "a");
        assertThat(repo.activeRuns(null)).hasSize(1);

        repo.pruneRuns("p", 1);
        assertThat(repo.runs("p", null, 10)).extracting(SkillRun::id).containsExactly("b");
    }
}
