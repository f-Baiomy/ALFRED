package com.fathy.alfred.backend.logs.application.port.out;

import com.fathy.alfred.backend.logs.domain.model.FieldDef;
import com.fathy.alfred.backend.logs.domain.model.FieldStats;
import com.fathy.alfred.backend.logs.domain.model.FieldValues;
import com.fathy.alfred.backend.logs.domain.model.GroupNode;
import com.fathy.alfred.backend.logs.domain.model.Histogram;
import com.fathy.alfred.backend.logs.domain.model.LineRecord;
import com.fathy.alfred.backend.logs.domain.model.LineShape;
import com.fathy.alfred.backend.logs.domain.model.LogLine;
import com.fathy.alfred.backend.logs.domain.model.LogLineSummary;
import com.fathy.alfred.backend.logs.domain.model.LogPage;
import com.fathy.alfred.backend.logs.domain.model.LogQuery;
import com.fathy.alfred.backend.logs.domain.model.LogStructure;
import com.fathy.alfred.backend.logs.domain.model.Minimap;
import com.fathy.alfred.backend.logs.domain.model.Pattern;

import java.util.List;
import java.util.Optional;
import java.util.function.Consumer;

/**
 * Every read and write of log lines, expressed in {@link LogQuery} terms so a later document-database
 * adapter replaces this port's implementation only (FR-037). Field arguments are {@link FieldDef}s;
 * the adapter decides how they are stored.
 */
public interface LogLineStorePort {

    void createSource(String sourceId);

    void dropSource(String sourceId);

    /** Adds storage for fields not stored yet (a new field seen mid-file, FR-010). */
    void ensureFields(String sourceId, List<FieldDef> fields);

    /**
     * A batch of lines plus the patterns it created or widened, the current totals of the structures
     * its lines joined, and the input position - stored in one transaction.
     */
    record Batch(List<LineRecord> lines, List<Pattern> patternUpserts, List<LineShape> shapeUpserts, String inputId,
                 long inputPosition, long inputLines, long unparsed) {
    }

    /**
     * Stores the lines, their trigram text and group aggregates, upserts the patterns, and moves the
     * input's position and the source's counts - all in one transaction, so a crash mid-batch
     * resumes from the last committed position with no loss and no duplicates (FR-006).
     *
     * @return the number of lines actually inserted (a line already stored is skipped)
     */
    int append(String sourceId, LogStructure structure, Batch batch);

    LogPage query(String sourceId, LogStructure structure, LogQuery query, List<FieldDef> summaryFields);

    Optional<LogLine> get(String sourceId, LogStructure structure, String lineId);

    List<LogLineSummary> context(String sourceId, LogStructure structure, String lineId, int before, int after,
                                 List<FieldDef> summaryFields);

    Histogram histogram(String sourceId, LogStructure structure, LogQuery query, int buckets);

    FieldValues fieldValues(String sourceId, LogStructure structure, LogQuery query, List<FieldDef> fields, int window, int top);

    FieldStats fieldStats(String sourceId, LogStructure structure, LogQuery query, FieldDef field, int window);

    Minimap minimap(String sourceId, LogStructure structure, LogQuery query, List<LogQuery.Pill> condition, int buckets, long sampleAbove);

    /** Lines whose value of any of {@code correlation} (a role can list several fields) equals {@code value}. */
    List<LogLineSummary> trace(String sourceId, LogStructure structure, List<FieldDef> correlation, String value, int limit,
                               List<FieldDef> summaryFields);

    /** Child nodes of {@code parentPath} at {@code level}; with filters, aggregates cover matching lines only. */
    List<GroupNode> groups(String sourceId, LogStructure structure, LogQuery query, String parentPath, int level,
                           int offset, int limit, List<FieldDef> summaryFields);

    /**
     * One group node's own lines, keyset-paged in time order, so every line is reachable (FR-023):
     * {@code skipped=false} = lines at exactly this level with these IDs (head + siblings),
     * {@code skipped=true} = lines that jump a level and hang on this node.
     */
    LogPage nodeLines(String sourceId, LogStructure structure, LogQuery query, String path, int level, boolean skipped,
                      List<FieldDef> summaryFields);

    /** Lines whose value of {@code field} did not fit its type (kept as text, FR-012), newest first. */
    List<LogLineSummary> invalidValues(String sourceId, FieldDef field, int limit, List<FieldDef> summaryFields);

    /** Lines without the first level ID (the "No ‹field›" bucket). */
    LogPage bucket(String sourceId, LogStructure structure, LogQuery query, List<FieldDef> summaryFields);

    List<Pattern> patterns(String sourceId, LogStructure structure, LogQuery query, int limit);

    List<Pattern> storedPatterns(String sourceId);

    long pin(String sourceId, LogStructure structure, LogQuery selection);

    void pinOne(String sourceId, String lineId);

    long countMatching(String sourceId, LogStructure structure, LogQuery query);

    List<String> matchingIds(String sourceId, LogStructure structure, LogQuery query, int max);

    /**
     * Deletes the oldest unpinned lines until stored bytes drop under {@code targetBytes}.
     * Commented/pinned lines are never removed (FR-009).
     *
     * @return {deleted lines, deleted bytes}
     */
    long[] applyRetention(String sourceId, long currentBytes, long targetBytes);

    long[] counts(String sourceId);

    long pinnedCount(String sourceId);

    long deleteInput(String sourceId, String inputId);

    // ---- structures of lines (FR-045 as amended) ----

    /** Every structure found among the source's lines, with its counts and user settings. */
    List<LineShape> shapes(String sourceId);

    /** Lines per structure among the lines matching {@code query}. */
    java.util.Map<Integer, Long> shapeCounts(String sourceId, LogStructure structure, LogQuery query);

    /** A structure's name and summary template (null/blank = automatic name / the source's template). */
    void saveShapeSettings(String sourceId, int shapeId, String name, String template);

    /** Writes the given structure totals (lines, field counts, field set); name and template are kept. */
    void upsertShapes(String sourceId, List<LineShape> shapes);

    /** Recounts every structure from the stored lines (after lines were deleted). */
    void recountShapes(String sourceId, List<FieldDef> storedFields);

    /** Streams the raw lines of one structure (COPY mode), oldest first, for "move to its own source". */
    void forEachShapeRaw(String sourceId, int shapeId, Consumer<String> consumer);

    long deleteShape(String sourceId, int shapeId);

    /** True while some parsed lines have no structure yet (the background sorting is not finished). */
    boolean hasUnshaped(String sourceId);

    /** Lines stored before structures existed: shape not set yet; {@code mismatch} lines also lack their own fields. */
    void forEachUnshaped(String sourceId, List<FieldDef> fields, int chunk, Consumer<List<StoredRow>> consumer);

    /** Sets the structure of lines (and clears the old "different structure" flag). */
    void setShapes(String sourceId, java.util.Map<Long, Integer> shapeByRid);

    /** Rewrites the stored fields, trigram text and structure of lines re-read from their raw text. */
    void rewriteLines(String sourceId, LogStructure structure, List<Rewrite> rows);

    record Rewrite(long rid, java.util.Map<Integer, String> text, java.util.Map<Integer, Object> typed, String ftsText, int shape) {
    }

    // ---- background rebuilds (research §R6) ----

    /** Visits stored lines in chunks: original text of {@code fields} by index, raw when stored. */
    void forEachChunk(String sourceId, List<FieldDef> fields, int chunk, Consumer<List<StoredRow>> consumer);

    /** @param mismatch stored before every line's own fields were registered: may lack some of them */
    record StoredRow(long rid, String lineId, java.util.Map<Integer, String> text, String raw, boolean mismatch) {
    }

    void updateTyped(String sourceId, FieldDef field, List<Long> rids, List<Object> values);

    void updateDerived(String sourceId, List<Derived> rows);

    record Derived(long rid, long ts, String level, int groupLevel, String groupPath, String missingLevel,
                   long patternId, double duration) {
    }

    void setIndex(String sourceId, FieldDef field, boolean indexed);

    /** Recomputes the group-node table from the stored lines. */
    void rebuildGroups(String sourceId);

    void replacePatterns(String sourceId, List<Pattern> patterns);

    /** Rebuilds the trigram index from the stored text of {@code textFields} (search modes changed). */
    void rebuildFts(String sourceId, List<FieldDef> textFields);
}
