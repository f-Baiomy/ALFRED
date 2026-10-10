package com.fathy.alfred.backend.storage;

import org.springframework.stereotype.Component;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Locale;
import java.util.Set;

/**
 * The storage page's "Stop recording" endpoints, asked for every arriving call: a call to one of them is not stored
 * at all. Read from storage-budget.json at most once a second, and only when the file changed, so the webhook path
 * never waits on a file.
 */
@Component
public class RecordingRules {

    private final StorageFiles files;
    private volatile Set<String> stopped = Set.of();
    private volatile long checkedAt;
    private volatile long fileTime = -1;

    RecordingRules(StorageFiles files) {
        this.files = files;
    }

    /** "inbound GET http://host:9001/app/heartbeat" - the URL without its query, as the Biggest tab groups it. */
    static String key(String direction, String method, String url) {
        return direction + " " + (method == null ? "" : method.toUpperCase(Locale.ROOT)) + " " + StorageInsights.path(url);
    }

    public boolean isRecorded(String direction, String method, String url) {
        Set<String> s = current();
        return s.isEmpty() || !s.contains(key(direction, method, url));
    }

    private Set<String> current() {
        long now = System.currentTimeMillis();
        if (now - checkedAt > 1000) {
            checkedAt = now;
            Path file = files.dataDir().resolve("storage-budget.json");
            long time;
            try {
                time = Files.isRegularFile(file) ? Files.getLastModifiedTime(file).toMillis() : 0;
            } catch (java.io.IOException e) {
                time = 0;
            }
            if (time != fileTime) {
                fileTime = time;
                stopped = Set.copyOf(files.loadBudget().rulesOrDefault().stopRecordingOrEmpty());
            }
        }
        return stopped;
    }

    /** After the page saved new rules: read them now, not in up to a second. */
    void refresh() {
        checkedAt = 0;
        fileTime = -1;
    }
}
