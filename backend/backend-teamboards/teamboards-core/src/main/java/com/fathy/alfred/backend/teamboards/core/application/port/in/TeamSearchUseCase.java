package com.fathy.alfred.backend.teamboards.core.application.port.in;

import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.ItemView;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.SearchResult;
import com.fathy.alfred.backend.teamboards.spi.model.ItemQuery.Mine;
import com.fathy.alfred.backend.teamboards.spi.model.ItemQuery.Sort;

import java.util.List;
import java.util.Set;

/**
 * Live search and live reads (specs/028 US1, FR-010..016, FR-090). Nothing of an answer is stored; each row carries the
 * boards it already sits on (from Alfred's own links). Needs the vault's token (TOKEN_MISSING otherwise).
 */
public interface TeamSearchUseCase {

    int MAX_ITEMS = 200;

    /** The search body (contracts/teamboards-rest.md); null lists mean "any", {@code openOnly} null means true. */
    record SearchIn(String text, List<String> types, List<String> states, Boolean openOnly, List<String> areas, List<String> teams,
                    List<String> iterations, String assigned, String createdBy, Integer changedWithinDays, List<String> tags, String parent,
                    Set<Mine> mine, Sort sort, int page, int pageSize) {
    }

    /** What an item read includes besides its fields and relations: comments, history, attachments. */
    enum Part { COMMENTS, HISTORY, ATTACHMENTS }

    SearchResult search(String conn, SearchIn q);

    /** A raw read-only query (Azure: a WIQL SELECT), at most {@code max} (≤ 200) items. */
    SearchResult query(String conn, String query, int max);

    ItemView item(String conn, String id, Set<Part> include);

    /** Many items at once (≤ 200), in the order asked; unknown ids are left out. */
    List<ItemView> items(String conn, List<String> ids, Set<Part> include);

    record FileBytes(String name, String mime, byte[] data) {
    }

    /** One attachment's content, read live (≤ 10 MB). */
    FileBytes attachment(String conn, String id, String name);
}
