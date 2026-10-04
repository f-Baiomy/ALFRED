package com.fathy.alfred.backend.dbcapture.domain.model;

import com.fasterxml.jackson.annotation.JsonInclude;

/**
 * One parameter or column value as the agent recorded it: its JDBC (or vendor) type name and its text form.
 * {@code value} null is SQL NULL. {@code opaque} marks a vendor object the agent could only {@code toString()};
 * {@code truncatedAt} is set only for a streamed LOB longer than the agent's 16 MB tee, the one value the agent
 * cannot keep whole (research D8). {@code direction} is IN/OUT/INOUT for procedure parameters, null otherwise.
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record TypedValue(String type, String value, Boolean opaque, Long truncatedAt, String direction) {

    public static TypedValue of(String type, String value) {
        return new TypedValue(type, value, null, null, null);
    }
}
