package com.fathy.alfred.backend.logs.application.service;

import com.fathy.alfred.backend.logs.application.port.in.KeptLogLinesUseCase;
import com.fathy.alfred.backend.logs.application.port.in.LogsException;
import com.fathy.alfred.backend.logs.application.port.in.ManageLogSourcesUseCase;
import com.fathy.alfred.backend.logs.application.port.in.ManageProjectLogsUseCase;
import com.fathy.alfred.backend.logs.application.port.in.QueryLogsUseCase;
import com.fathy.alfred.backend.logs.application.port.out.ProjectLogsStorePort;
import com.fathy.alfred.backend.logs.domain.model.FieldDef;
import com.fathy.alfred.backend.logs.domain.model.KeptLogLine;
import com.fathy.alfred.backend.logs.domain.model.LogQuery;
import com.fathy.alfred.backend.logs.domain.model.LogStructure;
import com.fathy.alfred.backend.logs.domain.model.ProjectLogSettings;
import com.fathy.alfred.backend.logs.domain.model.SearchMode;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;

/**
 * Project log settings and kept lines (specs/008-logs-call-link). Saving switches the thread and call-id fields to
 * the EXACT search mode through the ordinary structure update (the same rebuild a user's change triggers), so the
 * call-logs join reads one index per call instead of scanning.
 */
@Service
public class ProjectLogsService implements ManageProjectLogsUseCase, KeptLogLinesUseCase {

    private final ProjectLogsStorePort store;
    private final ManageLogSourcesUseCase sources;
    private final QueryLogsUseCase query;

    public ProjectLogsService(ProjectLogsStorePort store, ManageLogSourcesUseCase sources, QueryLogsUseCase query) {
        this.store = store;
        this.sources = sources;
        this.query = query;
    }

    @Override
    public List<ProjectLogSettings> readingSource(String sourceId) {
        return store.allSettings().stream().filter(s -> s.sourceIds().contains(sourceId)).toList();
    }

    @Override
    public ProjectLogSettings settings(String project) {
        String name = requireProject(project);
        return store.settings(name).orElseGet(() -> ProjectLogSettings.defaults(name));
    }

    @Override
    public ProjectLogsView view(String project) {
        ProjectLogSettings settings = settings(project);
        return new ProjectLogsView(settings, foundLines(settings));
    }

    @Override
    public ProjectLogsView save(ProjectLogSettings requested) {
        String name = requireProject(requested.project());
        ProjectLogSettings settings = new ProjectLogSettings(name, requested.sourceIds().stream().filter(Objects::nonNull).distinct().toList(),
                requested.threadField(), requested.timeField(), requested.callIdField(), requested.clockSkewMs());
        for (String sourceId : settings.sourceIds()) {
            try {
                sources.get(sourceId);
            } catch (LogsException e) {
                throw LogsException.bad("Unknown log source " + sourceId);
            }
        }
        store.saveSettings(settings);
        for (String sourceId : settings.sourceIds()) {
            makeExact(sourceId, Set.of(Objects.requireNonNullElse(settings.threadField(), ""), settings.callIdField()));
        }
        return new ProjectLogsView(settings, foundLines(settings));
    }

    /** The thread and call-id fields become EXACT (indexed) where the source has them and they are not already. */
    private void makeExact(String sourceId, Set<String> labels) {
        LogStructure structure = sources.structure(sourceId);
        boolean changed = false;
        List<FieldDef> fields = new ArrayList<>();
        for (FieldDef f : structure.fields()) {
            if (labels.contains(f.label()) && f.stored() && f.searchMode() != SearchMode.EXACT) {
                fields.add(f.withSearchMode(SearchMode.EXACT));
                changed = true;
            } else {
                fields.add(f);
            }
        }
        if (changed) {
            sources.updateStructure(sourceId, new LogStructure(structure.id(), fields, structure.groupLevels(), structure.template(),
                    structure.columns(), structure.defaultDataView(), structure.timeZone(), structure.overflowPaths(),
                    structure.payloadPaths(), structure.defaultFieldLayout()));
        }
    }

    /** Per source, lines carrying the call-id field - whether the agent's tag is reaching the log (FR-010). */
    private Map<String, Long> foundLines(ProjectLogSettings settings) {
        Map<String, Long> out = new LinkedHashMap<>();
        for (String sourceId : settings.sourceIds()) {
            boolean known = sources.structure(sourceId).fields().stream().anyMatch(f -> f.label().equals(settings.callIdField()));
            if (!known) {
                out.put(sourceId, 0L);
                continue;
            }
            LogQuery exists = new LogQuery(List.of(new LogQuery.Pill(LogQuery.Op.EXISTS, settings.callIdField(), null, null, null, null)),
                    null, null, null, null, 1);
            out.put(sourceId, query.lines(sourceId, exists).total());
        }
        return out;
    }

    @Override
    public void keep(List<KeptLogLine> lines) {
        store.keep(lines);
    }

    @Override
    public List<KeptLogLine> kept(String callId) {
        return callId == null || callId.isBlank() ? List.of() : store.kept(callId, MAX_KEPT_PER_CALL);
    }

    @Override
    public int remove(Collection<String> callIds, KeptLogLine.Origin origin) {
        return store.removeKept(callIds, origin);
    }

    @Override
    public List<String> callsWithKept(KeptLogLine.Origin origin, int limit) {
        return store.callsWithKept(origin, Math.max(1, Math.min(limit, 10_000)));
    }

    private static String requireProject(String project) {
        if (project == null || project.isBlank() || project.length() > 200) {
            throw LogsException.bad("A project name is required");
        }
        return project.strip();
    }
}
