package com.fathy.alfred.backend.storage;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Path;

import static org.assertj.core.api.Assertions.assertThat;

/** The history's "Auto" lines count what the limits removed - never the page's own deletes again. */
class StorageActivityTest {

    @TempDir
    Path dir;

    @Test
    void countsRemovalsOutsideThePageAndWritesThemHourly() {
        String d = dir.toString() + "/";
        StorageFiles files = new StorageFiles(d + "calls.db", d + "i.db", d + "c.db", d + "l.db", d + "t.db", d + "s.db", d + "m.db",
                d + "r.db", d + "sc.db", d + "se.db", d + "p.db", d + "re.db", d + "in.db");
        StorageActivity activity = new StorageActivity(files);

        activity.removed(true, 40);
        activity.manual(() -> {
            activity.removed(true, 1000);
            return null;
        });
        activity.removed(false, 2);
        activity.flush();

        assertThat(files.history()).extracting(StorageFiles.HistoryEntry::what)
                .containsExactly("2 outbound calls removed by the limits and other deletes",
                        "40 inbound calls removed by the limits and other deletes, with their captured data");
        activity.flush();
        assertThat(files.history()).hasSize(2);
    }
}
