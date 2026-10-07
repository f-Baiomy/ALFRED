package com.fathy.alfred.backend.server.cli;

import com.fathy.alfred.backend.server.adapter.out.envfile.EnvFileAdapter;
import com.fathy.alfred.backend.server.adapter.out.envfile.SettingsPropertiesDefaultsAdapter;
import com.fathy.alfred.backend.server.application.port.in.MergeDockerEnvUseCase;
import com.fathy.alfred.backend.server.application.service.EnvBootstrapService;
import com.fathy.alfred.backend.server.domain.model.EnvProblem;

import java.io.PrintStream;
import java.nio.file.Path;
import java.util.Arrays;
import java.util.List;

/**
 * The settings engine without Spring (research R7): what the installer, the launcher and "alfred config" run when the
 * backend is not running. It is a composition root, like backend-app is for Spring, which is why it lives here and not
 * under adapter.in (inbound adapters may not build services or outbound adapters).
 *
 * <pre>
 *   java -cp alfred.jar com.fathy.alfred.backend.server.cli.ServerConfigCli [--home DIR] init
 *   ... merge-docker-env DOCKER_REPO_FOLDER
 *   ... check-env
 * </pre>
 * The install folder ("home") holds .env and settings.properties; it defaults to ALFRED_HOME, then the current folder.
 */
public final class ServerConfigCli {

    static final int OK = 0;
    static final int ERROR = 1;
    static final int USAGE = 2;

    private final PrintStream out;
    private final PrintStream err;

    ServerConfigCli(PrintStream out, PrintStream err) {
        this.out = out;
        this.err = err;
    }

    public static void main(String[] args) {
        System.exit(new ServerConfigCli(System.out, System.err).run(args));
    }

    int run(String[] args) {
        List<String> rest = Arrays.asList(args);
        Path home = Path.of(System.getenv().getOrDefault("ALFRED_HOME", "."));
        if (rest.size() >= 2 && rest.get(0).equals("--home")) {
            home = Path.of(rest.get(1));
            rest = rest.subList(2, rest.size());
        }
        if (rest.isEmpty()) {
            return usage();
        }
        EnvBootstrapService service = new EnvBootstrapService(new EnvFileAdapter(home.resolve(".env")),
                new SettingsPropertiesDefaultsAdapter(home.resolve("settings.properties")));
        try {
            return switch (rest.get(0)) {
                case "init" -> init(service, home);
                case "merge-docker-env" -> rest.size() == 2 ? mergeDockerEnv(service, Path.of(rest.get(1))) : usage();
                case "check-env" -> checkEnv(service);
                default -> usage();
            };
        } catch (RuntimeException e) {
            err.println("error: " + e.getMessage());
            return ERROR;
        }
    }

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

    private int usage() {
        err.println("usage: ServerConfigCli [--home DIR] init | merge-docker-env DOCKER_FOLDER | check-env");
        return USAGE;
    }
}
