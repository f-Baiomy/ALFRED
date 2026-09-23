package com.fathy.alfred.backend.interception.application.port.out;

import com.fathy.alfred.backend.interception.domain.model.StoredAnswer;

import java.util.List;
import java.util.Optional;

/**
 * Where stored answers live. The body is kept apart from the metadata and read only on demand:
 * every list, every rule editor card and every validation needs the metadata, and none of them
 * should pay for a body that can be 10 MB.
 */
public interface StoredAnswersStorePort {

    void save(StoredAnswer answer, byte[] body);

    Optional<StoredAnswer> findMeta(String id);

    Optional<byte[]> findBody(String id);

    /** Metadata only - an implementation must never read a body to answer this. */
    List<StoredAnswer> listMeta();

    void delete(String id);
}
