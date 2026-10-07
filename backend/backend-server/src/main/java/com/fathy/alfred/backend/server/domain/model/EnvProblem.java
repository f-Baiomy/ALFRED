package com.fathy.alfred.backend.server.domain.model;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;

/**
 * A line of .env that Alfred does not use (FR-016): not KEY=value, an unknown key, or a key only the Docker install
 * reads. Reported at start (supervisor), in the Server section and by "alfred config list".
 *
 * @param line 1-based line number
 */
public record EnvProblem(int line, String text, String reason) {

    public static List<EnvProblem> of(EnvDocument document) {
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
