package com.fathy.alfred.backend.teamboards.spi.model;

/** A work item type the provider knows, custom ones included ("Meeting", "Thread"...). */
public record ItemTypeInfo(String name, boolean custom) {
}
