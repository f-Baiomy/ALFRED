package com.fathy.alfred.backend.dbcapture.application.port.in;

import com.fathy.alfred.backend.dbcapture.domain.model.KeyHistoryRow;
import com.fathy.alfred.backend.dbcapture.domain.model.KeyPatternRow;
import com.fathy.alfred.backend.dbcapture.domain.model.StoreCommand;
import com.fathy.alfred.backend.dbcapture.domain.model.StoreCommandsPage;

import java.util.Collection;
import java.util.List;
import java.util.Optional;

/** A call's store commands for the window, the Keys view, key history and redis-cli (specs/011-redis-capture). */
public interface GetStoreCommandsUseCase {

    /** At most 500 per page; values of masked keys are masked. */
    StoreCommandsPage commands(String callId, int offset, int limit);

    /** One command opened: decoded values, written-by; {@code raw} adds the stored bytes. */
    Optional<StoreCommand> command(long id, boolean raw);

    List<KeyPatternRow> keys(String callId);

    /** At most 200 rows. */
    List<KeyHistoryRow> keyHistory(String project, String key, int limit);

    /** redis-cli lines for the call's commands ({@code seqs} empty = all). */
    String redisCli(String callId, Collection<Integer> seqs);
}
