package com.fathy.alfred.backend.dbcapture.domain.model;

import java.util.List;

/**
 * A "log problem": ERROR/WARN lines that mean the same thing across calls - one fingerprint
 * ({@link com.fathy.alfred.backend.dbcapture.domain.LogFingerprint}) - with how often and where it happened.
 * {@code sample} is the newest line of the group; {@code callIds} are up to 200 of its calls, newest first (for the
 * endpoints the bridge derives).
 */
public record LogProblem(String fingerprint, CaughtLogLine sample, long lines, long calls, long firstAtMs, long lastAtMs, List<String> callIds) {
}
