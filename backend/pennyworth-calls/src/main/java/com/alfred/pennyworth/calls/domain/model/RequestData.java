package com.alfred.pennyworth.calls.domain.model;

import java.util.Map;

public record RequestData(Map<String, String> headers, String body) {
}
