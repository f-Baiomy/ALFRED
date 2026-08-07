package com.alfred.pennyworth.calls.adapter.out.filelog;

import com.alfred.pennyworth.calls.domain.model.CallRecord;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.lang.reflect.Field;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

class FileCallLogAdapterTest {

    @TempDir
    Path tempDir;

    private FileCallLogAdapter adapterFor(Path logFile) throws Exception {
        FileCallLogAdapter adapter = new FileCallLogAdapter();
        Field field = FileCallLogAdapter.class.getDeclaredField("logFile");
        field.setAccessible(true);
        field.set(adapter, logFile.toString());
        return adapter;
    }

    @Test
    void returnsEmptyListWhenTheLogFileDoesNotExist() throws Exception {
        FileCallLogAdapter adapter = adapterFor(tempDir.resolve("missing.log"));

        assertThat(adapter.readAll()).isEmpty();
    }

    @Test
    void parsesEachJsonLineIntoACallRecord() throws Exception {
        Path logFile = tempDir.resolve("calls.log");
        Files.writeString(logFile, """
                {"original_url":"https://a.com-proxy/x","url":"https://a.com/x","method":"GET","timestamp":"t1"}
                {"original_url":"https://b.com-proxy/x","url":"https://b.com/x","method":"POST","timestamp":"t2"}
                """);

        List<CallRecord> calls = adapterFor(logFile).readAll();

        assertThat(calls).hasSize(2);
        assertThat(calls.get(0).method()).isEqualTo("GET");
        assertThat(calls.get(1).method()).isEqualTo("POST");
    }

    @Test
    void skipsMalformedLinesWithoutFailingTheWholeRead() throws Exception {
        Path logFile = tempDir.resolve("calls.log");
        Files.writeString(logFile, """
                {"original_url":"https://a.com-proxy/x","url":"https://a.com/x","method":"GET","timestamp":"t1"}
                not valid json at all
                {"original_url":"https://b.com-proxy/x","url":"https://b.com/x","method":"POST","timestamp":"t2"}

                """);

        List<CallRecord> calls = adapterFor(logFile).readAll();

        assertThat(calls).hasSize(2);
        assertThat(calls).extracting(CallRecord::method).containsExactly("GET", "POST");
    }
}
