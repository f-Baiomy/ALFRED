package com.fathy.alfred.backend.teamboards.spi;

import com.fathy.alfred.backend.teamboards.spi.model.Item;
import com.fathy.alfred.backend.teamboards.spi.model.SeedPart;

/** Optional: extra seed parts beyond the neutral fields (e.g. Azure's Repro Steps HTML -> steps). */
public interface SeedContributor {

    SeedPart seed(Item item);
}
