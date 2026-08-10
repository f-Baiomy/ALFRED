package com.fathy.alfred.backend.calls.domain.model;

import java.util.Map;

public record ResponseData(Integer status, Map<String, String> headers, String body) {
}
