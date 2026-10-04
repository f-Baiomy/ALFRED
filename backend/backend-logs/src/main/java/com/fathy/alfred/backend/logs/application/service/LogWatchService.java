package com.fathy.alfred.backend.logs.application.service;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fathy.alfred.backend.logs.application.port.in.LogsException;
import com.fathy.alfred.backend.logs.application.port.in.WatchFoldersUseCase;
import com.fathy.alfred.backend.logs.application.port.out.LogInputStorePort;
import com.fathy.alfred.backend.logs.application.port.out.LogNotificationPort;
import com.fathy.alfred.backend.logs.application.port.out.WatchFoldersPort;
import com.fathy.alfred.backend.logs.domain.model.InputKind;
import com.fathy.alfred.backend.logs.domain.model.InputStatus;
import com.fathy.alfred.backend.logs.domain.model.LogInput;
import com.fathy.alfred.backend.logs.domain.model.LogSource;
import com.fathy.alfred.backend.logs.domain.model.WatchOptions;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Watched folders: a WATCH input owns one WATCHED_FILE input per matching file. Each file is read by
 * the normal ingest pipeline (positions saved per batch, rotation, no loss on restart); when it has read
 * everything it waits in {@link FileChangeSignals} until a change notification for that file arrives -
 * from the kernel ({@code WatchServiceEvents}) or from the host agent. Nothing runs on a timer.
 *
 * <p>Rotated copies (detail.log.1, detail.log.2026-10-03) are "archives": read once for the starting
 * window, never followed - the live file's reader follows its rotation itself, so the renamed copy is
 * never read twice. A live file that appears later is read from its first byte.
 */
@Service
public class LogWatchService implements WatchFoldersUseCase {

    private static final Logger log = LoggerFactory.getLogger(LogWatchService.class);
    /** Marks an archive child: read once, not followed. */
    public static final String ARCHIVE = "archive";

    private final WatchFoldersPort folders;
    private final LogInputStorePort inputs;
    private final LogIngestService ingest;
    private final FileChangeSignals signals;
    private final LogNotificationPort notifications;
    private final ObjectMapper mapper;
    /** watch input id → (relative path → child input id), loaded lazily, kept in step with created children. */
    private final Map<String, Map<String, String>> children = new ConcurrentHashMap<>();
    private volatile long agentSeenAt;
    /** Active folder watches, read on every change notification; dropped whenever one is added, paused, resumed or removed. */
    private volatile List<LogInput> activeWatches;

    @Value("${LOGS_WATCH_MODE:events}")
    private String mode;

    public LogWatchService(WatchFoldersPort folders, LogInputStorePort inputs, LogIngestService ingest, FileChangeSignals signals,
                           LogNotificationPort notifications, ObjectMapper mapper) {
        this.folders = folders;
        this.inputs = inputs;
        this.ingest = ingest;
        this.signals = signals;
        this.notifications = notifications;
        this.mapper = mapper;
    }

    // ------------------------------------------------------------------ folders

    @Override
    public Folders folders() {
        return new Folders(folders.folders(), mode, agentSeenAt);
    }

    @Override
    public List<WatchFoldersPort.WatchedFile> files(String folder, String pattern, boolean subfolders) {
        try {
            return folders.files(folder, pattern, subfolders);
        } catch (IllegalArgumentException e) {
            throw LogsException.bad(e.getMessage());
        } catch (IOException e) {
            throw new LogsException(LogsException.Kind.UNAVAILABLE, "Could not list watched folder " + folder);
        }
    }

    /** Absolute path of one file of a watched folder (it must exist, and lie inside the folder). */
    public String filePath(String folder, String relative) {
        try {
            folders.dir(folder);
        } catch (IllegalArgumentException e) {
            throw LogsException.bad(e.getMessage());
        }
        WatchFoldersPort.WatchedFile f = folders.match(folder, relative, "*", true);
        if (f == null || f.size() == 0 && !java.nio.file.Files.isRegularFile(java.nio.file.Path.of(f.path()))) {
            throw LogsException.bad("No such file in watched folder " + folder);
        }
        return f.path();
    }

    WatchOptions options(LogInput watch) {
        try {
            return mapper.readValue(watch.options(), WatchOptions.class);
        } catch (Exception e) {
            throw new IllegalStateException("Watch input " + watch.id() + " has unreadable options", e);
        }
    }

    // ------------------------------------------------------------------ create / start

    /** Validates options and creates the WATCH input; its files start loading at once. */
    public LogInput create(LogSource source, WatchOptions o, String inputId) {
        if (o == null || o.folder() == null) {
            throw LogsException.bad("Choose a watched folder");
        }
        String dir;
        try {
            dir = folders.dir(o.folder());
        } catch (IllegalArgumentException e) {
            throw LogsException.bad(e.getMessage());
        }
        String pattern = o.pattern() == null || o.pattern().isBlank() ? "*" : o.pattern().strip();
        if (pattern.length() > 200 || pattern.contains("/") || pattern.contains("\\") || pattern.contains("..")) {
            throw LogsException.bad("A file pattern is a file name glob such as detail*.log");
        }
        WatchOptions.Start start = o.start() == null ? WatchOptions.Start.LAST : o.start();
        if (start == WatchOptions.Start.LAST && (o.lastLines() < 1 || o.lastLines() > WatchOptions.MAX_LAST_LINES)) {
            throw LogsException.bad("The last N lines is 1-" + WatchOptions.MAX_LAST_LINES);
        }
        WatchOptions clean = new WatchOptions(o.folder(), pattern, o.subfolders(), start, o.lastLines(), o.perFile());
        String now = Instant.now().toString();
        String json;
        try {
            json = mapper.writeValueAsString(clean);
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
        LogInput watch = new LogInput(inputId, source.id(), InputKind.WATCH, dir, o.folder() + "/" + pattern, null,
                InputStatus.FOLLOWING, null, 0, 0, 0, 0, 0, now, now, null, json);
        inputs.save(watch);
        invalidate();
        startFiles(watch, clean);
        notifications.sourcesChanged();
        return inputs.get(watch.id()).orElse(watch);
    }

    /** Creates a child per matching file at its starting position and starts reading. */
    void startFiles(LogInput watch, WatchOptions o) {
        List<WatchFoldersPort.WatchedFile> files = files(o.folder(), o.pattern(), o.subfolders());
        long remaining = o.lastLines();
        for (WatchFoldersPort.WatchedFile f : files) {
            long position;
            try {
                position = switch (o.start()) {
                    case ALL -> 0;
                    case NEW -> f.size();
                    case LAST -> {
                        if (!o.perFile() && remaining <= 0) {
                            yield f.size();
                        }
                        WatchFoldersPort.LastLines last = folders.lastLines(f.path(), o.perFile() ? o.lastLines() : remaining);
                        if (!o.perFile()) {
                            remaining -= last.lines();
                        }
                        yield last.offset();
                    }
                };
            } catch (IOException e) {
                log.warn("Watched file {} could not be measured: {}", f.path(), e.toString());
                position = 0;
            }
            LogInput child = addChild(watch, f, position);
            boolean nothingToRead = f.archive() && position >= f.size();
            if (nothingToRead) {
                inputs.save(child.withStatus(InputStatus.DONE, null));
            } else {
                ingest.start(child);
            }
        }
    }

    private LogInput addChild(LogInput watch, WatchFoldersPort.WatchedFile f, long position) {
        String now = Instant.now().toString();
        LogInput child = new LogInput(LogSourcesService.id("i", 6), watch.sourceId(), InputKind.WATCHED_FILE, f.path(), f.relative(),
                null, InputStatus.QUEUED, null, position, 0, f.size(), 0, 0, now, now, watch.id(), f.archive() ? ARCHIVE : null);
        inputs.save(child);
        childrenOf(watch.id()).put(f.relative(), child.id());
        return child;
    }

    private Map<String, String> childrenOf(String watchId) {
        return children.computeIfAbsent(watchId, id -> {
            Map<String, String> m = new ConcurrentHashMap<>();
            inputs.byParent(id).forEach(c -> m.put(c.fileName(), c.id()));
            return m;
        });
    }

    /** Pause / resume / remove of a WATCH input apply to all its files. */
    public void forget(String watchId) {
        invalidate();
        Map<String, String> m = children.remove(watchId);
        if (m != null) {
            m.values().forEach(signals::forget);
        }
    }

    // ------------------------------------------------------------------ change notifications

    /** A watch was added, paused, resumed or removed. */
    public void invalidate() {
        activeWatches = null;
    }

    private List<LogInput> watchesOn(String folder) {
        List<LogInput> all = activeWatches;
        if (all == null) {
            all = inputs.all().stream().filter(in -> in.kind() == InputKind.WATCH && in.status() == InputStatus.FOLLOWING
                    && in.fileName() != null).toList();
            activeWatches = all;
        }
        List<LogInput> out = new ArrayList<>();
        for (LogInput in : all) {
            if (in.fileName().startsWith(folder + "/")) {
                out.add(in);
            }
        }
        return out;
    }

    @Override
    public void changed(String folder, String relative) {
        for (LogInput watch : watchesOn(folder)) {
            WatchOptions o = options(watch);
            WatchFoldersPort.WatchedFile f = folders.match(folder, relative, o.pattern(), o.subfolders());
            if (f == null) {
                continue;
            }
            String childId = childrenOf(watch.id()).get(f.relative());
            if (childId != null) {
                signals.signal(childId);
            } else if (!f.archive() && java.nio.file.Files.isRegularFile(java.nio.file.Path.of(f.path()))) {
                // A new live file: everything in it is new. (A new archive is a rotation of a file
                // already being read - its lines are read by the live file's reader, never again.)
                LogInput child = addChild(watch, f, 0);
                ingest.start(child);
                notifications.sourcesChanged();
            }
        }
    }

    @Override
    public void rescan(String folder) {
        for (LogInput watch : watchesOn(folder)) {
            WatchOptions o = options(watch);
            Map<String, String> known = childrenOf(watch.id());
            known.values().forEach(signals::signal);
            for (WatchFoldersPort.WatchedFile f : files(folder, o.pattern(), o.subfolders())) {
                if (!f.archive() && !known.containsKey(f.relative())) {
                    ingest.start(addChild(watch, f, 0));
                    notifications.sourcesChanged();
                }
            }
        }
    }

    @Override
    public void agentSeen() {
        boolean first = agentSeenAt == 0;
        agentSeenAt = System.currentTimeMillis();
        if (first) {
            folders.folders().stream().filter(WatchFoldersPort.Folder::available).forEach(f -> rescan(f.name()));
        }
    }

    /** Files created while ALFRED was down are picked up (existing files resume from their saved positions). */
    @EventListener(ApplicationReadyEvent.class)
    public void resumeFolders() {
        Set<String> seen = new java.util.HashSet<>();
        for (LogInput in : inputs.all()) {
            if (in.kind() == InputKind.WATCH && in.status() == InputStatus.FOLLOWING && in.fileName() != null) {
                String folder = in.fileName().substring(0, in.fileName().indexOf('/'));
                if (seen.add(folder)) {
                    try {
                        rescan(folder);
                    } catch (RuntimeException e) {
                        log.warn("Watched folder {} could not be rescanned: {}", folder, e.getMessage());
                    }
                }
            }
        }
    }
}
