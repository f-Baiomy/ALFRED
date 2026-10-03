package com.fathy.alfred.backend.logs.adapter.out.input;

import com.fathy.alfred.backend.logs.application.port.out.LogFilesPort;
import com.fathy.alfred.backend.logs.domain.ingest.Fingerprints;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.IOException;
import java.io.InputStream;
import java.io.RandomAccessFile;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.regex.Pattern;
import java.util.stream.Stream;

/**
 * The server-logs folder (read-only mount, default /logs) and the upload folder. Path traversal is
 * refused by normalising and checking the result is still under the root (constitution I).
 */
@Component
public class LocalLogFiles implements LogFilesPort {

    private static final org.slf4j.Logger log = org.slf4j.LoggerFactory.getLogger(LocalLogFiles.class);

    private static final Pattern UPLOAD_ID = Pattern.compile("^u[0-9a-f]{16}$");
    private static final int LIST_LIMIT = 1_000;

    @Value("${LOGS_ROOT_DIR:/logs}")
    private String rootDir;
    @Value("${LOGS_UPLOAD_DIR:/appdata/logs/uploads}")
    private String uploadDir;

    private Path root() {
        return Path.of(rootDir).toAbsolutePath().normalize();
    }

    private Path inside(String relative) {
        Path root = root();
        Path p = root.resolve(relative == null ? "" : relative.replace('\\', '/').replaceFirst("^/+", "")).normalize();
        if (!p.startsWith(root)) {
            throw new IllegalArgumentException("Only files under the server logs folder can be read");
        }
        // A symlink inside the folder must not lead outside it: compare real paths once the file exists.
        try {
            if (Files.exists(p) && !p.toRealPath().startsWith(root.toRealPath())) {
                throw new IllegalArgumentException("Only files under the server logs folder can be read");
            }
        } catch (java.io.IOException e) {
            throw new IllegalArgumentException("That path cannot be read");
        }
        return p;
    }

    @Override
    public List<Entry> list(String relativeDir) throws IOException {
        Path dir = inside(relativeDir);
        if (!Files.isDirectory(dir)) {
            return List.of();
        }
        List<Entry> out = new ArrayList<>();
        try (Stream<Path> s = Files.list(dir)) {
            for (Path p : s.sorted(Comparator.comparing(Path::toString)).limit(LIST_LIMIT).toList()) {
                boolean d = Files.isDirectory(p);
                out.add(new Entry(root().relativize(p).toString().replace('\\', '/'), p.getFileName().toString(), d,
                        d ? 0 : Files.size(p)));
            }
        }
        return out;
    }

    @Override
    public String resolveServerFile(String relativePath) {
        Path p = inside(relativePath);
        if (Files.isDirectory(p)) {
            throw new IllegalArgumentException("Choose a file, not a folder");
        }
        return p.toString();
    }

    @Override
    public String fingerprint(String absolutePath) throws IOException {
        return Fingerprints.of(Path.of(absolutePath));
    }

    @Override
    public List<String> head(String absolutePath, int max) throws IOException {
        List<String> out = new ArrayList<>();
        try (BufferedReader r = Files.newBufferedReader(Path.of(absolutePath), StandardCharsets.UTF_8)) {
            String line;
            while (out.size() < max && (line = r.readLine()) != null) {
                if (!line.isBlank()) {
                    out.add(line);
                }
            }
        }
        return out;
    }

    private Path upload(String uploadId) {
        if (uploadId == null || !UPLOAD_ID.matcher(uploadId).matches()) {
            throw new IllegalArgumentException("Not an upload id");
        }
        return Path.of(uploadDir).toAbsolutePath().resolve(uploadId + ".ndjson");
    }

    @Override
    public String uploadPath(String uploadId) {
        return upload(uploadId).toString();
    }

    @Override
    public void writeChunk(String uploadId, long offset, InputStream data, long length) throws IOException {
        Path p = upload(uploadId);
        Files.createDirectories(p.getParent());
        try (RandomAccessFile f = new RandomAccessFile(p.toFile(), "rw")) {
            f.seek(offset);
            byte[] buf = new byte[1 << 16];
            long left = length;
            int n;
            while (left > 0 && (n = data.read(buf, 0, (int) Math.min(buf.length, left))) > 0) {
                f.write(buf, 0, n);
                left -= n;
            }
            if (left != 0) {
                throw new IOException("Chunk ended early");
            }
        }
    }

    @Override
    public String writeUpload(String uploadId, Iterable<String> lines) throws IOException {
        Path p = upload(uploadId);
        Files.createDirectories(p.getParent());
        try (BufferedWriter w = Files.newBufferedWriter(p, StandardCharsets.UTF_8)) {
            for (String line : lines) {
                w.write(line);
                w.write('\n');
            }
        }
        return p.toString();
    }

    @Override
    public void deleteUpload(String uploadId) {
        try {
            Files.deleteIfExists(upload(uploadId));
        } catch (IOException e) {
            // A leftover upload file costs disk, not correctness - the input row is already gone - so warn, do not fail.
            log.warn("Could not delete upload file {}: {}", uploadId, e.getMessage());
        }
    }
}
