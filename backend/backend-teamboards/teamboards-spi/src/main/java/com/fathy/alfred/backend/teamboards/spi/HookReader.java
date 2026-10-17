package com.fathy.alfred.backend.teamboards.spi;

import java.util.List;

/** Optional: the item ids a provider's service-hook body names - nothing else of the body is read. */
public interface HookReader {
    List<String> ids(String body);
}
