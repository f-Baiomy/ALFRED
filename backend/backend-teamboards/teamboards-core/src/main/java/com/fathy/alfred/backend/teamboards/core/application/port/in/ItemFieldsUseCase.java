package com.fathy.alfred.backend.teamboards.core.application.port.in;

import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.TemplateRow;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.Who;
import com.fathy.alfred.backend.teamboards.spi.model.FieldInfo;

import java.util.List;
import java.util.Map;

/**
 * specs/038: what a work item type requires and allows (FR-14), named field sets for new items (FR-11), and whether
 * Claude may prepare changes for the tracker at all (G-8). Reading and keeping these writes nothing to the tracker.
 */
public interface ItemFieldsUseCase {

    /** {@code fresh}: ask the tracker again instead of the copy kept for 24 h. */
    List<FieldInfo> fields(String conn, String project, String type, boolean fresh);

    List<TemplateRow> templates(String conn);

    /** Saves (or replaces) a template; Claude saves one only when the user asked. */
    TemplateRow putTemplate(Who who, String conn, String name, String type, Map<String, String> fields);

    boolean deleteTemplate(Who who, String conn, String name);

    boolean claudeMayDraft();

    boolean setClaudeMayDraft(Who who, boolean on);
}
