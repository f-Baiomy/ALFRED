package com.fathy.alfred.backend.calls.adapter.out.filelog;

import com.fathy.alfred.backend.calls.domain.model.CallRecord;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.lang.reflect.Field;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

class FileCallLogAdapterTest {

    @TempDir
    Path tempDir;

    private static final int TEST_MAX_LIMIT = 500;

    private FileCallLogAdapter adapterFor(Path recentCallsFile) throws Exception {
        return adapterFor(recentCallsFile, TEST_MAX_LIMIT);
    }

    private FileCallLogAdapter adapterFor(Path recentCallsFile, int maxLimit) throws Exception {
        FileCallLogAdapter adapter = new FileCallLogAdapter();
        setField(adapter, "recentCallsFile", recentCallsFile.toString());
        setField(adapter, "maxLimit", maxLimit);
        return adapter;
    }

    private static void setField(FileCallLogAdapter adapter, String name, Object value) throws Exception {
        Field field = FileCallLogAdapter.class.getDeclaredField(name);
        field.setAccessible(true);
        field.set(adapter, value);
    }

    private static CallRecord call(String method) {
        return new CallRecord("https://a.com-proxy/x", "https://a.com/x", method, null, "t", 1.0, null, null);
    }

    @Test
    void returnsEmptyListWhenTheFileDoesNotExist() throws Exception {
        FileCallLogAdapter adapter = adapterFor(tempDir.resolve("missing.log"));

        assertThat(adapter.readAll()).isEmpty();
    }

    @Test
    void parsesEachJsonLineIntoACallRecord() throws Exception {
        Path file = tempDir.resolve("RECENT_CALLS.log");
        Files.writeString(file, """
                {"original_url":"https://a.com-proxy/x","url":"https://a.com/x","method":"GET","timestamp":"t1"}
                {"original_url":"https://b.com-proxy/x","url":"https://b.com/x","method":"POST","timestamp":"t2"}
                """);

        List<CallRecord> calls = adapterFor(file).readAll();

        assertThat(calls).hasSize(2);
        assertThat(calls.get(0).method()).isEqualTo("GET");
        assertThat(calls.get(1).method()).isEqualTo("POST");
    }

    @Test
    void skipsMalformedLinesWithoutFailingTheWholeRead() throws Exception {
        Path file = tempDir.resolve("RECENT_CALLS.log");
        Files.writeString(file, """
                {"original_url":"https://a.com-proxy/x","url":"https://a.com/x","method":"GET","timestamp":"t1"}
                not valid json at all
                {"original_url":"https://b.com-proxy/x","url":"https://b.com/x","method":"POST","timestamp":"t2"}

                """);

        List<CallRecord> calls = adapterFor(file).readAll();

        assertThat(calls).hasSize(2);
        assertThat(calls).extracting(CallRecord::method).containsExactly("GET", "POST");
    }

    @Test
    void saveThenReadAllRoundTrips() throws Exception {
        FileCallLogAdapter adapter = adapterFor(tempDir.resolve("RECENT_CALLS.log"));

        adapter.save(call("GET"));
        adapter.save(call("POST"));

        assertThat(adapter.readAll()).extracting(CallRecord::method).containsExactly("GET", "POST");
    }

    @Test
    void saveCreatesTheFileWhenItDoesNotExistYet() throws Exception {
        Path file = tempDir.resolve("nested/dir/RECENT_CALLS.log");
        FileCallLogAdapter adapter = adapterFor(file);

        adapter.save(call("GET"));

        assertThat(file).exists();
        assertThat(adapter.readAll()).hasSize(1);
    }

    @Test
    void persistsAcrossAFreshAdapterInstancePointedAtTheSameFile() throws Exception {
        Path file = tempDir.resolve("RECENT_CALLS.log");
        adapterFor(file).save(call("GET"));

        FileCallLogAdapter secondInstance = adapterFor(file);

        assertThat(secondInstance.readAll()).extracting(CallRecord::method).containsExactly("GET");
    }

    @Test
    void dropsTheOldestLineOnceMaxLimitIsExceeded() throws Exception {
        Path file = tempDir.resolve("RECENT_CALLS.log");
        FileCallLogAdapter adapter = adapterFor(file, 3);

        adapter.save(call("1"));
        adapter.save(call("2"));
        adapter.save(call("3"));
        adapter.save(call("4"));

        assertThat(adapter.readAll()).extracting(CallRecord::method).containsExactly("2", "3", "4");
    }

    @Test
    void neverGrowsPastMaxLimitAcrossManySaves() throws Exception {
        Path file = tempDir.resolve("RECENT_CALLS.log");
        FileCallLogAdapter adapter = adapterFor(file, 5);

        for (int i = 0; i < 20; i++) {
            adapter.save(call("call-" + i));
        }

        List<CallRecord> calls = adapter.readAll();
        assertThat(calls).hasSize(5);
        assertThat(calls).extracting(CallRecord::method).containsExactly("call-15", "call-16", "call-17", "call-18", "call-19");
    }
}
