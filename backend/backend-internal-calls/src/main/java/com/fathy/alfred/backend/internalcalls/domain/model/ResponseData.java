package com.fathy.alfred.backend.internalcalls.domain.model;

import java.util.Map;

public record ResponseData(Integer status, Map<String, String> headers, String body) {
}
