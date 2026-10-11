package com.fathy.alfred.backend.board.application.service;

import com.fathy.alfred.backend.board.application.port.in.ManageTeamsUseCase;
import com.fathy.alfred.backend.board.application.port.out.BoardStorePort;
import com.fathy.alfred.backend.board.domain.model.Team;
import org.springframework.stereotype.Service;

import java.text.Normalizer;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Optional;

/** Settings → Teams. A team's id is made from its name once and never changes, so renaming keeps every card's teams. */
@Service
public class TeamsService implements ManageTeamsUseCase {

    static final int MAX_TEAMS = 100;
    static final int MAX_NAME = 60;
    static final int MAX_OWNS = 2000;
    static final int MAX_HINTS = 50;

    private final BoardStorePort store;

    public TeamsService(BoardStorePort store) {
        this.store = store;
    }

    @Override
    public List<Team> teams() {
        return store.teams();
    }

    @Override
    public synchronized Team save(TeamEdit edit) {
        String name = edit.name() == null ? "" : edit.name().strip();
        if (name.isEmpty() || name.length() > MAX_NAME) {
            throw new IllegalArgumentException("A team needs a name of 1-" + MAX_NAME + " characters");
        }
        String owns = edit.owns() == null ? "" : edit.owns().strip();
        if (owns.length() > MAX_OWNS) {
            throw new IllegalArgumentException("\"Owns\" is limited to " + MAX_OWNS + " characters");
        }
        List<String> hints = edit.hints() == null ? List.of() : edit.hints();
        if (hints.size() > MAX_HINTS) {
            throw new IllegalArgumentException("At most " + MAX_HINTS + " hints per team");
        }
        List<Team> all = store.teams();
        Optional<Team> existing = edit.id() == null ? Optional.empty() : all.stream().filter(t -> t.id().equals(edit.id())).findFirst();
        if (edit.id() != null && existing.isEmpty()) {
            throw new IllegalArgumentException("No such team");
        }
        boolean taken = all.stream().anyMatch(t -> t.name().equalsIgnoreCase(name) && (existing.isEmpty() || !t.id().equals(existing.get().id())));
        if (taken) {
            throw new IllegalArgumentException("There is already a team called " + name);
        }
        if (existing.isEmpty() && all.size() >= MAX_TEAMS) {
            throw new IllegalArgumentException("At most " + MAX_TEAMS + " teams");
        }
        String id = existing.map(Team::id).orElseGet(() -> freeId(name, all));
        int position = existing.map(Team::position).orElseGet(() -> all.stream().mapToInt(Team::position).max().orElse(-1) + 1);
        Team team = new Team(id, name, edit.color(), edit.icon(), owns, hints, position);
        store.putTeam(team);
        return team;
    }

    @Override
    public synchronized boolean delete(String id) {
        if (store.teams().stream().noneMatch(t -> t.id().equals(id))) {
            return false;
        }
        store.deleteTeam(id);
        return true;
    }

    @Override
    public synchronized List<Team> reorder(List<String> ids) {
        List<Team> all = store.teams();
        List<Team> ordered = new ArrayList<>();
        for (String id : ids == null ? List.<String>of() : ids) {
            all.stream().filter(t -> t.id().equals(id) && !ordered.contains(t)).findFirst().ifPresent(ordered::add);
        }
        all.stream().filter(t -> !ordered.contains(t)).forEach(ordered::add);
        for (int i = 0; i < ordered.size(); i++) {
            Team t = ordered.get(i);
            store.putTeam(new Team(t.id(), t.name(), t.color(), t.icon(), t.owns(), t.hints(), i));
        }
        return store.teams();
    }

    /** "Integrations & APIs" -> "integrations-apis", made unique among the existing ids. */
    static String freeId(String name, List<Team> all) {
        String base = Normalizer.normalize(name, Normalizer.Form.NFKD).toLowerCase(Locale.ROOT)
                .replaceAll("[^a-z0-9]+", "-").replaceAll("(^-|-$)", "");
        if (base.isEmpty()) {
            base = "team";
        }
        String id = base;
        for (int n = 2; isTaken(id, all); n++) {
            id = base + "-" + n;
        }
        return id;
    }

    private static boolean isTaken(String id, List<Team> all) {
        return all.stream().anyMatch(t -> t.id().equals(id));
    }
}
