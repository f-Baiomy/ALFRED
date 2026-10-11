package com.fathy.alfred.backend.board.application.service;

import com.fathy.alfred.backend.board.application.port.in.CreateCardUseCase;
import com.fathy.alfred.backend.board.application.port.in.ManageTeamsUseCase.TeamEdit;
import com.fathy.alfred.backend.board.domain.DefaultTeams;
import com.fathy.alfred.backend.board.domain.model.ActivityEntry;
import com.fathy.alfred.backend.board.domain.model.ActivityKind;
import com.fathy.alfred.backend.board.domain.model.Actor;
import com.fathy.alfred.backend.board.domain.model.CardChange;
import com.fathy.alfred.backend.board.domain.model.CardDetail;
import com.fathy.alfred.backend.board.domain.model.CardKind;
import com.fathy.alfred.backend.board.domain.model.CardQuery;
import com.fathy.alfred.backend.board.domain.model.Team;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Path;
import java.util.List;
import java.util.Set;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class BoardTeamsTest {

    @TempDir
    Path dir;

    private BoardFixture f;
    private TeamsService teams;

    @BeforeEach
    void setUp() {
        f = new BoardFixture(dir);
        teams = new TeamsService(f.store);
    }

    @AfterEach
    void tearDown() throws Exception {
        f.close();
    }

    private List<ActivityEntry> teamEntries(String id) {
        return f.board.activity(id, 0, 100).orElseThrow().entries().stream().filter(e -> e.kind() == ActivityKind.TEAMS).toList();
    }

    private CardDetail create(Actor actor, String title, String description, List<String> withTeams) {
        CardChange change = f.board.create(actor, new CreateCardUseCase.NewCard("odeysys", CardKind.BUG, title, description, Set.of(),
                null, null, List.of(), withTeams));
        assertThat(change.outcome()).isEqualTo(CardChange.Outcome.OK);
        return change.card();
    }

    @Test
    void aNewBoardStartsWithTheSixDefaultTeamsInOrder() {
        assertThat(teams.teams()).extracting(Team::id).containsExactly("frontend", "backend", "database", "integrations", "devops", "qa");
        assertThat(teams.teams()).allSatisfy(t -> assertThat(t.owns()).isNotBlank());
        assertThat(DefaultTeams.ALL).hasSize(6);
    }

    @Test
    void deletedDefaultTeamsDoNotComeBackWhenTheBoardIsOpenedAgain() throws Exception {
        teams.delete("qa");
        f.close();
        f = new BoardFixture(dir);
        assertThat(new TeamsService(f.store).teams()).extracting(Team::id).doesNotContain("qa").hasSize(5);
    }

    @Test
    void oneCardCanBeAssignedSeveralTeamsByNameOrIdAndEveryChangeIsInItsHistory() {
        CardDetail card = create(Actor.CLAUDE, "Upsell 405", "", List.of("Backend", "frontend"));
        assertThat(card.card().teams()).containsExactly("backend", "frontend");

        CardChange moved = f.board.assignTeams(Actor.USER, card.card().id(), List.of("database"), "It is the INSERT that fails");
        assertThat(moved.card().card().teams()).containsExactly("database");

        List<ActivityEntry> history = teamEntries(card.card().id());
        assertThat(history).extracting(ActivityEntry::actor).containsExactly(Actor.CLAUDE, Actor.USER);
        assertThat(history.get(1).oldValue()).isEqualTo("backend,frontend");
        assertThat(history.get(1).newValue()).isEqualTo("database");
        assertThat(history.get(1).text()).isEqualTo("It is the INSERT that fails");
    }

    @Test
    void claudeMayReassignAnyCardButMustSayWhy() {
        CardDetail usersCard = create(Actor.USER, "Slow search", "", List.of("backend"));
        f.board.move(Actor.USER, usersCard.card().id(), com.fathy.alfred.backend.board.domain.model.CardStatus.TO_DO);

        assertThat(f.board.assignTeams(Actor.CLAUDE, usersCard.card().id(), List.of("database"), " ").outcome())
                .isEqualTo(CardChange.Outcome.INVALID);
        CardChange ok = f.board.assignTeams(Actor.CLAUDE, usersCard.card().id(), List.of("database"), "N+1 on TT_COUNTRY");
        assertThat(ok.outcome()).isEqualTo(CardChange.Outcome.OK);
        assertThat(ok.card().card().teams()).containsExactly("database");
    }

    @Test
    void anUnknownTeamIsRefusedWithTheListOfTeams() {
        CardDetail card = create(Actor.USER, "x", "", List.of());
        CardChange refused = f.board.assignTeams(Actor.USER, card.card().id(), List.of("Mobile"), null);
        assertThat(refused.outcome()).isEqualTo(CardChange.Outcome.INVALID);
        assertThat(refused.message()).contains("Mobile").contains("Backend");
    }

    @Test
    void aCardCreatedWithoutTeamsGetsTheOnesWhoseHintsItsWordsMatch() {
        CardDetail card = create(Actor.USER, "Upsell fails", "Thrown at @[code:src/main/java/com/x/FlightSearchV2.java:39|FlightSearchV2.java:39]"
                + " after the supplier call", null);
        assertThat(card.card().teams()).containsExactly("backend", "integrations");
        assertThat(teamEntries(card.card().id())).singleElement().satisfies(e -> assertThat(e.text()).startsWith("From the teams' hints"));

        CardDetail none = create(Actor.USER, "Typo on a label", "", null);
        assertThat(none.card().teams()).isEmpty();
        assertThat(teamEntries(none.card().id())).isEmpty();
    }

    @Test
    void theBoardFiltersByAnyOfTheAskedTeamsOrByNoTeam() {
        create(Actor.USER, "a", "", List.of("backend"));
        create(Actor.USER, "b", "", List.of("frontend", "backend"));
        create(Actor.USER, "c", "", List.of("qa"));
        create(Actor.USER, "d", "", List.of());

        assertThat(titles(Set.of("backend"))).containsExactlyInAnyOrder("a", "b");
        assertThat(titles(Set.of("frontend", "qa"))).containsExactlyInAnyOrder("b", "c");
        assertThat(titles(Set.of(CardQuery.NO_TEAM))).containsExactly("d");
    }

    private List<String> titles(Set<String> filter) {
        return f.board.query(new CardQuery("odeysys", null, Set.of(), Set.of(), Set.of(), null, false, null, 0, 100, false, null, false, null,
                false, filter)).cards().stream().map(c -> c.card().title()).toList();
    }

    @Test
    void deletingATeamTakesItOffEveryCardAndRenamingKeepsItsId() {
        CardDetail card = create(Actor.USER, "a", "", List.of("frontend", "backend"));
        Team renamed = teams.save(new TeamEdit("backend", "Java services", "#fff", "J", "Java", List.of()));
        assertThat(renamed.id()).isEqualTo("backend");

        teams.delete("frontend");
        assertThat(f.board.get(card.card().id()).orElseThrow().card().teams()).containsExactly("backend");
    }

    @Test
    void aNewTeamGetsAnIdFromItsNameAndDuplicateNamesAreRefused() {
        Team mobile = teams.save(new TeamEdit(null, "Mobile & Apps", null, null, "The iOS and Android apps", List.of("ios")));
        assertThat(mobile.id()).isEqualTo("mobile-apps");
        assertThat(mobile.position()).isEqualTo(6);
        assertThatThrownBy(() -> teams.save(new TeamEdit(null, "mobile & apps", null, null, null, null)))
                .isInstanceOf(IllegalArgumentException.class);

        assertThat(teams.reorder(List.of("qa", "mobile-apps"))).extracting(Team::id).startsWith("qa", "mobile-apps", "frontend");
    }
}
