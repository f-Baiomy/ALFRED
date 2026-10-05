package com.fathy.alfred.backend.dbcapture.domain;

import com.fathy.alfred.backend.dbcapture.domain.model.CapturedStatement;
import com.fathy.alfred.backend.dbcapture.domain.model.OutcomeKind;
import com.fathy.alfred.backend.dbcapture.domain.model.StatementKind;

import java.util.List;

/**
 * How long a trivial statement takes in this call - the network round trip to the database plus nearly no work - so a
 * statement is called slow for the time it spent beyond that, not for living far from its database. A staging
 * database 55 ms away made every primary-key lookup "slow" under a flat 20 ms threshold, burying the 3-second query.
 *
 * <p>Measured passively, from the call's own statements: the 10th percentile of its successful SELECTs (at least 5 of
 * them; fewer give no baseline). No query is ever run for it. frontend shared/utils/db-analysis.ts mirrors this.
 */
public final class RoundTrip {

    static final int MIN_SAMPLES = 5;

    private RoundTrip() {
    }

    public static long baselineMicros(List<CapturedStatement> statements) {
        long[] durations = statements.stream()
                .filter(s -> s.kind() == StatementKind.SELECT && s.outcome().kind() != OutcomeKind.FAILED)
                .mapToLong(CapturedStatement::durationMicros)
                .sorted()
                .toArray();
        if (durations.length < MIN_SAMPLES) {
            return 0;
        }
        return durations[(int) Math.floor(durations.length * 0.1)];
    }
}
