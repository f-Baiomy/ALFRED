package com.fathy.alfred.backend.dbcapture.domain.model;

import com.fasterxml.jackson.annotation.JsonInclude;

/**
 * Where a store command came from when the code did not send it itself (specs/011-redis-capture research R5): for
 * Redis, Spring Cache - its cache name, the operation ({@code @Cacheable}, {@code cache put}, {@code evict},
 * {@code clear}) and the method with its arguments, e.g. {@code FareRuleService.load("EK")}.
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record StoreOrigin(String store, String cache, String operation, String method) {
}
