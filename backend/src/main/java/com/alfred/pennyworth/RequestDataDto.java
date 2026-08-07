package com.alfred.pennyworth;

import java.util.Map;

public record RequestDataDto(Map<String, String> headers, String body) {
}
