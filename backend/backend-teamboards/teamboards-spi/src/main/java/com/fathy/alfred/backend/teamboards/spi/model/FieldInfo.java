package com.fathy.alfred.backend.teamboards.spi.model;

import java.util.List;

/**
 * A field of a work item type (specs/038 FR-14): its reference name, display name, type ("string", "double",
 * "identity"...), whether the type requires it, whether the tracker keeps it itself, the values it allows (empty: any)
 * and its default.
 */
public record FieldInfo(String ref, String name, String type, boolean required, boolean readOnly, List<String> allowed, String defaultValue) {
    public FieldInfo {
        allowed = allowed == null ? List.of() : List.copyOf(allowed);
    }
}
