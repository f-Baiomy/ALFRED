package com.fathy.alfred.backend.logs.application.service;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fathy.alfred.backend.logs.application.port.in.LogsException;
import com.fathy.alfred.backend.logs.application.port.in.ManageLogInputsUseCase;
import com.fathy.alfred.backend.logs.application.port.in.ManageLogSourcesUseCase;
import com.fathy.alfred.backend.logs.application.port.out.LogCommentStorePort;
import com.fathy.alfred.backend.logs.application.port.out.LogFilesPort;
import com.fathy.alfred.backend.logs.application.port.out.LogInputStorePort;
import com.fathy.alfred.backend.logs.application.port.out.LogLineStorePort;
import com.fathy.alfred.backend.logs.application.port.out.LogNotificationPort;
import com.fathy.alfred.backend.logs.application.port.out.LogSourceStorePort;
import com.fathy.alfred.backend.logs.domain.ingest.Flattener;
import com.fathy.alfred.backend.logs.domain.ingest.PayloadRule;
import com.fathy.alfred.backend.logs.domain.ingest.StructureDetector;
import com.fathy.alfred.backend.logs.domain.model.DataView;
import com.fathy.alfred.backend.logs.domain.model.FieldDef;
import com.fathy.alfred.backend.logs.domain.model.GroupLevel;
import com.fathy.alfred.backend.logs.domain.model.InputKind;
import com.fathy.alfred.backend.logs.domain.model.InputStatus;
import com.fathy.alfred.backend.logs.domain.model.LogInput;
import com.fathy.alfred.backend.logs.domain.model.LogSource;
import com.fathy.alfred.backend.logs.domain.model.LogStructure;
import com.fathy.alfred.backend.logs.domain.model.PrivacyMode;
import com.fathy.alfred.backend.logs.domain.model.RawMode;
import com.fathy.alfred.backend.logs.domain.model.Role;
import com.fathy.alfred.backend.logs.domain.model.SearchMode;
import com.fathy.alfred.backend.logs.domain.model.TypeSource;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.io.InputStream;
import java.security.SecureRandom;
import java.time.Instant;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.EnumSet;
import java.util.HashSet;
import java.util.HexFormat;
import java.util.List;
import java.util.Set;
import java.util.TreeSet;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Sources, their structure and their inputs. */
@Service
public class LogSourcesService implements ManageLogSourcesUseCase, ManageLogInputsUseCase {

    /** 0 = no size cap: every loaded line stays (owner decision 2026-10-03; the low-disk pause guards the disk). */
    static final long DEFAULT_RETENTION_BYTES = 0;
    static final long MIN_RETENTION_BYTES = 100L * 1024 * 1024;
    static final long MAX_RETENTION_BYTES = 500L * 1024 * 1024 * 1024;
    static final int MAX_LEVELS = 8;
    static final int MAX_COLUMNS = 30;
    static final int MAX_TEMPLATE = 500;
    static final int MAX_NAME = 80;
    /** Chunks stay under the gateway's 50 MB body limit (research §R10). */
    public static final int CHUNK_SIZE = 32 * 1024 * 1024;
    public static final int MAX_CHUNK = 40 * 1024 * 1024;
    static final int PREVIEW_LINES = StructureDetector.SAMPLE_LINES;
    private static final Pattern TOKEN = Pattern.compile("\\{([^}]+)}");
    private static final SecureRandom RANDOM = new SecureRandom();

    private final LogSourceStorePort sources;
    private final LogInputStorePort inputs;
    private final LogLineStorePort lines;
    private final LogCommentStorePort comments;
    private final LogFilesPort files;
    private final LogNotificationPort notifications;
    private final LogIngestService ingest;
    private final StructureRebuildService rebuild;
    private final LogWatchService watch;
    private final com.fathy.alfred.backend.logs.application.port.out.LogSessionStorePort sessionStore;
    private final ObjectMapper objectMapper;

    public LogSourcesService(LogSourceStorePort sources, LogInputStorePort inputs, LogLineStorePort lines, LogCommentStorePort comments,
                             LogFilesPort files, LogNotificationPort notifications, LogIngestService ingest,
                             StructureRebuildService rebuild, ObjectMapper objectMapper, LogWatchService watch,
                             com.fathy.alfred.backend.logs.application.port.out.LogSessionStorePort sessionStore) {
        this.watch = watch;
        this.sessionStore = sessionStore;
        this.sources = sources;
        this.inputs = inputs;
        this.lines = lines;
        this.comments = comments;
        this.files = files;
        this.notifications = notifications;
        this.ingest = ingest;
        this.rebuild = rebuild;
        this.objectMapper = objectMapper;
    }

    static String id(String prefix, int bytes) {
        byte[] b = new byte[bytes];
        RANDOM.nextBytes(b);
        return prefix + HexFormat.of().formatHex(b);
    }

    // ------------------------------------------------------------------ sources

    @Override
    public List<SourceView> list() {
        return sources.list().stream().map(this::view).toList();
    }

    private SourceView view(LogSource s) {
        return new SourceView(s, inputs.bySource(s.id()), sources.structure(s.id()).map(LogStructure::id).orElse(null));
    }

    private LogSource source(String id) {
        return sources.get(id).orElseThrow(() -> LogsException.notFound("Log source"));
    }

    @Override
    public SourceView get(String id) {
        return view(source(id));
    }

    @Override
    public Preview preview(List<String> sampleLines, String serverPath) {
        List<String> sample;
        if (serverPath != null && !serverPath.isBlank()) {
            try {
                sample = files.head(resolve(serverPath), PREVIEW_LINES);
            } catch (IOException e) {
                throw LogsException.bad("Could not read that file");
            }
        } else {
            sample = sampleLines == null ? List.of() : sampleLines.stream().limit(PREVIEW_LINES).toList();
        }
        return previewOf(sample);
    }

    private Preview previewOf(List<String> sample) {
        Flattener flattener = new Flattener(objectMapper);
        List<com.fasterxml.jackson.databind.JsonNode> nodes = new ArrayList<>();
        for (String line : sample) {
            try {
                var node = objectMapper.readTree(line);
                if (node != null && node.isObject()) {
                    nodes.add(node);
                }
            } catch (Exception ignored) {
                // An invalid line in the sample is simply not part of the detection.
            }
        }
        if (nodes.isEmpty()) {
            throw LogsException.bad("No JSON object lines found in the sample - each line must be one JSON object");
        }
        // Payload option A: big or id-keyed parts (request/response bodies) become one field each.
        // Fields that get a role (time, level, service, duration, ...) never go inside a payload.
        List<Flattener.Result> full = nodes.stream().map(flattener::flatten).toList();
        Set<String> leafPaths = new java.util.LinkedHashSet<>();
        full.forEach(r -> leafPaths.addAll(r.values().keySet()));
        // Request/response bodies and errors (by role) are always one field; other roles are never inside a payload.
        List<FieldDef> guessed = StructureDetector.detect(full).fields();
        List<String> roled = guessed.stream().filter(f -> f.role() != null && !PayloadRule.bodyRole(f.role())).map(FieldDef::path).toList();
        Set<String> payloads = new java.util.LinkedHashSet<>(PayloadRule.bodies(
                guessed.stream().filter(f -> PayloadRule.bodyRole(f.role())).map(FieldDef::path).toList(), leafPaths, List.of()));
        payloads.addAll(PayloadRule.choose(leafPaths, payloads, roled));
        List<Flattener.Result> parsed = nodes.stream().map(n -> flattener.flatten(n, payloads)).toList();
        LogStructure detected = StructureDetector.detect(parsed).withPayloads(List.copyOf(payloads));
        int structures = StructureDetector.structureCount(parsed);
        LogSource match = sources.withStructureId(detected.id()).stream().findFirst().orElse(null);
        if (match != null) {
            // FR-048: offer that source's settings; the caller decides whether to use them.
            LogStructure theirs = sources.structure(match.id()).orElse(detected);
            return new Preview(theirs, parsed.size(), structures, match.id(), match.name());
        }
        return new Preview(detected, parsed.size(), structures, null, null);
    }

    @Override
    public Preview previewWatched(String folder, String relativePath) {
        String path = watch.filePath(folder, relativePath);
        try {
            return previewOf(files.head(path, PREVIEW_LINES));
        } catch (IOException e) {
            throw LogsException.bad("Could not read that file");
        }
    }

    @Override
    public SourceView create(String name, RawMode rawMode, PrivacyMode privacyMode, LogStructure structure) {
        String n = name(name);
        if (privacyMode == PrivacyMode.REDACT_AT_LOAD && rawMode != RawMode.COPY) {
            throw LogsException.bad("Redact at load needs raw lines copied into ALFRED - with positions only the original would still be readable");
        }
        LogStructure s = validate(structure, null);
        String now = Instant.now().toString();
        LogSource source = new LogSource(id("s", 6), n, rawMode, privacyMode, DEFAULT_RETENTION_BYTES,
                0, 0, 0, now, now);
        sources.save(source);
        lines.createSource(source.id());
        sources.saveStructure(source.id(), s);
        lines.ensureFields(source.id(), s.fields());
        s.fields().stream().filter(f -> f.stored() && f.searchMode() == SearchMode.EXACT).forEach(f -> lines.setIndex(source.id(), f, true));
        notifications.sourcesChanged();
        return view(source);
    }

    private static String name(String name) {
        String n = name == null ? "" : name.trim();
        if (n.isEmpty() || n.length() > MAX_NAME) {
            throw LogsException.bad("A source name is 1-" + MAX_NAME + " characters");
        }
        return n;
    }

    @Override
    public SourceView update(String id, String name, Long retentionMaxBytes) {
        LogSource s = source(id);
        long bytes = retentionMaxBytes == null ? s.retentionMaxBytes() : retentionMaxBytes;
        if (bytes != 0 && (bytes < MIN_RETENTION_BYTES || bytes > MAX_RETENTION_BYTES)) {
            throw LogsException.bad("Retention size is 0 (keep everything) or 0.1-500 GB");
        }
        LogSource updated = new LogSource(s.id(), name == null ? s.name() : name(name), s.rawMode(), s.privacyMode(), bytes,
                s.lineCount(), s.storedBytes(), s.unparsedCount(), s.createdAt(), Instant.now().toString());
        sources.save(updated);
        notifications.sourcesChanged();
        return view(updated);
    }

    @Override
    public DeleteImpact deleteImpact(String id) {
        LogSource s = source(id);
        return new DeleteImpact(s.lineCount(), comments.countForSource(id), lines.pinnedCount(id));
    }

    @Override
    public void delete(String id) {
        source(id);
        for (LogInput in : inputs.bySource(id)) {
            ingest.stop(in.id());
            if (in.kind() == InputKind.UPLOAD && in.fileName() != null) {
                uploadIdOf(in).ifPresent(files::deleteUpload);
            }
        }
        rebuild.forget(id);
        ingest.forgetSource(id);
        lines.dropSource(id);
        comments.deleteSource(id);
        sessionStore.deleteSource(id);
        sources.delete(id);
        notifications.sourcesChanged();
    }

    @Override
    public LogStructure structure(String id) {
        source(id);
        return sources.structure(id).orElseThrow(() -> LogsException.notFound("Structure"));
    }

    @Override
    public LogStructure updateStructure(String id, LogStructure requested) {
        source(id);
        StructureRebuildService.Plan plan;
        LogStructure merged;
        synchronized (ingest.lockFor(id)) {
            LogStructure current = structure(id);
            merged = validate(requested, current);
            plan = StructureRebuildService.plan(current, merged);
            sources.saveStructure(id, merged);
        }
        ingest.changed(id);
        rebuild.schedule(id, plan);
        notifications.structureChanged(id, plan.empty() ? "" : plan.labels());
        return merged;
    }

    /**
     * Server-side validation of a structure. With {@code current}, the field set is the stored one and
     * only user settings are taken from the request (a client cannot add, drop or re-index fields).
     */
    LogStructure validate(LogStructure s, LogStructure current) {
        if (s == null || s.fields() == null) {
            throw LogsException.bad("Structure is required");
        }
        List<FieldDef> fields;
        if (current == null) {
            if (s.fields().isEmpty() || s.fields().size() > LogStructure.MAX_FIELDS
                    || s.fields().stream().filter(FieldDef::stored).count() > LogStructure.MAX_STORED_FIELDS) {
                throw LogsException.bad("A structure has 1-" + LogStructure.MAX_STORED_FIELDS + " searchable fields");
            }
            Set<Integer> idx = new HashSet<>();
            Set<String> labels = new HashSet<>();
            for (FieldDef f : s.fields()) {
                if (f.path() == null || f.path().isBlank() || f.label() == null || f.label().isBlank()
                        || !idx.add(f.index()) || !labels.add(f.label()) || f.type() == null || f.searchMode() == null) {
                    throw LogsException.bad("Field definitions are incomplete or repeat an index or label");
                }
            }
            fields = s.fields();
        } else {
            fields = new ArrayList<>();
            for (FieldDef c : current.fields()) {
                FieldDef r = s.byPath(c.path()).orElse(c);
                boolean typeChanged = r.type() != null && (r.type() != c.type() || !java.util.Objects.equals(r.format(), c.format()));
                fields.add(new FieldDef(c.index(), c.path(), c.label(), r.type() == null ? c.type() : r.type(),
                        typeChanged ? TypeSource.USER : c.typeSource(), r.format() == null ? c.format() : r.format(), c.matchRate(),
                        c.invalidCount(), c.suggestBoolean(), c.stored() && r.searchMode() != null ? r.searchMode() : c.searchMode(),
                        r.role(), r.sensitive(), c.duplicateOf(), c.firstSeenLine(), c.sample(), r.roleRank()));
            }
        }
        for (FieldDef f : fields) {
            if (f.format() != null && f.format().length() > 100) {
                throw LogsException.bad("Format of " + f.label() + " is too long");
            }
        }
        fields = rankRoles(fields);
        LogStructure base = new LogStructure(current == null ? s.id() : current.id(), fields, List.of(), "", List.of(), DataView.TABLE, "UTC");
        List<GroupLevel> levels = s.groupLevels() == null ? List.of() : s.groupLevels();
        if (levels.size() > MAX_LEVELS) {
            throw LogsException.bad("At most " + MAX_LEVELS + " grouping levels");
        }
        Set<String> seen = new HashSet<>();
        for (GroupLevel l : levels) {
            if (l.fieldLabel() == null || base.byLabel(l.fieldLabel()).filter(FieldDef::stored).isEmpty() || !seen.add(l.fieldLabel())) {
                throw LogsException.bad("Grouping level field '" + l.fieldLabel() + "' is not a stored field or repeats");
            }
        }
        // Group-level fields are queried by value on every expand: they always get an index (research R7).
        Set<String> levelLabels = new HashSet<>(levels.stream().map(GroupLevel::fieldLabel).toList());
        fields = fields.stream().map(f -> levelLabels.contains(f.label()) && f.searchMode() == SearchMode.NONE
                ? f.withSearchMode(SearchMode.EXACT) : f).toList();
        String template = s.template() == null ? "" : s.template();
        if (template.length() > MAX_TEMPLATE) {
            throw LogsException.bad("Template is longer than " + MAX_TEMPLATE + " characters");
        }
        Matcher m = TOKEN.matcher(template);
        while (m.find()) {
            if (base.byLabel(m.group(1)).isEmpty()) {
                throw LogsException.bad("Template field {" + m.group(1) + "} does not exist");
            }
        }
        List<String> columns = s.columns() == null ? List.of() : s.columns();
        if (columns.size() > MAX_COLUMNS || columns.stream().anyMatch(c -> base.byLabel(c).isEmpty())) {
            throw LogsException.bad("Columns must be up to " + MAX_COLUMNS + " existing fields");
        }
        String zone = s.timeZone() == null || s.timeZone().isBlank() ? "UTC" : s.timeZone();
        try {
            ZoneId.of(zone);
        } catch (RuntimeException e) {
            throw LogsException.bad("Unknown time zone " + zone);
        }
        return new LogStructure(base.id() == null ? StructureDetector.structureId(fields.stream().map(FieldDef::path).toList()) : base.id(),
                fields, levels.stream().map(l -> new GroupLevel(l.fieldLabel(), l.sort() == null
                ? com.fathy.alfred.backend.logs.domain.model.GroupSort.TIME_ASC : l.sort())).toList(),
                template, List.copyOf(new java.util.LinkedHashSet<>(columns)),
                s.defaultDataView() == null ? DataView.TABLE : s.defaultDataView(), zone,
                current == null ? s.overflowPaths() : current.overflowPaths(),
                current == null ? s.payloadPaths() : current.payloadPaths(), s.defaultFieldLayout());
    }

    /**
     * A role may be on several fields (lines of different structures name the same thing differently,
     * FR-045 as amended): each role's fields get ranks 1..n in the order asked (rank, then field order),
     * which is the order a line tries them. A field without a role has rank 0.
     */
    static List<FieldDef> rankRoles(List<FieldDef> fields) {
        java.util.Map<Integer, Integer> rank = new java.util.HashMap<>();
        for (Role role : Role.values()) {
            List<FieldDef> withRole = fields.stream().filter(f -> f.role() == role)
                    .sorted(java.util.Comparator.comparingInt((FieldDef f) -> f.roleRank() <= 0 ? Integer.MAX_VALUE : f.roleRank())
                            .thenComparingInt(FieldDef::index)).toList();
            for (int i = 0; i < withRole.size(); i++) {
                rank.put(withRole.get(i).index(), i + 1);
            }
        }
        return fields.stream().map(f -> f.withRole(f.role(), rank.getOrDefault(f.index(), 0))).toList();
    }

    // ------------------------------------------------------------------ inputs

    private String resolve(String serverPath) {
        try {
            return files.resolveServerFile(serverPath);
        } catch (IllegalArgumentException e) {
            throw LogsException.bad(e.getMessage());
        }
    }

    @Override
    public List<ServerFile> serverFiles(String dir) {
        try {
            return files.list(dir).stream().map(e -> new ServerFile(e.path(), e.name(), e.directory(), e.size())).toList();
        } catch (IllegalArgumentException e) {
            throw LogsException.bad(e.getMessage());
        } catch (IOException e) {
            throw new LogsException(LogsException.Kind.UNAVAILABLE, "Could not list the server logs folder");
        }
    }

    @Override
    public UploadTicket createUpload(String fileName, long size) {
        if (fileName == null || fileName.isBlank() || fileName.length() > 255 || size <= 0) {
            throw LogsException.bad("An upload needs a file name and a size");
        }
        LogInputStorePort.Upload u = new LogInputStorePort.Upload(id("u", 8), fileName, size, CHUNK_SIZE, new TreeSet<>(), null);
        inputs.saveUpload(u);
        return new UploadTicket(u.id(), CHUNK_SIZE, u.received());
    }

    private LogInputStorePort.Upload upload(String uploadId) {
        return inputs.upload(uploadId).orElseThrow(() -> LogsException.notFound("Upload"));
    }

    @Override
    public UploadTicket uploadStatus(String uploadId) {
        LogInputStorePort.Upload u = upload(uploadId);
        return new UploadTicket(u.id(), u.chunkSize(), u.received());
    }

    @Override
    public UploadTicket writeChunk(String uploadId, int index, InputStream data, long length) {
        LogInputStorePort.Upload u = upload(uploadId);
        long chunks = (u.size() + u.chunkSize() - 1) / u.chunkSize();
        long expected = index == chunks - 1 ? u.size() - (long) index * u.chunkSize() : u.chunkSize();
        if (index < 0 || index >= chunks || length != expected) {
            throw LogsException.bad("Chunk " + index + " must be " + expected + " bytes");
        }
        try {
            files.writeChunk(uploadId, (long) index * u.chunkSize(), data, length);
        } catch (IOException | IllegalArgumentException e) {
            throw new LogsException(LogsException.Kind.UNAVAILABLE, "Could not store chunk " + index);
        }
        Set<Integer> received;
        synchronized (this) {
            LogInputStorePort.Upload now = upload(uploadId);
            received = new TreeSet<>(now.received());
            received.add(index);
            inputs.saveUpload(new LogInputStorePort.Upload(now.id(), now.fileName(), now.size(), now.chunkSize(), received, now.inputId()));
            if (received.size() == chunks && now.inputId() != null) {
                inputs.get(now.inputId()).filter(in -> in.status() == InputStatus.UPLOADING).ifPresent(in -> {
                    LogInput queued = in.withStatus(InputStatus.QUEUED, null);
                    inputs.save(queued);
                    ingest.start(queued);
                });
            }
        }
        return new UploadTicket(uploadId, u.chunkSize(), received);
    }

    @Override
    public LogInput addWatch(String sourceId, com.fathy.alfred.backend.logs.domain.model.WatchOptions options) {
        LogSource source = source(sourceId);
        return watch.create(source, options, id("i", 6));
    }

    @Override
    public LogInput add(String sourceId, InputKind kind, String ref, String fingerprint, boolean fromStart, boolean confirmDuplicate) {
        if (kind == InputKind.WATCH || kind == InputKind.WATCHED_FILE) {
            throw LogsException.bad("A watched folder is added with its options (folder, pattern, start)");
        }
        LogSource source = source(sourceId);
        if (kind == null) {
            throw LogsException.bad("Input kind is required");
        }
        if (kind == InputKind.PUSH || kind == InputKind.OPENSEARCH) {
            // Waiting on the secrets decision (specs/004-logs-explorer/tasks.md, "Open decision C1").
            throw new LogsException(LogsException.Kind.UNAVAILABLE, kind + " inputs are not available yet");
        }
        String path;
        String fileName;
        String fp = fingerprint;
        LogInputStorePort.Upload upload = null;
        if (kind == InputKind.UPLOAD) {
            upload = upload(ref);
            path = files.uploadPath(upload.id());
            fileName = upload.fileName();
        } else {
            path = resolve(ref);
            fileName = ref;
            try {
                fp = java.nio.file.Files.exists(java.nio.file.Path.of(path)) ? files.fingerprint(path) : null;
            } catch (IOException e) {
                throw LogsException.bad("Could not read that file");
            }
        }
        if (fp != null && !confirmDuplicate) {
            final String f = fp;
            if (inputs.bySource(sourceId).stream().anyMatch(i -> f.equals(i.fingerprint()))) {
                throw new LogsException(LogsException.Kind.CONFLICT, "DUPLICATE_FILE");
            }
        }
        long position = 0;
        if (kind == InputKind.FOLLOW && !fromStart) {
            try {
                position = java.nio.file.Files.exists(java.nio.file.Path.of(path)) ? java.nio.file.Files.size(java.nio.file.Path.of(path)) : 0;
            } catch (IOException e) {
                position = 0;
            }
        }
        boolean uploadDone = upload != null && upload.received().size() == (upload.size() + upload.chunkSize() - 1) / upload.chunkSize();
        InputStatus status = kind == InputKind.UPLOAD && !uploadDone ? InputStatus.UPLOADING : InputStatus.QUEUED;
        String now = Instant.now().toString();
        LogInput in = new LogInput(id("i", 6), source.id(), kind, path, fileName, fp, status, null, position, 0,
                upload != null ? upload.size() : 0, 0, 0, now, now);
        inputs.save(in);
        if (position > 0) {
            // Follow from the current end: record where reading starts (save() never moves positions).
            lines.append(sourceId, structure(sourceId), new LogLineStorePort.Batch(List.of(), List.of(), List.of(), in.id(), position, 0, 0));
        }
        if (upload != null) {
            inputs.saveUpload(new LogInputStorePort.Upload(upload.id(), upload.fileName(), upload.size(), upload.chunkSize(),
                    upload.received(), in.id()));
        }
        if (status == InputStatus.QUEUED) {
            ingest.start(inputs.get(in.id()).orElse(in));
        }
        notifications.sourcesChanged();
        return inputs.get(in.id()).orElse(in);
    }

    private LogInput input(String sourceId, String inputId) {
        return inputs.get(inputId).filter(i -> i.sourceId().equals(sourceId)).orElseThrow(() -> LogsException.notFound("Input"));
    }

    @Override
    public LogInput pause(String sourceId, String inputId) {
        LogInput in = input(sourceId, inputId);
        if (in.kind() == InputKind.WATCH) {
            // A folder pauses all its files; nothing is read until it is resumed.
            for (LogInput child : inputs.byParent(inputId)) {
                ingest.stop(child.id());
                if (child.status() != InputStatus.DONE) {
                    inputs.save(inputs.get(child.id()).orElse(child).withStatus(InputStatus.PAUSED, null));
                }
            }
            watch.forget(inputId);
        }
        ingest.stop(inputId);
        LogInput paused = inputs.get(inputId).orElse(in).withStatus(InputStatus.PAUSED, null);
        inputs.save(paused);
        watch.invalidate();
        notifications.sourcesChanged();
        return paused;
    }

    @Override
    public LogInput resume(String sourceId, String inputId) {
        LogInput in = input(sourceId, inputId);
        if (in.kind() == InputKind.WATCH) {
            LogInput following = in.withStatus(InputStatus.FOLLOWING, null);
            inputs.save(following);
            watch.invalidate();
            for (LogInput child : inputs.byParent(inputId)) {
                if (child.status() == InputStatus.PAUSED || child.status() == InputStatus.FAILED) {
                    LogInput q = child.withStatus(InputStatus.QUEUED, null);
                    inputs.save(q);
                    ingest.start(q);
                }
            }
            watch.rescan(in.fileName().substring(0, in.fileName().indexOf('/')));
            notifications.sourcesChanged();
            return inputs.get(inputId).orElse(following);
        }
        if (in.status() == InputStatus.UPLOADING) {
            throw new LogsException(LogsException.Kind.CONFLICT, "The upload has not finished yet");
        }
        LogInput queued = in.withStatus(InputStatus.QUEUED, null);
        inputs.save(queued);
        ingest.start(queued);
        notifications.sourcesChanged();
        return inputs.get(inputId).orElse(queued);
    }

    @Override
    public void delete(String sourceId, String inputId) {
        LogInput in = input(sourceId, inputId);
        if (in.kind() == InputKind.WATCH) {
            watch.forget(inputId);
            for (LogInput child : inputs.byParent(inputId)) {
                ingest.stop(child.id());
                lines.deleteInput(sourceId, child.id());
                inputs.delete(child.id());
            }
        }
        ingest.stop(inputId);
        lines.deleteInput(sourceId, inputId);
        if (in.kind() == InputKind.UPLOAD) {
            uploadIdOf(in).ifPresent(u -> {
                files.deleteUpload(u);
                inputs.deleteUpload(u);
            });
        }
        inputs.delete(inputId);
        watch.invalidate();
        afterLinesRemoved(sourceId);
    }

    /** Counts, group aggregates and structure totals follow the lines that are left. */
    private void afterLinesRemoved(String sourceId) {
        long[] counts = lines.counts(sourceId);
        sources.setCounts(sourceId, counts[0], counts[1]);
        lines.rebuildGroups(sourceId);
        synchronized (ingest.lockFor(sourceId)) {
            lines.recountShapes(sourceId, structure(sourceId).fields().stream().filter(FieldDef::stored).toList());
            ingest.forgetSource(sourceId); // also drops cached query results
        }
        notifications.sourcesChanged();
        notifications.linesAdded(sourceId, 0, 0);
    }

    private static java.util.Optional<String> uploadIdOf(LogInput in) {
        if (in.path() == null) {
            return java.util.Optional.empty();
        }
        String name = java.nio.file.Path.of(in.path()).getFileName().toString();
        return name.endsWith(".ndjson") ? java.util.Optional.of(name.substring(0, name.length() - ".ndjson".length()))
                : java.util.Optional.empty();
    }

    @Override
    public void updateStructureSettings(String sourceId, int structureId, String name, String template) {
        LogStructure s = structure(sourceId);
        if (lines.shapes(sourceId).stream().noneMatch(x -> x.id() == structureId)) {
            throw LogsException.notFound("Structure");
        }
        if (name != null && name.strip().length() > MAX_NAME) {
            throw LogsException.bad("A structure name is at most " + MAX_NAME + " characters");
        }
        String t = template == null ? "" : template;
        if (t.length() > MAX_TEMPLATE) {
            throw LogsException.bad("Template is longer than " + MAX_TEMPLATE + " characters");
        }
        Matcher m = TOKEN.matcher(t);
        while (m.find()) {
            if (s.byLabel(m.group(1)).isEmpty()) {
                throw LogsException.bad("Template field {" + m.group(1) + "} does not exist");
            }
        }
        lines.saveShapeSettings(sourceId, structureId, name, t);
        ingest.changed(sourceId);
        notifications.structureChanged(sourceId, "");
    }

    @Override
    public SourceView moveStructure(String sourceId, int structureId, String newName) {
        LogSource source = source(sourceId);
        if (source.rawMode() == RawMode.OFFSET) {
            throw LogsException.bad("Moving lines needs raw lines copied into ALFRED");
        }
        List<String> raws = new ArrayList<>();
        lines.forEachShapeRaw(sourceId, structureId, raws::add);
        if (raws.isEmpty()) {
            throw LogsException.bad("This structure has no lines to move");
        }
        Preview preview = preview(raws.subList(0, Math.min(raws.size(), PREVIEW_LINES)), null);
        SourceView created = create(newName, source.rawMode(), source.privacyMode(), preview.structure());
        String uploadId = id("u", 8);
        long size;
        try {
            size = java.nio.file.Files.size(java.nio.file.Path.of(files.writeUpload(uploadId, raws)));
        } catch (IOException e) {
            throw new LogsException(LogsException.Kind.UNAVAILABLE, "Could not write the moved lines");
        }
        // One "chunk" covering the whole file: it was written here, not uploaded, so it is complete.
        LogInputStorePort.Upload u = new LogInputStorePort.Upload(uploadId, source.name() + " (S" + structureId + ")",
                size, (int) Math.min(Integer.MAX_VALUE, size), new TreeSet<>(Set.of(0)), null);
        inputs.saveUpload(u);
        add(created.source().id(), InputKind.UPLOAD, uploadId, null, true, true);
        lines.deleteShape(sourceId, structureId);
        afterLinesRemoved(sourceId);
        return created;
    }
}
