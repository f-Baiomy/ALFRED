package com.fathy.alfred.backend.teamboards.spi.model;

/**
 * An item to create in the tracker from an Alfred card (specs/028 FR-052). Description is HTML or Markdown.
 * {@code parent}: the id of the item it goes under (specs/030: the board's main), or null.
 */
public record NewItem(String project, String type, String title, String description, String area, String iteration, String assignee,
                      String parent) {
    public NewItem(String project, String type, String title, String description, String area, String iteration, String assignee) {
        this(project, type, title, description, area, iteration, assignee, null);
    }
}
