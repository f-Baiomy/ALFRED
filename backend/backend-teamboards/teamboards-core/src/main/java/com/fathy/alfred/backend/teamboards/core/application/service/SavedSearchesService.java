package com.fathy.alfred.backend.teamboards.core.application.service;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fathy.alfred.backend.teamboards.core.application.port.in.SavedSearchesUseCase;
import com.fathy.alfred.backend.teamboards.core.application.port.in.TeamException;
import com.fathy.alfred.backend.teamboards.core.application.port.in.TeamException.Code;
import com.fathy.alfred.backend.teamboards.core.application.port.in.TeamSearchUseCase.SearchIn;
import com.fathy.alfred.backend.teamboards.core.application.port.out.TeamCachePort;
import com.fathy.alfred.backend.teamboards.core.application.port.out.TeamChangeSignalPort;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.SavedSearchRow;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.Who;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.time.Clock;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/** Saved searches (specs/029). Nothing here reads the tracker: a pill's click is an ordinary search naming it. */
@Service
public class SavedSearchesService implements SavedSearchesUseCase {

    private final TeamCachePort cache;
    private final TeamChangeSignalPort signals;
    private final Live live;
    private final Clock clock = Clock.systemUTC();

    public SavedSearchesService(TeamCachePort cache, TeamChangeSignalPort signals, Live live) {
        this.cache = cache;
        this.signals = signals;
        this.live = live;
    }

    @Override
    public List<Saved> list(String conn) {
        return cache.savedSearches(conn).stream().map(this::view).toList();
    }

    @Override
    public Saved get(long id) {
        return view(row(id));
    }

    @Override
    public Saved create(Who who, String conn, String name, SearchIn query) {
        userOnly(who);
        live.stored(conn); // the connection exists
        String n = name(name);
        List<SavedSearchRow> all = cache.savedSearches(conn);
        if (all.size() >= MAX_PER_CONNECTION) {
            throw new TeamException(Code.TOO_MANY, "At most " + MAX_PER_CONNECTION + " saved searches a connection - delete one first");
        }
        unique(all, n, 0);
        int position = all.stream().mapToInt(SavedSearchRow::position).max().orElse(-1) + 1;
        SavedSearchRow r = cache.putSavedSearch(new SavedSearchRow(0, conn, n, json(query), position, null, clock.instant()));
        signals.changed(conn, "saved");
        return view(r);
    }

    @Override
    public Saved update(Who who, long id, String name, SearchIn query) {
        userOnly(who);
        SavedSearchRow r = row(id);
        String n = name == null ? r.name() : name(name);
        if (name != null) {
            unique(cache.savedSearches(r.conn()), n, id);
        }
        SavedSearchRow next = new SavedSearchRow(r.id(), r.conn(), n, query == null ? r.queryJson() : json(query), r.position(),
                query == null ? r.lastCount() : null, clock.instant());
        SavedSearchRow saved = cache.putSavedSearch(next);
        signals.changed(r.conn(), "saved");
        return view(saved);
    }

    @Override
    public List<Saved> move(Who who, long id, int by) {
        userOnly(who);
        SavedSearchRow r = row(id);
        List<SavedSearchRow> all = new ArrayList<>(cache.savedSearches(r.conn()));
        int i = indexOf(all, id);
        int j = Math.max(0, Math.min(all.size() - 1, i + Integer.signum(by)));
        if (i != j) {
            all.add(j, all.remove(i));
            cache.orderSavedSearches(r.conn(), all.stream().map(SavedSearchRow::id).toList());
            signals.changed(r.conn(), "saved");
        }
        return list(r.conn());
    }

    @Override
    public boolean delete(Who who, long id) {
        userOnly(who);
        SavedSearchRow r = cache.savedSearch(id).orElse(null);
        if (r == null || !cache.deleteSavedSearch(id)) {
            return false;
        }
        signals.changed(r.conn(), "saved");
        return true;
    }

    @Override
    public void counted(long id, int total) {
        cache.savedSearch(id).ifPresent(r -> {
            if (r.lastCount() == null || r.lastCount() != total) {
                cache.countSavedSearch(id, total);
                signals.changed(r.conn(), "saved");
            }
        });
    }

    // ---------------------------------------------------------------------------------------------------------------

    private static void userOnly(Who who) {
        if (who == Who.CLAUDE) {
            throw TeamException.userOnly("Only the user saves, changes, moves or deletes a saved search - Claude runs them");
        }
    }

    private SavedSearchRow row(long id) {
        return cache.savedSearch(id).orElseThrow(() -> TeamException.notFound("No saved search " + id));
    }

    static String name(String name) {
        String n = name == null ? "" : name.strip().replaceAll("\\s+", " ");
        if (n.isEmpty() || n.length() > MAX_NAME) {
            throw TeamException.invalid("A saved search's name is 1 to " + MAX_NAME + " characters");
        }
        return n;
    }

    private static void unique(List<SavedSearchRow> all, String name, long except) {
        String key = name.toLowerCase(Locale.ROOT);
        if (all.stream().anyMatch(s -> s.id() != except && s.name().toLowerCase(Locale.ROOT).equals(key))) {
            throw new TeamException(Code.CONFLICT, "A saved search is already called \"" + name + "\"");
        }
    }

    private static int indexOf(List<SavedSearchRow> all, long id) {
        for (int i = 0; i < all.size(); i++) {
            if (all.get(i).id() == id) {
                return i;
            }
        }
        throw TeamException.notFound("No saved search " + id);
    }

    /** The search as kept: always page 1 of 50, never naming a saved search itself. */
    private static String json(SearchIn q) {
        SearchIn in = (q == null ? SearchIn.people(null, null, 50) : q).page(0, 50).saved(null);
        try {
            String s = Copies.JSON.writeValueAsString(in);
            if (s.length() > 64_000) {
                throw TeamException.invalid("That search is too big to save");
            }
            return s;
        } catch (JsonProcessingException e) {
            throw TeamException.invalid("That search could not be saved");
        }
    }

    private Saved view(SavedSearchRow r) {
        SearchIn q;
        try {
            q = Copies.JSON.readValue(r.queryJson(), SearchIn.class);
        } catch (IOException e) {
            q = SearchIn.people(null, null, 50);
        }
        return new Saved(r.id(), r.conn(), r.name(), q, r.position(), r.lastCount(), r.updatedAt());
    }
}
