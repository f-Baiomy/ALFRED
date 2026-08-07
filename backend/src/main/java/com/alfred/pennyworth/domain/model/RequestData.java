package com.alfred.pennyworth.domain.model;

import java.util.Map;

public record RequestData(Map<String, String> headers, String body) {
}
