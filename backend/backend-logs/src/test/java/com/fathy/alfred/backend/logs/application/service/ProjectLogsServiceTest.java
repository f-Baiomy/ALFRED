package com.fathy.alfred.backend.logs.application.service;

import com.fathy.alfred.backend.logs.application.port.in.LogsException;
import com.fathy.alfred.backend.logs.application.port.in.ManageLogSourcesUseCase;
import com.fathy.alfred.backend.logs.application.port.in.QueryLogsUseCase;
import com.fathy.alfred.backend.logs.application.port.out.ProjectLogsStorePort;
import com.fathy.alfred.backend.logs.domain.model.FieldDef;
import com.fathy.alfred.backend.logs.domain.model.FieldType;
import com.fathy.alfred.backend.logs.domain.model.LogPage;
import com.fathy.alfred.backend.logs.domain.model.LogStructure;
import com.fathy.alfred.backend.logs.domain.model.ProjectLogSettings;
import com.fathy.alfred.backend.logs.domain.model.SearchMode;
import com.fathy.alfred.backend.logs.domain.model.TypeSource;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;

import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class ProjectLogsServiceTest {

    private final ProjectLogsStorePort store = mock(ProjectLogsStorePort.class);
    private final ManageLogSourcesUseCase sources = mock(ManageLogSourcesUseCase.class);
    private final QueryLogsUseCase query = mock(QueryLogsUseCase.class);
    private final ProjectLogsService service = new ProjectLogsService(store, sources, query);

    private static FieldDef field(int i, String label, SearchMode mode) {
        return new FieldDef(i, label, label, FieldType.STRING, TypeSource.AUTO, null, 1.0, 0, false, mode, null, false, null, 0, null);
    }

    private static LogStructure structure(List<FieldDef> fields) {
        return new LogStructure("st", fields, List.of(), null, List.of(), null, "UTC", List.of(), List.of(), null);
    }

    @Test
    void defaultsWhenNeverSaved() {
        ProjectLogSettings s = service.settings("odeysys");
        assertThat(s.callIdField()).isEqualTo("mdc.alfred.call");
        assertThat(s.clockSkewMs()).isEqualTo(200);
        assertThat(s.sourceIds()).isEmpty();
    }

    @Test
    void savingMakesTheThreadAndCallIdFieldsExactSearchable_andCountsTaggedLines() {
        when(sources.structure("s1")).thenReturn(structure(List.of(field(0, "process.thread.name", SearchMode.TEXT),
                field(1, "mdc.alfred.call", SearchMode.NONE), field(2, "message", SearchMode.TEXT))));
        when(query.lines(eq("s1"), any())).thenReturn(new LogPage(List.of(), 37, null, 1, false));

        var view = service.save(new ProjectLogSettings("odeysys", List.of("s1", "s1"), "process.thread.name", null, null, 200));

        ArgumentCaptor<LogStructure> saved = ArgumentCaptor.forClass(LogStructure.class);
        verify(sources).updateStructure(eq("s1"), saved.capture());
        assertThat(saved.getValue().fields()).extracting(FieldDef::searchMode)
                .containsExactly(SearchMode.EXACT, SearchMode.EXACT, SearchMode.TEXT);
        assertThat(view.settings().sourceIds()).containsExactly("s1");
        assertThat(view.callIdFoundLines()).containsEntry("s1", 37L);
        verify(store).saveSettings(view.settings());
    }

    @Test
    void anUnknownSourceIsRejected_andNothingIsSaved() {
        when(sources.get("nope")).thenThrow(LogsException.notFound("Log source"));
        assertThatThrownBy(() -> service.save(new ProjectLogSettings("odeysys", List.of("nope"), null, null, null, 200)))
                .isInstanceOf(LogsException.class).hasMessageContaining("Unknown log source");
        verify(store, never()).saveSettings(any());
    }

    @Test
    void outOfRangeSettingsAreRefusedByTheRecord() {
        assertThatThrownBy(() -> new ProjectLogSettings("odeysys", List.of(), null, null, null, 6_000))
                .isInstanceOf(IllegalArgumentException.class);
    }
}
