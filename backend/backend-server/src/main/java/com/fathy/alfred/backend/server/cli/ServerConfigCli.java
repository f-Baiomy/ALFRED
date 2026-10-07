package com.fathy.alfred.backend.server.cli;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.datatype.jsr310.JavaTimeModule;
import com.fathy.alfred.backend.server.adapter.out.envfile.EnvFileAdapter;
import com.fathy.alfred.backend.server.adapter.out.envfile.SettingsPropertiesDefaultsAdapter;
import com.fathy.alfred.backend.server.adapter.out.history.EnvHistoryFileAdapter;
import com.fathy.alfred.backend.server.adapter.out.history.PendingRestartFileAdapter;
import com.fathy.alfred.backend.server.adapter.out.probe.MachineAdapter;
import com.fathy.alfred.backend.server.application.port.in.MergeDockerEnvUseCase;
import com.fathy.alfred.backend.server.application.port.out.StorageStatsPort;
import com.fathy.alfred.backend.server.application.port.out.SupervisorPort;
import com.fathy.alfred.backend.server.application.service.EnvBootstrapService;
import com.fathy.alfred.backend.server.application.service.MachineProbes;
import com.fathy.alfred.backend.server.application.service.ServerSettingsService;
import com.fathy.alfred.backend.server.domain.model.EnvDocument;
import com.fathy.alfred.backend.server.domain.model.EnvProblem;
import com.fathy.alfred.backend.server.domain.model.HistoryEntry;
import com.fathy.alfred.backend.server.domain.model.RuntimeMode;
import com.fathy.alfred.backend.server.domain.model.ServerStatus;
import com.fathy.alfred.backend.server.domain.model.SettingCatalog;
import com.fathy.alfred.backend.server.domain.model.SettingDefinition;
import com.fathy.alfred.backend.server.domain.model.SettingKind;
import com.fathy.alfred.backend.server.domain.model.SettingsChange;
import com.fathy.alfred.backend.server.domain.model.ValidationResult;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.InvalidPathException;
import java.nio.file.Path;
import java.time.Clock;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.NoSuchElementException;
import java.util.Optional;
import java.util.function.Function;
import java.util.stream.Collectors;

/**
 * The settings engine without Spring (research R7): what the installer, the launcher and "alfred config" run. It is a
 * composition root, like backend-app is for Spring, which is why it lives here and not under adapter.in (inbound
 * adapters may not build services or outbound adapters).
 *
 * <pre>
 *   java ... ServerConfigCli [--home DIR] [--backend URL] [--user NAME] COMMAND ...
 *     init | merge-docker-env DOCKER_FOLDER | check-env                       (installer and launcher)
 *     list [--changed] | get KEY | set KEY VALUE | reset KEY | add KEY ITEM | remove KEY ITEM
 *     add-missing | check | diff | history | revert ID [--yes] | import FILE [--yes]
 *     project-add NAME LISTEN APP [--outbound HOST[:PORT]] | project-remove NAME
 * </pre>
 * The settings commands go through the running backend at {@code --backend} when it answers (a change then applies
 * live, exactly as from the UI) and through the files otherwise (it takes effect at the next start). The output is the
 * same either way. The install folder ("home") holds .env and settings.properties; it defaults to ALFRED_HOME, then the
 * current folder.
 */
public final class ServerConfigCli {

    static final int OK = 0;
    static final int ERROR = 1;
    static final int USAGE = 2;
    static final int REFUSED = 3;
    static final int CONFLICT = 4;

    private static final DateTimeFormatter WHEN = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm").withZone(ZoneId.systemDefault());

    private final PrintStream out;
    private final PrintStream err;
    private final BufferedReader in;
    private final Marks marks;
    /** Builds the settings client; replaced by tests. */
    Function<Options, SettingsClient> clients = this::client;

    record Options(Path home, String backend, String user) {
    }

    /** ✓ ⚠ ✗ where the console can show them, plain words where it cannot (a Windows code page, LANG=C). */
    record Marks(String ok, String warning, String error, String arrow) {
        static final Marks UNICODE = new Marks("✓", "⚠", "✗", "→");
        static final Marks ASCII = new Marks("ok", "warning", "error", "->");
    }

    ServerConfigCli(PrintStream out, PrintStream err) {
        this(out, err, new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8)), Marks.UNICODE);
    }

    ServerConfigCli(PrintStream out, PrintStream err, BufferedReader in, Marks marks) {
        this.out = out;
        this.err = err;
        this.in = in;
        this.marks = marks;
    }

    public static void main(String[] args) {
        String encoding = System.getProperty("stdout.encoding", System.getProperty("native.encoding", ""));
        boolean unicode = encoding.toUpperCase().replace("-", "").equals("UTF8");
        PrintStream out = System.out;
        System.exit(new ServerConfigCli(out, System.err, new BufferedReader(new InputStreamReader(System.in)),
                unicode ? Marks.UNICODE : Marks.ASCII).run(args));
    }

    int run(String[] args) {
        List<String> rest = new ArrayList<>(Arrays.asList(args));
        Path home = Path.of(System.getenv().getOrDefault("ALFRED_HOME", "."));
        String backend = null;
        String user = System.getProperty("user.name", "unknown");
        while (rest.size() >= 2 && rest.get(0).startsWith("--")) {
            switch (rest.get(0)) {
                case "--home" -> home = Path.of(rest.get(1));
                case "--backend" -> backend = rest.get(1);
                case "--user" -> user = rest.get(1);
                default -> {
                    return usage();
                }
            }
            rest = rest.subList(2, rest.size());
        }
        if (rest.isEmpty()) {
            return usage();
        }
        String command = rest.get(0);
        List<String> params = rest.subList(1, rest.size());
        try {
            switch (command) {
                case "init", "merge-docker-env", "check-env" -> {
                    EnvBootstrapService service = new EnvBootstrapService(new EnvFileAdapter(home.resolve(".env")),
                            new SettingsPropertiesDefaultsAdapter(home.resolve("settings.properties")));
                    return switch (command) {
                        case "init" -> init(service, home);
                        case "merge-docker-env" -> params.size() == 1 ? mergeDockerEnv(service, Path.of(params.get(0))) : usage();
                        default -> checkEnv(service);
                    };
                }
                case "record-upgrade" -> {
                    return params.size() == 2 ? recordUpgrade(home, params.get(0), params.get(1)) : usage();
                }
                default -> {
                    return settings(command, params, new Options(home, backend, user));
                }
            }
        } catch (SettingsClient.Refused e) {
            return refused(e);
        } catch (NoSuchElementException | IllegalArgumentException e) {
            err.println(marks.error + " " + e.getMessage());
            return ERROR;
        } catch (RuntimeException e) {
            // The class too: an exception without a message used to print just "error: null".
            err.println("error: " + e.getClass().getSimpleName() + (e.getMessage() == null ? "" : ": " + e.getMessage()));
            return ERROR;
        }
    }

    // ------------------------------------------------------------------------------------------------------------------
    // installer and launcher
    // ------------------------------------------------------------------------------------------------------------------

    private int init(EnvBootstrapService service, Path home) {
        boolean created = service.initIfMissing();
        out.println(created
                ? "Created " + home.resolve(".env").toAbsolutePath().normalize() + " with every setting at its default."
                : ".env already exists - left as it is.");
        return OK;
    }

    private int mergeDockerEnv(EnvBootstrapService service, Path dockerFolder) {
        EnvFileAdapter dockerEnv = new EnvFileAdapter(dockerFolder.resolve(".env"));
        if (!dockerEnv.exists()) {
            err.println("error: no .env in " + dockerFolder);
            return ERROR;
        }
        MergeDockerEnvUseCase.Outcome outcome =
                service.merge(dockerEnv.read().entries(), dockerFolder.toAbsolutePath().normalize());
        out.println("Imported " + outcome.copied().size() + " settings from " + dockerFolder.resolve(".env") + ".");
        if (!outcome.dropped().isEmpty()) {
            out.println("  Skipped (Docker only or unknown): " + String.join(", ", outcome.dropped()));
        }
        return OK;
    }

    /**
     * The installers call this after an upgrade (contracts/installer-and-build.md): one UPGRADE entry in the
     * settings history, so "when did this server move to version X" can be answered from the Server section's
     * History like any other change. .env itself is not touched, so before and after are the same content.
     */
    private int recordUpgrade(Path home, String from, String to) {
        EnvFileAdapter envFile = new EnvFileAdapter(home.resolve(".env"));
        String content = envFile.exists() ? envFile.read().render() : "";
        ObjectMapper mapper = new ObjectMapper().registerModule(new JavaTimeModule())
                .disable(com.fasterxml.jackson.databind.SerializationFeature.WRITE_DATES_AS_TIMESTAMPS);
        long id = new EnvHistoryFileAdapter(home.resolve("data"), mapper, Clock.systemUTC())
                .append(HistoryEntry.HistorySource.UPGRADE, from + " " + marks.arrow + " " + to, List.of(), content, content);
        out.println("Recorded upgrade " + from + " " + marks.arrow + " " + to + " (history #" + id + ").");
        return OK;
    }

    private int checkEnv(EnvBootstrapService service) {
        List<EnvProblem> problems = service.problems();
        if (problems.isEmpty()) {
            return OK;
        }
        out.println(".env: " + problems.size() + (problems.size() == 1 ? " line" : " lines") + " not used:");
        for (EnvProblem problem : problems) {
            out.println("  line " + problem.line() + ": \"" + problem.text() + "\" (" + problem.reason() + ")");
        }
        return OK;
    }

    // ------------------------------------------------------------------------------------------------------------------
    // alfred config / alfred project
    // ------------------------------------------------------------------------------------------------------------------

    private int settings(String command, List<String> params, Options options) {
        SettingsClient client;
        switch (command) {
            case "list", "get", "set", "reset", "add", "remove", "add-missing", "check", "diff", "history", "revert",
                 "import", "project-add", "project-remove" -> client = clients.apply(options);
            default -> {
                return usage();
            }
        }
        return switch (command) {
            case "list" -> list(client, params.contains("--changed"));
            case "get" -> params.size() == 1 ? get(client, params.get(0)) : usage();
            case "set" -> params.size() == 2 ? save(client, List.of(SettingsChange.Edit.set(definition(params.get(0)).key(), params.get(1)))) : usage();
            case "reset" -> params.size() == 1 ? save(client, List.of(SettingsChange.Edit.reset(definition(params.get(0)).key()))) : usage();
            case "add" -> params.size() == 2 ? addItem(client, params.get(0), params.get(1)) : usage();
            case "remove" -> params.size() == 2 ? removeItem(client, params.get(0), params.get(1)) : usage();
            case "add-missing" -> params.isEmpty() ? addMissing(client) : usage();
            case "check" -> params.isEmpty() ? check(client) : usage();
            case "diff" -> params.isEmpty() ? list(client, true) : usage();
            case "history" -> params.isEmpty() ? history(client) : usage();
            case "revert" -> params.size() >= 1 ? revert(client, Long.parseLong(params.get(0)), params.contains("--yes")) : usage();
            case "import" -> params.size() >= 1 ? importFile(client, Path.of(params.get(0)), params.contains("--yes")) : usage();
            case "project-add" -> projectAdd(client, params);
            case "project-remove" -> params.size() == 1 ? removeItem(client, "INTERNAL_CALL_SERVICES", params.get(0)) : usage();
            default -> usage();
        };
    }

    /**
     * The running backend when it answers AND is this install's, else the same service on the files. Another Alfred
     * on the same machine (Docker, or a second native install) answers the UI port the same way; without the
     * identity check a `config set` edited that other install's .env and reported success.
     */
    SettingsClient client(Options options) {
        if (options.backend() != null && HttpSettingsClient.answers(options.backend())) {
            Optional<String> installDir = HttpSettingsClient.installDir(options.backend());
            if (installDir.isPresent() && sameFolder(installDir.get(), options.home())) {
                return new HttpSettingsClient(options.backend(), options.user());
            }
            err.println("note: the Alfred answering on " + options.backend() + " is "
                    + installDir.filter(d -> !d.isBlank()).map(d -> "another install (" + d + ")").orElse("not this install")
                    + ". This install is stopped - its files are edited directly.");
        }
        return new LocalSettingsClient(localService(options.home()), options.user());
    }

    static boolean sameFolder(String reported, Path home) {
        try {
            Path other = Path.of(reported);
            if (Files.exists(other) && Files.exists(home)) {
                return Files.isSameFile(other, home);
            }
            return other.toAbsolutePath().normalize().toString().equalsIgnoreCase(home.toAbsolutePath().normalize().toString());
        } catch (IOException | InvalidPathException e) {
            return false;
        }
    }

    static ServerSettingsService localService(Path home) {
        Path data = home.resolve("data");
        ObjectMapper mapper = new ObjectMapper().registerModule(new JavaTimeModule())
                .disable(com.fasterxml.jackson.databind.SerializationFeature.WRITE_DATES_AS_TIMESTAMPS); // as Spring writes them
        EnvFileAdapter envFile = new EnvFileAdapter(home.resolve(".env"));
        SettingsPropertiesDefaultsAdapter defaults = new SettingsPropertiesDefaultsAdapter(home.resolve("settings.properties"));
        StorageStatsPort noStats = new StorageStatsPort() {
            @Override
            public long usedBytes(String key) {
                return -1;
            }

            @Override
            public long inboundCallsLastHour() {
                return 0;
            }
        };
        // Nothing is running: every port is checked as free-or-taken, nothing is "ours".
        MachineProbes probes = new MachineProbes(new MachineAdapter(data), noStats, Map::of, home);
        return new ServerSettingsService(envFile, defaults, new EnvHistoryFileAdapter(data, mapper, Clock.systemUTC()),
                new PendingRestartFileAdapter(data, mapper),
                (key, effective) -> {
                    throw new IllegalArgumentException("Alfred is not running");
                },
                new StoppedSupervisor(), key -> Optional.empty(), what -> { }, RuntimeMode.NATIVE, Clock.systemUTC(),
                probes::check);
    }

    private static final class StoppedSupervisor implements SupervisorPort {
        @Override
        public boolean available() {
            return false;
        }

        @Override
        public List<String> reload() {
            return List.of();
        }

        @Override
        public void restartBackend() {
            throw new IllegalStateException("Alfred is not running");
        }

        @Override
        public void restartProxies() {
            throw new IllegalStateException("Alfred is not running");
        }

        @Override
        public boolean installUpdate(String version, String url, String sha256, long size) {
            return false;
        }

        @Override
        public Optional<com.fathy.alfred.backend.server.domain.model.UpdateJob> updateJob() {
            return Optional.empty();
        }

        @Override
        public Optional<List<ServerStatus.ProcessStatus>> processes() {
            return Optional.empty();
        }
    }

    private static SettingDefinition definition(String key) {
        return SettingCatalog.find(key).orElseThrow(() -> new IllegalArgumentException(key + ": not a setting. 'alfred config list' shows them all."));
    }

    private int list(SettingsClient client, boolean changedOnly) {
        SettingsClient.View view = client.view();
        List<SettingsClient.Setting> rows = view.settings().stream().filter(s -> !changedOnly || s.differsFromDefault()).toList();
        int keyWidth = rows.stream().mapToInt(s -> s.key().length()).max().orElse(3);
        int valueWidth = Math.min(48, rows.stream().mapToInt(s -> shown(s).length()).max().orElse(5));
        out.printf("%-" + keyWidth + "s  %-" + valueWidth + "s  %-8s  %s%n", "KEY", "VALUE", "FROM", "APPLIES");
        for (SettingsClient.Setting s : rows) {
            out.printf("%-" + keyWidth + "s  %-" + valueWidth + "s  %-8s  %s%n", s.key(), shown(s),
                    s.source().equals("ENV_FILE") ? ".env" : s.source().equals("DEFAULT") ? "default" : "process", applies(s.applies()));
        }
        if (changedOnly && rows.isEmpty()) {
            out.println("(every setting is at its default)");
        }
        if (!view.missingFromEnv().isEmpty()) {
            out.println();
            out.println(view.missingFromEnv().size() + " not in .env (their default applies): " + String.join(", ", view.missingFromEnv()));
            out.println("  'alfred config add-missing' writes them with their defaults.");
        }
        if (!view.unusedLines().isEmpty()) {
            out.println();
            out.println(".env lines not used:");
            view.unusedLines().forEach(l -> out.println("  " + l));
        }
        return OK;
    }

    private static String shown(SettingsClient.Setting s) {
        if (s.kind().equals(SettingKind.SECRET.name())) {
            return s.isSet() ? "(set)" : "(not set)";
        }
        return s.value() == null || s.value().isEmpty() ? "(empty)" : s.value();
    }

    private static String applies(String applies) {
        return switch (applies) {
            case "LIVE" -> "live";
            case "PROXIES" -> "proxies restart";
            default -> "restart";
        };
    }

    private int get(SettingsClient client, String key) {
        SettingDefinition definition = definition(key);
        SettingsClient.Setting setting = setting(client.view(), definition.key());
        out.println(definition.secret() ? shown(setting) : Optional.ofNullable(setting.value()).orElse(""));
        return OK;
    }

    private static SettingsClient.Setting setting(SettingsClient.View view, String key) {
        return view.settings().stream().filter(s -> s.key().equals(key)).findFirst()
                .orElseThrow(() -> new IllegalArgumentException(key + ": not a setting"));
    }

    private int save(SettingsClient client, List<SettingsChange.Edit> edits) {
        SettingsClient.View view = client.view();
        List<SettingsClient.Applied> applied = client.save(view.envHash(), edits);
        if (applied.isEmpty()) {
            out.println("Nothing changed.");
            return OK;
        }
        SettingsClient.View after = client.view();
        for (SettingsClient.Applied a : applied) {
            SettingsClient.Setting before = setting(view, a.key());
            SettingsClient.Setting now = setting(after, a.key());
            out.println(marks.ok + " .env: " + a.key() + " " + shown(before) + " " + marks.arrow + " " + shown(now)
                    + (now.source().equals("DEFAULT") ? " (default)" : "") + "   " + outcome(a));
        }
        if (client.where().equals("files")) {
            out.println("Alfred is not running: the change takes effect when it starts.");
        }
        return OK;
    }

    private String outcome(SettingsClient.Applied a) {
        return switch (a.outcome()) {
            case "APPLIED" -> "applied live";
            case "PROXIES_RESTARTED" -> "proxies restarted" + (a.detail().isBlank() ? "" : " (" + a.detail() + ")");
            case "PENDING_RESTART" -> "restart needed: run 'alfred restart'";
            default -> a.detail().isBlank() ? "saved" : a.detail();
        };
    }

    private int refused(SettingsClient.Refused e) {
        if (e.conflict) {
            err.println(marks.error + " .env was changed by someone else while this command ran. Nothing saved - run it again.");
            return CONFLICT;
        }
        for (ValidationResult r : e.results) {
            if (r.level() == ValidationResult.Level.ERROR) {
                err.println(marks.error + " " + r.key() + ": " + r.message() + ".");
            }
        }
        err.println("Nothing saved.");
        return REFUSED;
    }

    private int addItem(SettingsClient client, String key, String item) {
        SettingDefinition definition = listDefinition(key);
        List<String> items = items(setting(client.view(), definition.key()).value());
        String name = itemName(definition, item);
        if (items.stream().anyMatch(i -> itemName(definition, i).equals(name))) {
            throw new IllegalArgumentException(definition.key() + " already has " + name + ". Remove it first to change it.");
        }
        items.add(item.strip());
        return save(client, List.of(SettingsChange.Edit.set(definition.key(), String.join(",", items))));
    }

    private int removeItem(SettingsClient client, String key, String item) {
        SettingDefinition definition = listDefinition(key);
        List<String> items = items(setting(client.view(), definition.key()).value());
        String name = itemName(definition, item);
        if (!items.removeIf(i -> i.equals(item.strip()) || itemName(definition, i).equals(name))) {
            throw new IllegalArgumentException(definition.key() + " has no " + item + ". It has: "
                    + (items.isEmpty() ? "nothing" : String.join(", ", items)));
        }
        return save(client, List.of(SettingsChange.Edit.set(definition.key(), String.join(",", items))));
    }

    private static SettingDefinition listDefinition(String key) {
        SettingDefinition definition = definition(key);
        if (!definition.list()) {
            throw new IllegalArgumentException(definition.key() + " is not a list: use 'alfred config set'.");
        }
        return definition;
    }

    private static List<String> items(String value) {
        List<String> items = new ArrayList<>();
        for (String item : (value == null ? "" : value).split(",")) {
            if (!item.isBlank()) {
                items.add(item.strip());
            }
        }
        return items;
    }

    /** Projects and watched folders are named by what comes before the first colon; other lists by the whole item. */
    private static String itemName(SettingDefinition definition, String item) {
        String stripped = item.strip();
        if (definition.kind() == SettingKind.ACCESS_LIST) {
            return stripped;
        }
        int colon = stripped.indexOf(':');
        return colon < 0 ? stripped : stripped.substring(0, colon);
    }

    private int projectAdd(SettingsClient client, List<String> params) {
        List<String> args = new ArrayList<>(params);
        String outbound = null;
        int flag = args.indexOf("--outbound");
        if (flag >= 0) {
            if (flag + 1 >= args.size()) {
                return usage();
            }
            outbound = args.get(flag + 1);
            args.remove(flag + 1);
            args.remove(flag);
        }
        if (args.size() != 3) {
            return usage();
        }
        String entry = args.get(0) + ":" + args.get(1) + ":" + args.get(2) + (outbound == null ? "" : ":" + outbound);
        return addItem(client, "INTERNAL_CALL_SERVICES", entry);
    }

    private int addMissing(SettingsClient client) {
        List<SettingsClient.Applied> applied = client.addMissing();
        if (applied.isEmpty()) {
            out.println("Every setting is already in .env.");
            return OK;
        }
        out.println(marks.ok + " Added " + applied.size() + " settings to .env with their defaults: "
                + applied.stream().map(SettingsClient.Applied::key).collect(Collectors.joining(", ")));
        return OK;
    }

    private int check(SettingsClient client) {
        List<ValidationResult> results = client.check(List.of(), true);
        boolean failed = false;
        Map<String, List<ValidationResult>> byKey = new LinkedHashMap<>();
        results.forEach(r -> byKey.computeIfAbsent(r.key(), k -> new ArrayList<>()).add(r));
        for (Map.Entry<String, List<ValidationResult>> entry : byKey.entrySet()) {
            for (ValidationResult r : entry.getValue()) {
                String mark = switch (r.level()) {
                    case ERROR -> marks.error;
                    case WARNING -> marks.warning;
                    default -> marks.ok;
                };
                failed |= r.level() == ValidationResult.Level.ERROR;
                out.println(mark + " " + r.key() + (r.message().isBlank() ? "" : ": " + r.message()));
            }
        }
        if (results.isEmpty()) {
            out.println(marks.ok + " nothing to check");
        }
        return failed ? REFUSED : OK;
    }

    private int history(SettingsClient client) {
        List<HistoryEntry> entries = client.history(50);
        if (entries.isEmpty()) {
            out.println("No changes recorded yet.");
            return OK;
        }
        for (HistoryEntry e : entries) {
            String by = e.source().name() + (e.sourceDetail() == null || e.sourceDetail().isBlank() ? "" : " " + e.sourceDetail());
            String changes = e.changes().stream().map(c -> c.key() + " " + Optional.ofNullable(c.before()).orElse("(none)")
                    + " " + marks.arrow + " " + Optional.ofNullable(c.after()).orElse("(default)")).collect(Collectors.joining("; "));
            out.printf("#%-4d %s  %-24s %s%n", e.id(), WHEN.format(e.at()), by, changes.isEmpty() ? "(no setting changed)" : changes);
        }
        out.println("'alfred config revert ID' puts the values from before an entry back.");
        return OK;
    }

    private int revert(SettingsClient client, long id, boolean yes) {
        List<SettingsChange.Edit> edits = client.revert(id);
        if (edits.isEmpty()) {
            out.println("Nothing to revert: the values are already what they were before #" + id + ".");
            return OK;
        }
        SettingsClient.View view = client.view();
        out.println("Reverting #" + id + " changes:");
        for (SettingsChange.Edit edit : edits) {
            out.println("  " + edit.key() + " " + shown(setting(view, edit.key())) + " " + marks.arrow + " "
                    + (edit.reset() ? "(default)" : definition(edit.key()).secret() ? "(previous secret)" : edit.value()));
        }
        if (!yes && !ask("Save? [y/N] ")) {
            out.println("Nothing saved.");
            return OK;
        }
        return save(client, edits);
    }

    private int importFile(SettingsClient client, Path file, boolean yes) {
        String text;
        try {
            text = Files.readString(file, StandardCharsets.UTF_8);
        } catch (IOException e) {
            throw new IllegalArgumentException("cannot read " + file + ": " + e.getMessage());
        }
        EnvDocument incoming = EnvDocument.parse(text);
        SettingsClient.View view = client.view();
        List<SettingsChange.Edit> taken = new ArrayList<>();
        List<String> skipped = new ArrayList<>();
        for (Map.Entry<String, String> entry : incoming.entries().entrySet()) {
            Optional<SettingDefinition> definition = SettingCatalog.find(entry.getKey());
            if (definition.isEmpty()) {
                skipped.add(entry.getKey());
                continue;
            }
            SettingsClient.Setting current = setting(view, entry.getKey());
            if (!definition.get().secret() && entry.getValue().equals(current.value())) {
                continue;
            }
            SettingsChange.Edit edit = SettingsChange.Edit.set(entry.getKey(), entry.getValue());
            List<ValidationResult> results = client.check(List.of(edit), false).stream().filter(r -> r.key().equals(entry.getKey())).toList();
            String incomingShown = definition.get().secret() ? "(a secret)" : entry.getValue();
            out.println(entry.getKey() + ": " + shown(current) + " " + marks.arrow + " " + incomingShown);
            boolean invalid = false;
            for (ValidationResult r : results) {
                if (r.level() != ValidationResult.Level.OK && !r.message().isBlank()) {
                    out.println("  " + (r.level() == ValidationResult.Level.ERROR ? marks.error : marks.warning) + " " + r.message());
                }
                invalid |= r.level() == ValidationResult.Level.ERROR;
            }
            if (invalid) {
                out.println("  not taken: the value is not valid");
                continue;
            }
            if (yes || ask("  take? [y/N] ")) {
                taken.add(edit);
            }
        }
        if (!skipped.isEmpty()) {
            out.println("Not settings, skipped: " + String.join(", ", skipped));
        }
        if (taken.isEmpty()) {
            out.println("Nothing to save.");
            return OK;
        }
        return save(client, taken);
    }

    private boolean ask(String question) {
        out.print(question);
        out.flush();
        try {
            String answer = in.readLine();
            return answer != null && (answer.strip().equalsIgnoreCase("y") || answer.strip().equalsIgnoreCase("yes"));
        } catch (IOException e) {
            return false;
        }
    }

    private int usage() {
        err.println("""
                usage: alfred config list [--changed] | get KEY | set KEY VALUE | reset KEY
                       alfred config add KEY ITEM | remove KEY ITEM | add-missing | check | diff
                       alfred config history | revert ID [--yes] | import FILE [--yes]
                       alfred project add NAME LISTEN_PORT APP_PORT [--outbound HOST[:PORT]] | project remove NAME""");
        return USAGE;
    }
}
