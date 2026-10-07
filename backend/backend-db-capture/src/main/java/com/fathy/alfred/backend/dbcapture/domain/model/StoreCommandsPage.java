package com.fathy.alfred.backend.dbcapture.domain.model;

import java.util.List;

/**
 * A page of a call's store commands (specs/011-redis-capture contracts/store-commands-api.md): {@code cold} lists the
 * seqs of misses on keys a recorded call wrote earlier whose TTL had run out ("cache cold"); {@code dropped} the
 * commands the agent could not keep. {@code summary} is null when nothing was recorded for the call.
 */
public record StoreCommandsPage(int total, List<StoreCommandSummary> commands, List<Integer> cold, long dropped, CallStoreSummary summary) {
}
