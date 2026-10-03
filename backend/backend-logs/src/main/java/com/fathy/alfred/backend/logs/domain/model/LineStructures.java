package com.fathy.alfred.backend.logs.domain.model;

import java.util.List;
import java.util.Map;

/**
 * The structures found among a source's lines, for the explorer sidebar and the structure editor.
 *
 * @param totalLines lines that have a structure (parsed lines)
 * @param presence   field label → share of all lines that have the field ("seen in X %")
 * @param pending    lines stored before structures existed that are still being sorted in the background
 */
public record LineStructures(List<Item> structures, long totalLines, Map<String, Double> presence, boolean pending) {

    /**
     * @param code     "S2" - what the {@code structure:} filter takes
     * @param name     the user's name, or a generated one after the structure's most telling field
     * @param named    true when the user gave the name
     * @param matching lines of this structure among the current results (null when not asked)
     * @param fields   labels of the fields this structure's lines have
     */
    public record Item(int id, String code, String name, boolean named, String template, long lineCount, Long matching,
                       List<String> fields) {
    }
}
