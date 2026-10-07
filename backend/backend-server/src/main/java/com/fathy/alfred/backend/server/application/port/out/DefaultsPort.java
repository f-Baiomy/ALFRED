package com.fathy.alfred.backend.server.application.port.out;

import java.util.Map;

/**
 * The default of every setting, from settings.properties' {@code key=${ENV_NAME:default}} lines (FR-012): the one
 * place defaults live. Keyed by the .env name ({@code ENV_NAME}).
 */
public interface DefaultsPort {

    Map<String, String> defaults();
}
