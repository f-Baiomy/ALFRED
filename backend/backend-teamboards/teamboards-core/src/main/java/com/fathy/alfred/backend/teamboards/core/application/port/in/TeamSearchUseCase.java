package com.fathy.alfred.backend.teamboards.core.application.port.in;

import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.ItemView;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.SearchResult;
import com.fathy.alfred.backend.teamboards.spi.model.ItemQuery.Mine;
import com.fathy.alfred.backend.teamboards.spi.model.ItemQuery.Sort;

import com.fasterxml.jackson.annotation.JsonAlias;
import com.fasterxml.jackson.annotation.JsonFormat;

import java.util.List;
import java.util.Set;

/**
 * Live search and live reads (specs/028 US1, FR-010..016, FR-090). Nothing of an answer is stored; each row carries the
 * boards it already sits on (from Alfred's own links). Needs the vault's token (TOKEN_MISSING otherwise).
 */
public interface TeamSearchUseCase {

    int MAX_ITEMS = 200;

    /**
     * The search body (contracts/teamboards-rest.md, specs/029); null lists mean "any", {@code openOnly} null means true.
     * {@code assigned}, {@code createdBy} and {@code parents} take one value or a list (a saved watch rule may hold the
     * older single value; {@code parent} is the older name of {@code parents}). {@code show}: ITEMS (default), PARENTS
     * (each match under its parent chain) or TREE (parents and children); {@code childDepth}: 1 (default) or 0 for every
     * level. {@code saved}: the saved search being run - its pill keeps the count.
     */
    record SearchIn(String text, List<String> types, List<String> states, Boolean openOnly, List<String> areas, Boolean areaExact,
                    List<String> teams, List<String> iterations,
                    @JsonFormat(with = JsonFormat.Feature.ACCEPT_SINGLE_VALUE_AS_ARRAY) List<String> assigned,
                    @JsonFormat(with = JsonFormat.Feature.ACCEPT_SINGLE_VALUE_AS_ARRAY) List<String> createdBy,
                    Integer changedWithinDays, List<String> tags, Boolean tagsAll,
                    @JsonAlias("parent") @JsonFormat(with = JsonFormat.Feature.ACCEPT_SINGLE_VALUE_AS_ARRAY) List<String> parents,
                    Set<Mine> mine, Sort sort, int page, int pageSize, Show show, Integer childDepth, Long saved) {

        /** Only the paging changed. */
        public SearchIn page(int p, int size) {
            return new SearchIn(text, types, states, openOnly, areas, areaExact, teams, iterations, assigned, createdBy, changedWithinDays, tags,
                    tagsAll, parents, mine, sort, p, size, show, childDepth, saved);
        }

        /** The saved search this run is (its pill shows the count), or null. */
        public SearchIn saved(Long id) {
            return new SearchIn(text, types, states, openOnly, areas, areaExact, teams, iterations, assigned, createdBy, changedWithinDays, tags,
                    tagsAll, parents, mine, sort, page, pageSize, show, childDepth, id);
        }

        /** A plain search: these people's open items (or {@code mine}'s). */
        public static SearchIn people(List<String> assigned, Set<Mine> mine, int pageSize) {
            return new SearchIn(null, null, null, true, null, null, null, null, assigned, null, null, null, null, null, mine, null, 0, pageSize,
                    null, null, null);
        }
    }

    /** How a page of matches is shown: alone, under their parents, or with their parents and children. */
    enum Show { ITEMS, PARENTS, TREE }

    /** Parents and children read for one page, at most (the matches themselves are not counted). */
    int MAX_CONTEXT = 500;

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
