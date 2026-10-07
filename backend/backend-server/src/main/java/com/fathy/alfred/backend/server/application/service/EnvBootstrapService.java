package com.fathy.alfred.backend.server.application.service;

import com.fathy.alfred.backend.server.application.port.in.CheckEnvUseCase;
import com.fathy.alfred.backend.server.application.port.in.InitEnvUseCase;
import com.fathy.alfred.backend.server.application.port.in.MergeDockerEnvUseCase;
import com.fathy.alfred.backend.server.application.port.out.DefaultsPort;
import com.fathy.alfred.backend.server.application.port.out.EnvFilePort;
import com.fathy.alfred.backend.server.domain.model.DockerEnvImport;
import com.fathy.alfred.backend.server.domain.model.EnvDocument;
import com.fathy.alfred.backend.server.domain.model.EnvLayout;
import com.fathy.alfred.backend.server.domain.model.EnvProblem;

import java.nio.file.Path;
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
        return EnvProblem.of(envFile.read());
    }
}
