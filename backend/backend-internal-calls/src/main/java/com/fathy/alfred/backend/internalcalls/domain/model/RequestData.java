package com.fathy.alfred.backend.internalcalls.domain.model;

import java.util.Map;

public record RequestData(Map<String, String> headers, String body) {
}
