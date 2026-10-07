package com.fathy.alfred.backend.server.application.port.in;

import java.nio.file.Path;
import java.util.List;
import java.util.Map;

/** Docker import (FR-002d): bring a Docker install's .env values into this install's .env. */
public interface MergeDockerEnvUseCase {

    record Outcome(List<String> copied, List<String> dropped) {
    }

    Outcome merge(Map<String, String> dockerEnv, Path dockerFolder);
}
