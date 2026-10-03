package com.fathy.alfred.backend.logs.application.service;

import com.fathy.alfred.backend.logs.application.port.out.LogInputStorePort;
import com.fathy.alfred.backend.logs.application.port.out.LogLineStorePort;
import com.fathy.alfred.backend.logs.application.port.out.LogNotificationPort;
import com.fathy.alfred.backend.logs.application.port.out.LogSourceStorePort;
import com.fathy.alfred.backend.logs.domain.ingest.LineBuilder;
import com.fathy.alfred.backend.logs.domain.ingest.PatternMiner;
import com.fathy.alfred.backend.logs.domain.ingest.ShapeMatcher;
import com.fathy.alfred.backend.logs.domain.model.FieldDef;
import com.fathy.alfred.backend.logs.domain.model.LineRecord;
import com.fathy.alfred.backend.logs.domain.model.LogSource;
import com.fathy.alfred.backend.logs.domain.model.LogStructure;
import com.fathy.alfred.backend.logs.domain.model.RawMode;
import jakarta.annotation.PreDestroy;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.stereotype.Service;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Brings lines stored before every line could have its own structure (FR-045 as amended) up to date,
 * once, in the background: each line is given its structure, and a line that was flagged "different
 * structure" is re-read from its raw text so its own fields are registered and stored. Lines stored
 * with positions only (OFFSET mode) cannot be re-read; they get a structure from the fields they have,
 * and the file has to be loaded again for the rest.
 */
@Service
public class ShapeBackfillService {

    private static final Logger log = LoggerFactory.getLogger(ShapeBackfillService.class);
    static final int CHUNK = 5_000;

    private final LogSourceStorePort sources;
    private final LogInputStorePort inputs;
    private final LogLineStorePort lines;
    private final LogNotificationPort notifications;
    private final LogIngestService ingest;
    private final ExecutorService worker = Executors.newSingleThreadExecutor(r -> {
        Thread t = new Thread(r, "logs-structures");
        t.setDaemon(true);
        return t;
    });

    public ShapeBackfillService(LogSourceStorePort sources, LogInputStorePort inputs, LogLineStorePort lines,
                                LogNotificationPort notifications, LogIngestService ingest) {
        this.sources = sources;
        this.inputs = inputs;
        this.lines = lines;
        this.notifications = notifications;
        this.ingest = ingest;
    }

    @EventListener(ApplicationReadyEvent.class)
    public void start() {
        worker.submit(() -> {
            for (LogSource s : sources.list()) {
                try {
                    if (lines.hasUnshaped(s.id())) {
                        backfill(s);
                    }
                } catch (Exception e) {
                    log.error("Sorting the lines of log source {} into structures failed: {}", s.id(), e.toString());
                }
            }
        });
    }

    @PreDestroy
    void shutdown() {
        worker.shutdownNow();
    }

    void backfill(LogSource source) {
        String id = source.id();
        long[] rewritten = {0};
        LogStructure first = sources.structure(id).orElseThrow();
        lines.forEachUnshaped(id, first.fields().stream().filter(FieldDef::stored).toList(), CHUNK, rows -> {
            synchronized (ingest.lockFor(id)) {
                LogStructure s = sources.structure(id).orElseThrow();
                ShapeMatcher matcher = ingest.shapes(id);
                Map<Long, Integer> plain = new LinkedHashMap<>();
                List<LogLineStorePort.Rewrite> reread = new ArrayList<>();
                Map<LogLineStorePort.StoredRow, LineBuilder.Parsed> parsedRows = new LinkedHashMap<>();
                Map<String, Object> fresh = new LinkedHashMap<>();
                for (LogLineStorePort.StoredRow row : rows) {
                    if (!row.mismatch() || row.raw() == null) {
                        plain.put(row.rid(), matcher.assign(row.text().keySet()));
                        continue;
                    }
                    LineBuilder.Parsed parsed = ingest.builder.parse(row.raw().getBytes(StandardCharsets.UTF_8), s, false);
                    parsed.newPaths().forEach(fresh::putIfAbsent);
                    parsedRows.put(row, parsed);
                }
                // One registration per chunk, without building indexes: an index over every stored line,
                // per field, would hold the write lock for minutes on a slow disk. The fields come in as
                // "Not searched" (still filterable); the user can make one Exact on the structure page.
                if (!fresh.isEmpty()) {
                    s = ingest.addFields(id, s, fresh, 0, false);
                }
                for (var e : parsedRows.entrySet()) {
                    LogLineStorePort.StoredRow row = e.getKey();
                    LineRecord r = ingest.builder.toRecord(e.getValue(), s, row.lineId(), "", 0, false, 0, null,
                            new ArrayList<PatternMiner.Cluster>(), matcher);
                    reread.add(new LogLineStorePort.Rewrite(row.rid(), r.text(), new HashMap<>(r.typed()), r.ftsText(), r.shape()));
                }
                lines.setShapes(id, plain);
                lines.rewriteLines(id, s, reread);
                lines.upsertShapes(id, matcher.drainChanged());
                ingest.changed(id);
                rewritten[0] += reread.size();
            }
        });
        if (source.rawMode() == RawMode.COPY) {
            // Every flagged line was re-read: the inputs no longer have "different structure" lines.
            inputs.clearMismatchCounts(id);
        }
        log.info("Log source {}: lines sorted into structures ({} re-read for their own fields)", id, rewritten[0]);
        notifications.structureChanged(id, "");
        notifications.sourcesChanged();
    }
}
