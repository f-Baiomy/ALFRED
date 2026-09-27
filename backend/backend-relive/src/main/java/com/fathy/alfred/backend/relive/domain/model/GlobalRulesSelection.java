package com.fathy.alfred.backend.relive.domain.model;

import java.util.List;

/** Which of ALFRED's global rules participate in a cycle's runs (research D4). */
public record GlobalRulesSelection(String mode, List<String> selectedIds) {
}
