package com.fathy.alfred.backend.teamboards.spi;

/** How the provider names neutral things: sprint -> "Iteration", squad -> "Team", area -> "Area Path", item -> "Work item". */
public record ProviderWords(String sprint, String squad, String area, String item) {

    public static final ProviderWords NEUTRAL = new ProviderWords("Sprint", "Squad", "Area", "Item");
}
