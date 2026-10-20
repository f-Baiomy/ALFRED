package com.fathy.alfred.backend.teamboards.core.application.service;

import com.fathy.alfred.backend.teamboards.core.application.port.in.TeamException;
import com.fathy.alfred.backend.teamboards.core.application.port.in.TeamException.Code;
import com.fathy.alfred.backend.teamboards.core.application.port.out.TeamCachePort;
import com.fathy.alfred.backend.teamboards.core.application.port.out.TeamCachePort.StoredConnection;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.StateRow;
import com.fathy.alfred.backend.teamboards.spi.AttachmentWriter;
import com.fathy.alfred.backend.teamboards.spi.AttachmentsReader;
import com.fathy.alfred.backend.teamboards.spi.BoardsReader;
import com.fathy.alfred.backend.teamboards.spi.Connector;
import com.fathy.alfred.backend.teamboards.spi.HookReader;
import com.fathy.alfred.backend.teamboards.spi.IdentityReader;
import com.fathy.alfred.backend.teamboards.spi.ItemReader;
import com.fathy.alfred.backend.teamboards.spi.ItemSearcher;
import com.fathy.alfred.backend.teamboards.spi.ItemWriter;
import com.fathy.alfred.backend.teamboards.spi.ProviderException;
import com.fathy.alfred.backend.teamboards.spi.QueryRunner;
import com.fathy.alfred.backend.teamboards.spi.RevisionsReader;
import com.fathy.alfred.backend.teamboards.spi.SeedContributor;
import com.fathy.alfred.backend.teamboards.spi.SprintsReader;
import com.fathy.alfred.backend.teamboards.spi.SquadsReader;
import com.fathy.alfred.backend.teamboards.spi.StateCatalog;
import com.fathy.alfred.backend.teamboards.spi.TreeReader;
import com.fathy.alfred.backend.teamboards.spi.model.Capability;
import com.fathy.alfred.backend.teamboards.spi.model.Connection;
import com.fathy.alfred.backend.teamboards.spi.model.Item;
import com.fathy.alfred.backend.teamboards.spi.model.Token;
import org.springframework.stereotype.Component;

import java.net.URI;
import java.util.ArrayList;
import java.util.Collection;
import java.util.EnumSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.Set;

/**
 * Every live call to a tracker goes through here (specs/028): the connection, its connector, the token from the vault,
 * and a provider failure turned into the user's words. A refused token leaves the vault so the page asks again.
 */
@Component
public class Live {

    private final Map<String, Connector> connectors = new LinkedHashMap<>();
    private final TeamCachePort cache;
    private final TokenVault vault;

    public Live(List<Connector> connectors, TeamCachePort cache, TokenVault vault) {
        for (Connector c : connectors == null ? List.<Connector>of() : connectors) {
            this.connectors.put(c.kind(), c);
        }
        this.cache = cache;
        this.vault = vault;
    }

    /** One live call's context. */
    public record Ctx(StoredConnection stored, Connection connection, Connector connector, Token token) {
        public String id() {
            return stored.id();
        }

        @Override
        public String toString() {
            return "Ctx[" + stored.id() + "]";
        }
    }

    public interface Call<T> {
        T run() throws ProviderException;
    }

    public Map<String, Connector> connectors() {
        return connectors;
    }

    public TokenVault vault() {
        return vault;
    }

    public static Set<Capability> capabilitiesOf(Connector c) {
        Set<Capability> out = EnumSet.of(Capability.CUSTOM_TYPES);
        if (c instanceof BoardsReader) out.add(Capability.BOARDS);
        if (c instanceof SprintsReader) out.add(Capability.SPRINTS);
        if (c instanceof SquadsReader) out.add(Capability.SQUADS);
        if (c instanceof RevisionsReader) out.add(Capability.REVISIONS);
        if (c instanceof AttachmentsReader) out.add(Capability.ATTACHMENTS);
        if (c instanceof SeedContributor) out.add(Capability.SEED);
        if (c instanceof ItemSearcher) out.add(Capability.SEARCH);
        if (c instanceof QueryRunner) out.add(Capability.QUERY);
        if (c instanceof TreeReader) out.add(Capability.TREE);
        if (c instanceof ItemWriter) out.add(Capability.WRITE);
        if (c instanceof AttachmentWriter) out.add(Capability.ATTACH);
        if (c instanceof HookReader) out.add(Capability.HOOK);
        if (c instanceof IdentityReader) out.add(Capability.IDENTITY);
        if (c instanceof StateCatalog) out.add(Capability.STATES);
        return out;
    }

    public static Connection connection(StoredConnection c) {
        return new Connection(c.id(), c.kind(), c.name(), URI.create(c.baseUrl()), c.scope());
    }

    public StoredConnection stored(String conn) {
        return cache.connection(conn).orElseThrow(() -> TeamException.notFound("No such connection " + conn));
    }

    public Optional<Connector> connector(String kind) {
        return Optional.ofNullable(connectors.get(kind));
    }

    public Connector connectorOf(StoredConnection c) {
        Connector k = connectors.get(c.kind());
        if (k == null) {
            throw new TeamException(Code.NOT_SUPPORTED, "The " + c.kind() + " connector is not installed in this Alfred");
        }
        return k;
    }

    /** The context with the vault's token; TOKEN_MISSING when no live token is there. */
    public Ctx ctx(String conn) {
        StoredConnection s = stored(conn);
        Connector k = connectorOf(s);
        Token t = vault.token(conn).orElseThrow(() -> new TeamException(Code.TOKEN_MISSING,
                "No live token for " + s.name() + ": enter your personal access token in the Team tab (Alfred keeps it in memory until you remove it in Me settings)"));
        return new Ctx(s, connection(s), k, t);
    }

    /** The context with a token given now (checking a token before the vault keeps it). */
    public Ctx ctx(String conn, Token token) {
        StoredConnection s = stored(conn);
        return new Ctx(s, connection(s), connectorOf(s), token);
    }

    public Optional<Ctx> ctxIfLive(String conn) {
        if (vault.token(conn).isEmpty() || cache.connection(conn).isEmpty()) {
            return Optional.empty();
        }
        try {
            return Optional.of(ctx(conn));
        } catch (TeamException e) {
            return Optional.empty();
        }
    }

    public <T> T cap(Ctx c, Class<T> type, String what) {
        if (!type.isInstance(c.connector())) {
            throw new TeamException(Code.NOT_SUPPORTED, c.connector().displayName() + " cannot " + what);
        }
        return type.cast(c.connector());
    }

    public <T> T call(Ctx c, Call<T> call) {
        try {
            return call.run();
        } catch (ProviderException e) {
            if (e.kind() == ProviderException.Kind.TOKEN_REJECTED) {
                vault.rejected(c.id(), c.token());
            }
            throw TeamException.of(e);
        }
    }

    /** Items read live, at most {@link ItemReader#MAX} a call; unknown ids are left out. */
    public List<Item> items(Ctx c, Collection<String> ids) {
        List<String> all = new ArrayList<>(new java.util.LinkedHashSet<>(ids));
        if (all.isEmpty()) {
            return List.of();
        }
        if (c.connector() instanceof ItemReader r) {
            List<Item> out = new ArrayList<>();
            for (int i = 0; i < all.size(); i += ItemReader.MAX) {
                List<String> chunk = all.subList(i, Math.min(all.size(), i + ItemReader.MAX));
                out.addAll(call(c, () -> r.items(c.connection(), c.token(), chunk)));
            }
            return out;
        }
        List<Item> out = new ArrayList<>();
        for (String id : all) {
            out.add(call(c, () -> c.connector().item(c.connection(), c.token(), id)));
        }
        return out;
    }

    public Item item(Ctx c, String id) {
        return call(c, () -> c.connector().item(c.connection(), c.token(), id));
    }

    /** The state's category (Proposed, InProgress, Resolved, Completed, Removed) from the cached lists, or null. */
    public String category(String conn, String type, String state) {
        if (state == null) {
            return null;
        }
        String fallback = null;
        for (StateRow r : cache.states(conn)) {
            if (r.name().equalsIgnoreCase(state)) {
                if (type != null && type.equalsIgnoreCase(r.type())) {
                    return r.category();
                }
                fallback = fallback == null ? r.category() : fallback;
            }
        }
        if (fallback != null) {
            return fallback;
        }
        String s = state.toLowerCase(Locale.ROOT);
        if (s.equals("closed") || s.equals("done")) return "Completed";
        if (s.equals("removed")) return "Removed";
        if (s.equals("resolved")) return "Resolved";
        if (s.equals("new") || s.equals("proposed") || s.equals("to do")) return "Proposed";
        return "InProgress";
    }

    public static boolean closed(String category) {
        return "Completed".equalsIgnoreCase(category) || "Removed".equalsIgnoreCase(category);
    }
}
