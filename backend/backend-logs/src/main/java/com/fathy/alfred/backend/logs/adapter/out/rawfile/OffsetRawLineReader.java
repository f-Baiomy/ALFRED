package com.fathy.alfred.backend.logs.adapter.out.rawfile;

import com.fathy.alfred.backend.logs.application.port.out.RawLineReaderPort;
import com.fathy.alfred.backend.logs.domain.ingest.Fingerprints;
import org.springframework.stereotype.Component;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.RandomAccessFile;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Optional;

/**
 * Positions-only mode (FR-005): reads one line back from the original file. Before trusting the
 * offset it checks the file still starts with the same first megabyte it had when loaded - a
 * replaced or rewritten file would otherwise return some other line as if it were this one.
 */
@Component
public class OffsetRawLineReader implements RawLineReaderPort {

    @Override
    public Optional<String> read(String path, String fingerprint, long byteOffset) {
        Path p = Path.of(path);
        try {
            if (!Files.exists(p) || (fingerprint != null && !Fingerprints.sameHead(fingerprint, Fingerprints.of(p)))) {
                return Optional.empty();
            }
            try (RandomAccessFile f = new RandomAccessFile(p.toFile(), "r")) {
                if (byteOffset >= f.length()) {
                    return Optional.empty();
                }
                f.seek(byteOffset);
                ByteArrayOutputStream out = new ByteArrayOutputStream();
                byte[] buf = new byte[64 * 1024];
                int n;
                outer:
                while ((n = f.read(buf)) > 0) {
                    for (int i = 0; i < n; i++) {
                        if (buf[i] == '\n') {
                            out.write(buf, 0, i);
                            break outer;
                        }
                    }
                    out.write(buf, 0, n);
                }
                String line = out.toString(StandardCharsets.UTF_8);
                return Optional.of(line.endsWith("\r") ? line.substring(0, line.length() - 1) : line);
            }
        } catch (IOException e) {
            return Optional.empty();
        }
    }
}
