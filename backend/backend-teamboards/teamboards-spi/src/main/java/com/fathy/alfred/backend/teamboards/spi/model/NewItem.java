package com.fathy.alfred.backend.teamboards.spi.model;

/** An item to create in the tracker from an Alfred card (specs/028 FR-052). Description is HTML or Markdown. */
public record NewItem(String project, String type, String title, String description, String area, String iteration, String assignee) {
}
