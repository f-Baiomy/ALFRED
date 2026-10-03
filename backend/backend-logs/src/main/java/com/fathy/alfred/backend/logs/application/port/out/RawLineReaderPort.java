package com.fathy.alfred.backend.logs.application.port.out;

import java.util.Optional;

/** Reads one raw line back from an original file (positions-only mode, FR-005). */
public interface RawLineReaderPort {

    /** @return the line, or empty when the file is missing or no longer matches its fingerprint */
    Optional<String> read(String path, String fingerprint, long byteOffset);
}
