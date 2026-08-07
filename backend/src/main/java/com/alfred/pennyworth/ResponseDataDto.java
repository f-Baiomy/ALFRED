package com.alfred.pennyworth;

import java.util.Map;

public record ResponseDataDto(Integer status, Map<String, String> headers, String body) {
}
