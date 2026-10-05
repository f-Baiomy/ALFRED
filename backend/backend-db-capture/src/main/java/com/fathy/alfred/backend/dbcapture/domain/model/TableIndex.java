package com.fathy.alfred.backend.dbcapture.domain.model;

import java.util.List;

/** One index of a table, from database metadata (the agent's opt-in Index check): name, unique, columns in order. */
public record TableIndex(String name, boolean unique, List<String> columns) {
}
