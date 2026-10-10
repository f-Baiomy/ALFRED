package com.fathy.alfred.backend.storage;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Path;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

/** "Stop recording": an endpoint (direction, method, URL without query) is not stored; everything else is. */
class RecordingRulesTest {

    @TempDir
    Path dir;

    @Test
    void aStoppedEndpointIsNotRecordedWhateverItsQuery() {
        String d = dir.toString() + "/";
        StorageFiles files = new StorageFiles(d + "calls.db", d + "i.db", d + "c.db", d + "l.db", d + "t.db", d + "s.db", d + "m.db",
                d + "r.db", d + "sc.db", d + "se.db", d + "p.db", d + "re.db", d + "in.db");
        RecordingRules rules = new RecordingRules(files);
        assertThat(rules.isRecorded("inbound", "GET", "http://h:9001/app/heartbeat?t=1")).isTrue();

        files.saveBudget(new StorageBudget(null, "recommended", Map.of(), 0, 0, 0, Map.of(),
                new StorageBudget.Rules(false, "", 10, 2, true, false, List.of("inbound GET http://h:9001/app/heartbeat", "bad entry"), true))
                .validated());
        rules.refresh();

        assertThat(rules.isRecorded("inbound", "get", "http://h:9001/app/heartbeat?t=2")).isFalse();
        assertThat(rules.isRecorded("inbound", "POST", "http://h:9001/app/heartbeat")).isTrue();
        assertThat(rules.isRecorded("outbound", "GET", "http://h:9001/app/heartbeat")).isTrue();
        assertThat(files.loadBudget().rulesOrDefault().stopRecordingOrEmpty()).containsExactly("inbound GET http://h:9001/app/heartbeat");
    }
}
