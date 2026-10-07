package com.fathy.alfred.backend.server.domain.model;

import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;

/**
 * The .env a native install starts with (FR-011): every catalog setting at its default, grouped under the same
 * "# --- Group" headers {@link EnvDocument#set} files new keys under, each with its help text as a comment.
 * WEBHOOK_SECRET is the one value not taken from the defaults: it is generated, so no two installs share it and none
 * runs on the old Docker placeholder.
 */
public final class EnvLayout {

    static final List<String> PREAMBLE = List.of(
            "# Alfred settings (native install). Change them in the Settings tab (from this machine or the local",
            "# network), with `alfred config set KEY VALUE`, or here by hand - then `alfred restart` when a setting",
            "# needs it. A key missing from this file uses its default from settings.properties.");

    private static final SecureRandom RANDOM = new SecureRandom();
    private static final int SECRET_BYTES = 32;

    private EnvLayout() {
    }

    public static EnvDocument fresh(Map<String, String> defaults) {
        List<String> lines = new ArrayList<>(PREAMBLE);
        SettingGroup group = null;
        for (SettingDefinition definition : SettingCatalog.all()) {
            if (definition.group() != group) {
                group = definition.group();
                lines.add("");
                lines.add(group.envHeader());
            }
            lines.add("# " + definition.label() + ": " + definition.help());
            String value = "WEBHOOK_SECRET".equals(definition.key())
                    ? newSecret()
                    : defaults.getOrDefault(definition.key(), "");
            lines.add(definition.key() + "=" + value);
        }
        return EnvDocument.empty().append(lines);
    }

    public static String newSecret() {
        byte[] bytes = new byte[SECRET_BYTES];
        RANDOM.nextBytes(bytes);
        return HexFormat.of().formatHex(bytes);
    }
}
