package com.fathy.alfred.backend.server.domain.model;

import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Which of two Alfred versions is newer. Versions come from {@code git describe --tags --always --dirty}: a release
 * is {@code 1.4.0} (tag {@code v1.4.0}), a build after it {@code 1.4.0-12-g87159af}, an untagged checkout a bare
 * commit hash ({@code 87159af-dirty}). Only numbers can be ordered; a hash build takes any release as newer, since a
 * dev build is what a server runs before its first release. Nothing here ever treats a hash as newer than a number -
 * the installers refused an upgrade over that once.
 */
public final class VersionOrder {

    private static final Pattern NUMBER = Pattern.compile("^v?(\\d+)\\.(\\d+)(?:\\.(\\d+))?(?:[-+].*)?$");

    private VersionOrder() {
    }

    /** True for 1.4.0, v1.4.0, 1.4, 1.4.0-12-g87159af; false for a bare hash or anything else. */
    public static boolean isNumber(String version) {
        return version != null && NUMBER.matcher(version.strip()).matches();
    }

    /** The release part: "1.4.0-12-g87159af-dirty" -> "1.4.0". Null for a hash. */
    public static String release(String version) {
        Matcher m = NUMBER.matcher(version == null ? "" : version.strip());
        if (!m.matches()) {
            return null;
        }
        return m.group(1) + "." + m.group(2) + "." + (m.group(3) == null ? "0" : m.group(3));
    }

    /**
     * Whether installing {@code candidate} on a server running {@code current} is an update.
     * A build past a release ("1.4.0-12-g…", "1.4.0-dirty") counts as that release: offering 1.4.0 to it would
     * downgrade the server's own newer code.
     */
    public static boolean isNewer(String candidate, String current) {
        String offered = release(candidate);
        if (offered == null) {
            return false;
        }
        String running = release(current);
        if (running == null) {
            return true;
        }
        return compare(offered, running) > 0;
    }

    /** Numeric, part by part: 1.10.0 is after 1.9.0. Both must be numbers ({@link #isNumber}). */
    public static int compare(String a, String b) {
        String[] left = release(a).split("\\.");
        String[] right = release(b).split("\\.");
        for (int i = 0; i < 3; i++) {
            int c = Integer.compare(Integer.parseInt(left[i]), Integer.parseInt(right[i]));
            if (c != 0) {
                return c;
            }
        }
        return 0;
    }

    /** The target name the installers and the manifest use for this machine: windows-x64 or linux-x64. */
    public static String installTarget() {
        String os = System.getProperty("os.name", "").toLowerCase(Locale.ROOT);
        return os.contains("win") ? "windows-x64" : "linux-x64";
    }
}
