package com.fathy.alfred.backend.teamboards.core.application.service;

import com.fathy.alfred.backend.teamboards.core.application.port.in.ItemFieldsUseCase;
import com.fathy.alfred.backend.teamboards.core.application.port.in.TeamException;
import com.fathy.alfred.backend.teamboards.core.application.port.out.TeamCachePort;
import com.fathy.alfred.backend.teamboards.core.application.port.out.TeamCallerPort;
import com.fathy.alfred.backend.teamboards.core.application.service.Live.Ctx;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.TemplateRow;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.Who;
import com.fathy.alfred.backend.teamboards.spi.FieldCatalog;
import com.fathy.alfred.backend.teamboards.spi.model.FieldInfo;
import org.springframework.stereotype.Service;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * specs/038: the fields of a work item type (FR-14, kept 24 h per connection, project and type, forgotten when Azure
 * refuses a field), named field sets for new items (FR-11) and the switch that lets Claude prepare changes (G-8).
 */
@Service
public class ItemFieldsService implements ItemFieldsUseCase {

    static final Duration KEPT = Duration.ofHours(24);
    static final int MAX_TEMPLATES = 100;
    /** When Azure last refused a field on a connection: a copy read before it is not trusted. */
    private static final Map<String, Instant> FORGOTTEN = new ConcurrentHashMap<>();
    private final Map<String, Kept> kept = new ConcurrentHashMap<>();

    private record Kept(List<FieldInfo> fields, Instant at) {
    }

    private final Live live;
    private final TeamCachePort cache;
    private final Clock clock;

    @org.springframework.beans.factory.annotation.Autowired
    public ItemFieldsService(Live live, TeamCachePort cache) {
        this(live, cache, Clock.systemUTC());
    }

    ItemFieldsService(Live live, TeamCachePort cache, Clock clock) {
        this.live = live;
        this.cache = cache;
        this.clock = clock;
    }

    /** A refusal may mean the process changed: the next read asks Azure again. */
    static void forget(String conn) {
        FORGOTTEN.put(conn, Instant.now());
    }

    @Override
    public List<FieldInfo> fields(String conn, String project, String type, boolean fresh) {
        if (project == null || project.isBlank() || type == null || type.isBlank()) {
            throw TeamException.invalid("Name the project and the work item type");
        }
        String key = conn + "|" + project.strip().toLowerCase() + "|" + type.strip().toLowerCase();
        Kept k = kept.get(key);
        Instant forgotten = FORGOTTEN.get(conn);
        if (!fresh && k != null && k.at().plus(KEPT).isAfter(clock.instant()) && (forgotten == null || k.at().isAfter(forgotten))) {
            return k.fields();
        }
        Ctx c = live.ctx(conn);
        FieldCatalog catalog = live.cap(c, FieldCatalog.class, "list a type's fields");
        List<FieldInfo> read = live.call(c, () -> catalog.fields(c.connection(), c.token(), project.strip(), type.strip()));
        kept.put(key, new Kept(read, clock.instant()));
        return read;
    }

    @Override
    public List<TemplateRow> templates(String conn) {
        live.stored(conn);
        return cache.templates(conn);
    }

    @Override
    public TemplateRow putTemplate(Who who, String conn, String name, String type, Map<String, String> fields) {
        live.stored(conn);
        String n = name == null ? "" : name.strip();
        if (n.isEmpty() || n.length() > 80) {
            throw TeamException.invalid("A template's name is 1 to 80 characters");
        }
        if (type == null || type.isBlank() || type.length() > 200) {
            throw TeamException.invalid("A template names its work item type");
        }
        if (fields == null || fields.isEmpty() || fields.size() > 60) {
            throw TeamException.invalid("A template holds 1 to 60 fields");
        }
        for (String f : fields.keySet()) {
            if (!AzureWritesService.FIELD_NAME.matcher(f).matches() || AzureWritesService.NOT_A_FIELD_WRITE.contains(f.toLowerCase())) {
                throw TeamException.invalid(f + " is not a field a template can set - use reference names such as Microsoft.VSTS.Common.Activity");
            }
        }
        if (cache.template(conn, n).isEmpty() && cache.templates(conn).size() >= MAX_TEMPLATES) {
            throw TeamException.invalid("At most " + MAX_TEMPLATES + " templates per connection");
        }
        TemplateRow row = new TemplateRow(conn, n, type.strip(), StepPayloads.write(fields), clock.instant());
        cache.putTemplate(row);
        return row;
    }

    @Override
    public boolean deleteTemplate(Who who, String conn, String name) {
        if (who != Who.USER) {
            throw TeamException.userOnly("Only the user deletes a template");
        }
        return cache.deleteTemplate(conn, name == null ? "" : name.strip());
    }

    private org.springframework.beans.factory.ObjectProvider<TeamCallerPort> callers;

    @org.springframework.beans.factory.annotation.Autowired(required = false)
    void setCallers(org.springframework.beans.factory.ObjectProvider<TeamCallerPort> callers) {
        this.callers = callers;
    }

    @Override
    public boolean claudeMayDraft() {
        return !"off".equals(cache.setting(AzureWritesService.CLAUDE_DRAFTS).orElse("on"));
    }

    @Override
    public boolean setClaudeMayDraft(Who who, boolean on) {
        if (who != Who.USER) {
            throw TeamException.userOnly("Only the user decides whether Claude may prepare Azure changes");
        }
        // the switch that holds Claude back is only the user's browser's to turn (specs/038 G-4, G-8)
        TeamCallerPort c = callers == null ? null : callers.getIfAvailable();
        if (c != null) {
            c.refuseDecision().ifPresent(why -> {
                throw TeamException.userOnly(why);
            });
        }
        cache.putSetting(AzureWritesService.CLAUDE_DRAFTS, on ? "on" : "off");
        return on;
    }
}
