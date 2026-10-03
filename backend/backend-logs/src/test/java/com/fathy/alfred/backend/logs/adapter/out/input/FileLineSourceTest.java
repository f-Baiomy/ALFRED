package com.fathy.alfred.backend.logs.adapter.out.input;

import com.fathy.alfred.backend.logs.application.port.out.LineSourcePort;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.util.ArrayList;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

/** Complete lines only, resume from a saved position, and rotation by rename and by truncate (FR-006). */
class FileLineSourceTest {

    private final FileLineSource source = new FileLineSource();

    private static void append(Path p, String s) throws Exception {
        Files.writeString(p, s, StandardCharsets.UTF_8, StandardOpenOption.CREATE, StandardOpenOption.APPEND);
    }

    private static List<String> drain(LineSourcePort.Reader r, List<LineSourcePort.RawLine> into) throws Exception {
        List<String> out = new ArrayList<>();
        LineSourcePort.RawLine l;
        while ((l = r.next()) != null) {
            out.add(new String(l.bytes(), StandardCharsets.UTF_8));
            into.add(l);
        }
        return out;
    }

    @Test
    void readsCompleteLinesAndHoldsBackAHalfWrittenOne(@TempDir Path dir) throws Exception {
        Path f = dir.resolve("detail.log");
        append(f, "{\"a\":1}\r\n\n{\"a\":2}\n{\"a\":");
        List<LineSourcePort.RawLine> seen = new ArrayList<>();
        try (var r = source.open(f.toString(), 0, 0)) {
            assertThat(drain(r, seen)).containsExactly("{\"a\":1}", "{\"a\":2}");
            append(f, "3}\n");
            assertThat(drain(r, seen)).containsExactly("{\"a\":3}");
        }
        assertThat(seen.get(0).offset()).isZero();
        assertThat(seen.get(1).offset()).isEqualTo(10);
        assertThat(seen.get(2).offset()).isEqualTo(seen.get(1).nextOffset());
    }

    @Test
    void resumesFromASavedPositionWithoutRepeatingLines(@TempDir Path dir) throws Exception {
        Path f = dir.resolve("detail.log");
        append(f, "one\ntwo\nthree\n");
        List<LineSourcePort.RawLine> seen = new ArrayList<>();
        long position;
        try (var r = source.open(f.toString(), 0, 0)) {
            seen.add(r.next());
            position = seen.get(0).nextOffset();
        }
        try (var r = source.open(f.toString(), 0, position)) {
            assertThat(drain(r, new ArrayList<>())).containsExactly("two", "three");
        }
    }

    @Test
    void followsRotationByTruncateAndByRenameUnderANewGeneration(@TempDir Path dir) throws Exception {
        Path f = dir.resolve("detail.log");
        append(f, "a1\na2\n");
        List<LineSourcePort.RawLine> seen = new ArrayList<>();
        try (var r = source.open(f.toString(), 0, 0)) {
            assertThat(drain(r, seen)).containsExactly("a1", "a2");

            Files.writeString(f, "b1\n"); // truncated and rewritten, shorter than before
            assertThat(r.awaitMore(1)).isTrue();
            assertThat(drain(r, seen)).containsExactly("b1");
            assertThat(seen.get(2).generation()).isEqualTo(1);

            Files.move(f, dir.resolve("detail.log.1"));
            assertThat(r.awaitMore(1)).isFalse(); // missing: the input shows WAITING
            append(f, "c1\n");
            assertThat(r.awaitMore(1)).isTrue();
            assertThat(drain(r, seen)).containsExactly("c1");
            assertThat(seen.get(3).generation()).isEqualTo(2);
            assertThat(seen.get(3).offset()).isZero();
        }
    }

    @Test
    void aShorterFileOnRestartStartsANewGeneration(@TempDir Path dir) throws Exception {
        Path f = dir.resolve("detail.log");
        append(f, "x\n");
        try (var r = source.open(f.toString(), 3, 500)) {
            LineSourcePort.RawLine l = r.next();
            assertThat(l.generation()).isEqualTo(4);
            assertThat(l.offset()).isZero();
        }
    }
}
