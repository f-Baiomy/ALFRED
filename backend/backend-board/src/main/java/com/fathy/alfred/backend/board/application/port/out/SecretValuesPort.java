package com.fathy.alfred.backend.board.application.port.out;

import java.util.List;

/**
 * The values a text sent outside Alfred must never carry (specs/037): every value and fallback of a global variable
 * marked secret, as the exports and the MCP replies hide them. Provided by the app; none when nothing is wired.
 */
public interface SecretValuesPort {

    List<String> secretValues();
}
