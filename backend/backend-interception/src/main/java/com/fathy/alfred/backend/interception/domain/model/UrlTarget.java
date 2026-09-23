package com.fathy.alfred.backend.interception.domain.model;

import com.fasterxml.jackson.annotation.JsonIgnore;
import com.fasterxml.jackson.annotation.JsonInclude;

/**
 * REWRITE_URL's structured target: any combination of the four parts. A part left null is kept as
 * the call already has it, so "send /v1 calls to staging" is just {@code host}.
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record UrlTarget(String scheme, String host, Integer port, String path) {

    /** Jackson treats any isX() on a record as a property - without this the snapshot gains an "empty": false. */
    @JsonIgnore
    public boolean isEmpty() {
        return blank(scheme) && blank(host) && port == null && blank(path);
    }

    private static boolean blank(String value) {
        return value == null || value.isBlank();
    }
}
