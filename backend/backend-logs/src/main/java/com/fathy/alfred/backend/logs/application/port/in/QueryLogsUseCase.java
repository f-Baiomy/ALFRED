package com.fathy.alfred.backend.logs.application.port.in;

import com.fathy.alfred.backend.logs.domain.model.FieldStats;
import com.fathy.alfred.backend.logs.domain.model.FieldValues;
import com.fathy.alfred.backend.logs.domain.model.GroupNode;
import com.fathy.alfred.backend.logs.domain.model.Histogram;
import com.fathy.alfred.backend.logs.domain.model.LineStructures;
import com.fathy.alfred.backend.logs.domain.model.LogLine;
import com.fathy.alfred.backend.logs.domain.model.LogLineSummary;
import com.fathy.alfred.backend.logs.domain.model.LogPage;
import com.fathy.alfred.backend.logs.domain.model.LogQuery;
import com.fathy.alfred.backend.logs.domain.model.Minimap;
import com.fathy.alfred.backend.logs.domain.model.Pattern;

import java.util.List;

/** Everything the explorer reads (FR-017..034). All inputs are clamped server-side. */
public interface QueryLogsUseCase {

    LogPage lines(String sourceId, LogQuery query);

    LogLine line(String sourceId, String lineId);

    List<LogLineSummary> context(String sourceId, String lineId, int before, int after);

    Histogram histogram(String sourceId, LogQuery query, int buckets);

    FieldValues fieldValues(String sourceId, LogQuery query);

    FieldStats fieldStats(String sourceId, String label, LogQuery query);

    Minimap minimap(String sourceId, LogQuery query, List<LogQuery.Pill> condition);

    List<LogLineSummary> trace(String sourceId, String lineId);

    List<GroupNode> groups(String sourceId, LogQuery query, String parentPath, int offset, int limit);

    LogPage bucket(String sourceId, LogQuery query);

    /** A group node's own lines (siblings) or its level-skipping lines, paged - nothing beyond a page is cut. */
    LogPage nodeLines(String sourceId, LogQuery query, String path, boolean skipped);

    /** Values of a typed field that did not convert (FR-012 "listable"), at most 100. */
    List<LogLineSummary> invalidValues(String sourceId, String label);

    List<Pattern> patterns(String sourceId, LogQuery query);

    /** The structures found among the lines; {@code query} non-null adds how many of each match it. */
    LineStructures structures(String sourceId, LogQuery query);
}
