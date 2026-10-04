package com.fathy.alfred.backend.logs.adapter.out.input;

import com.fathy.alfred.backend.logs.application.port.out.LineSourcePort;
import org.springframework.stereotype.Component;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.RandomAccessFile;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.BasicFileAttributes;

/**
 * Reads lines from a file on disk - an uploaded file, a file under the /logs mount, or a followed
 * (growing) file. Only complete lines are returned: a half-written last line stays unread until its
 * line break arrives, so a followed file never yields a torn line.
 *
 * <p>Rotation (research §R10): the file's key changed (renamed away and recreated) or its size
 * dropped below the read position (truncated) - reading restarts at 0 under the next generation.
 * A bind mount or network share sends no file events, so {@link #open}'s reader checks by stat.
 */
@Component
public class FileLineSource implements LineSourcePort {

    private static final int BUFFER = 1 << 20;

    @Override
    public Reader open(String path, int generation, long position) throws IOException {
        return new FileReader(Path.of(path), generation, position);
    }

    static final class FileReader implements Reader {

        private final Path path;
        private RandomAccessFile file;
        private Object fileKey;
        private int generation;
        /** Offset of {@code buf[0]} in the file. */
        private long bufStart;
        private final byte[] buf = new byte[BUFFER];
        private int bufLen;
        private int bufPos;
        private final ByteArrayOutputStream pending = new ByteArrayOutputStream();
        private long pendingStart = -1;

        FileReader(Path path, int generation, long position) throws IOException {
            this.path = path;
            this.generation = generation;
            openFile();
            if (file != null) {
                // The file was replaced while ALFRED was down: it is shorter than where we stopped.
                if (file.length() < position) {
                    this.generation++;
                    position = 0;
                }
                file.seek(position);
                bufStart = position;
            }
        }

        private void openFile() throws IOException {
            if (!Files.exists(path)) {
                file = null;
                return;
            }
            file = new RandomAccessFile(path.toFile(), "r");
            fileKey = key();
        }

        private Object key() throws IOException {
            BasicFileAttributes a = Files.readAttributes(path, BasicFileAttributes.class);
            // fileKey() is null on Windows; creation time then stands in for "is this the same file".
            return a.fileKey() != null ? a.fileKey() : a.creationTime();
        }

        @Override
        public RawLine next() throws IOException {
            if (file == null) {
                return null;
            }
            while (true) {
                if (bufPos >= bufLen) {
                    bufStart += bufLen;
                    bufLen = file.read(buf);
                    bufPos = 0;
                    if (bufLen <= 0) {
                        bufLen = 0;
                        return null; // incomplete tail stays in `pending` until its line break arrives
                    }
                }
                int start = bufPos;
                while (bufPos < bufLen && buf[bufPos] != '\n') {
                    bufPos++;
                }
                if (pendingStart < 0) {
                    pendingStart = bufStart + start;
                }
                pending.write(buf, start, bufPos - start);
                if (bufPos < bufLen) {
                    bufPos++; // the '\n'
                    byte[] line = pending.toByteArray();
                    int len = line.length;
                    if (len > 0 && line[len - 1] == '\r') {
                        len--;
                    }
                    byte[] out = len == line.length ? line : java.util.Arrays.copyOf(line, len);
                    long offset = pendingStart;
                    pending.reset();
                    pendingStart = -1;
                    if (out.length == 0) {
                        continue; // blank line: nothing to store
                    }
                    return new RawLine(out, generation, offset, bufStart + bufPos);
                }
            }
        }

        @Override
        public boolean awaitMore(long millis) throws IOException, InterruptedException {
            Thread.sleep(millis);
            if (!Files.exists(path)) {
                return false;
            }
            if (file == null) {
                openFile();
                generation++;
                resetTo(0);
                return true;
            }
            long readUpTo = bufStart + bufLen;
            boolean replaced = !key().equals(fileKey);
            if (replaced && hasUnread()) {
                // Renamed away (rotation) with lines still unread in the old file: finish those first -
                // the open handle still reads the old file - and switch on the next check.
                return true;
            }
            if (replaced || Files.size(path) < readUpTo) {
                file.close();
                openFile();
                generation++;
                resetTo(0);
            }
            return true;
        }

        private void resetTo(long position) throws IOException {
            pending.reset();
            pendingStart = -1;
            bufLen = 0;
            bufPos = 0;
            bufStart = position;
            file.seek(position);
        }

        @Override
        public long size() throws IOException {
            return file == null ? 0 : file.length();
        }

        @Override
        public boolean hasUnread() throws IOException {
            return file != null && (bufPos < bufLen || file.length() > bufStart + bufLen);
        }

        @Override
        public void close() throws IOException {
            if (file != null) {
                file.close();
            }
        }
    }
}
