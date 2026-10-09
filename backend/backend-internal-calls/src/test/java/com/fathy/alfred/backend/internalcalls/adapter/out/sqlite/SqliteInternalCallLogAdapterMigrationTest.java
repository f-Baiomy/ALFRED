package com.fathy.alfred.backend.internalcalls.adapter.out.sqlite;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fathy.alfred.backend.internalcalls.domain.model.CallRecord;
import com.fathy.alfred.backend.internalcalls.domain.model.CallSummary;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

/** The one-time move of internal-calls.log into internal-calls.db (FR-009, research R6). */
class SqliteInternalCallLogAdapterMigrationTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    @TempDir
    Path dir;

    private static Map<String, Object> line(int i) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("id", String.format("legacy-%02d", i));
        m.put("original_url", "http://localhost:9001/legacy/" + i);
        m.put("url", "http://wildfly:8080/legacy/" + i);
        m.put("method", "POST");
        m.put("request", Map.of("headers", Map.of("Content-Type", "application/json"), "body", "{\"i\":" + i + "}"));
        m.put("timestamp", String.format("2026-10-08T10:00:%02d.000+00:00", i));
        m.put("duration_ms", 12.5);
        m.put("response", Map.of("status", 200, "headers", Map.of(), "body", "{\"ok\":" + i + "}"));
        m.put("state", "COMPLETED");
        m.put("service_name", "odeysys");
        return m;
    }

    /** 12 lines: line 3 malformed, line 4 without an id, line 10's call deleted by a Relive run delete. */
    private void writeLegacyFile() throws Exception {
        List<String> lines = new ArrayList<>();
        for (int i = 0; i < 12; i++) {
            Map<String, Object> m = line(i);
            if (i == 3) {
                lines.add("{not json");
                continue;
            }
            if (i == 4) {
                m.remove("id");
            }
            lines.add(JSON.writeValueAsString(m));
        }
        Files.write(dir.resolve("internal-calls.log"), lines);
        Files.writeString(dir.resolve("internal-calls.log.relive-deleted"), "legacy-10\n");
    }

    private List<String> storedIds(SqliteInternalCallLogAdapter adapter) {
        return adapter.query("", "", "oldest", 0, 100, true, "", "", "", "").items().stream().map(CallSummary::id).toList();
    }

    @Test
    void movesTheNewestRetainedValidCallsInOrderAndKeepsTheFileAside() throws Exception {
        writeLegacyFile();
        SqliteInternalCallLogAdapter adapter = SqliteInternalCallsRepositoryTest.adapterOver(
                SqliteInternalCallsRepositoryTest.repository(dir, 5, 1000, Long.MAX_VALUE), dir);
        try {
            List<String> ids = storedIds(adapter);
            // Newest 5 retained lines are 7..11; line 10 was deleted by its run, so 4 calls remain from those lines.
            assertThat(ids).containsExactly("legacy-07", "legacy-08", "legacy-09", "legacy-11");
            CallRecord one = adapter.findById("legacy-11").orElseThrow();
            assertThat(one.request().body()).isEqualTo("{\"i\":11}");
            assertThat(one.response().body()).isEqualTo("{\"ok\":11}");
            assertThat(dir.resolve("internal-calls.log")).doesNotExist();
            assertThat(dir.resolve("internal-calls.log.migrated")).exists();
            assertThat(dir.resolve("internal-calls.log.relive-deleted.migrated")).exists();
        } finally {
            adapter.repository().close();
        }

        SqliteInternalCallLogAdapter again = SqliteInternalCallsRepositoryTest.adapterOver(
                SqliteInternalCallsRepositoryTest.repository(dir, 5, 1000, Long.MAX_VALUE), dir);
        try {
            assertThat(storedIds(again)).containsExactly("legacy-07", "legacy-08", "legacy-09", "legacy-11");
        } finally {
            again.repository().close();
        }
    }

    @Test
    void anIdlessLineGetsAnIdAndAnInterruptedMoveFinishesWithoutDuplicates() throws Exception {
        writeLegacyFile();
        SqliteInternalCallsRepository repo = SqliteInternalCallsRepositoryTest.repository(dir, 100, 1000, Long.MAX_VALUE);
        // A first run that stopped half way: three calls already copied, the file not yet renamed.
        for (String id : List.of("legacy-00", "legacy-01", "legacy-02")) {
            repo.insertMigrated(JSON.readValue(JSON.writeValueAsString(line(Integer.parseInt(id.substring(7)))), CallRecord.class));
        }
        SqliteInternalCallLogAdapter adapter = SqliteInternalCallsRepositoryTest.adapterOver(repo, dir);
        try {
            List<String> ids = storedIds(adapter);
            assertThat(ids).doesNotHaveDuplicates();
            assertThat(ids).hasSize(10); // 12 lines - 1 malformed - 1 deleted
            assertThat(ids).containsSubsequence("legacy-00", "legacy-01", "legacy-02", "legacy-05", "legacy-11");
            assertThat(ids.stream().filter(id -> !id.startsWith("legacy-"))).hasSize(1); // the id-less line, now with one
        } finally {
            repo.close();
        }
    }
}
