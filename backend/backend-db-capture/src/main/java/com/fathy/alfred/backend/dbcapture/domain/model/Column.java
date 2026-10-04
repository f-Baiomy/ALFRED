package com.fathy.alfred.backend.dbcapture.domain.model;

/** A result column's label and JDBC type name, from ResultSetMetaData. */
public record Column(String name, String type) {
}
