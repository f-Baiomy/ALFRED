package com.fathy.alfred.backend.server.application.service;

import com.fathy.alfred.backend.server.application.port.in.CheckEnvUseCase;
import com.fathy.alfred.backend.server.application.port.in.InitEnvUseCase;
import com.fathy.alfred.backend.server.application.port.in.MergeDockerEnvUseCase;
import com.fathy.alfred.backend.server.application.port.out.DefaultsPort;
import com.fathy.alfred.backend.server.application.port.out.EnvFilePort;
import com.fathy.alfred.backend.server.domain.model.DockerEnvImport;
import com.fathy.alfred.backend.server.domain.model.EnvDocument;
import com.fathy.alfred.backend.server.domain.model.EnvLayout;
import com.fathy.alfred.backend.server.domain.model.SettingCatalog;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Map;

/**
 * Creating, importing into and checking .env. Free of Spring on purpose: ServerConfigCli runs it before any backend
 * exists (installer, first start). It is the one place a native install writes a whole .env, so the Python launcher
 * never has to (analysis I1).
 */
public class EnvBootstrapService implements InitEnvUseCase, MergeDockerEnvUseCase, CheckEnvUseCase {

    private final EnvFilePort envFile;
    private final DefaultsPort defaults;

    public EnvBootstrapService(EnvFilePort envFile, DefaultsPort defaults) {
        this.envFile = envFile;
        this.defaults = defaults;
    }

    @Override
    public boolean initIfMissing() {
        if (envFile.exists()) {
            return false;
        }
        envFile.write(EnvLayout.fresh(defaults.defaults()), EnvDocument.hashOf(""));
        return true;
    }

    @Override
    public Outcome merge(Map<String, String> dockerEnv, Path dockerFolder) {
        initIfMissing();
        EnvDocument current = envFile.read();
        DockerEnvImport.Result result = DockerEnvImport.merge(current, dockerEnv, dockerFolder);
        envFile.write(result.document(), current.contentHash());
        return new Outcome(result.copied(), result.dropped());
    }

    @Override
    public List<EnvProblem> problems() {
        EnvDocument document = envFile.read();
        List<EnvProblem> problems = new ArrayList<>();
        for (EnvDocument.Unknown unknown : document.unknownLines()) {
            problems.add(new EnvProblem(unknown.lineNumber(), unknown.text(), "not KEY=value"));
        }
        int lineNumber = 0;
        for (EnvDocument.Line line : document.lines()) {
            lineNumber++;
            if (line instanceof EnvDocument.Entry entry && SettingCatalog.find(entry.key()).isEmpty()) {
                String reason = DockerEnvImport.DOCKER_ONLY.contains(entry.key())
                        ? "only used by the Docker install, ignored here"
                        : "unknown key, ignored";
                problems.add(new EnvProblem(lineNumber, entry.text(), reason));
            }
        }
        problems.sort(Comparator.comparingInt(EnvProblem::line));
        return problems;
    }
}
