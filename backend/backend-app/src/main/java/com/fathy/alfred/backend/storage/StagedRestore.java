package com.fathy.alfred.backend.storage;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.env.EnvironmentPostProcessor;
import org.springframework.core.env.ConfigurableEnvironment;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.nio.file.StandardCopyOption;
import java.time.Instant;
import java.util.List;
import java.util.stream.Stream;

/**
 * Applies a restore prepared on the storage page (StorageBackups.stageRestore) at start, before any store opens its
 * file: each staged file replaces the live one, which - with its write log - is moved to
 * {@code data/restore-replaced/<time>/}, never deleted. Runs as an EnvironmentPostProcessor (registered in
 * META-INF/spring.factories) because that is the last moment no bean has opened a database yet.
 */
public class StagedRestore implements EnvironmentPostProcessor {

    @Override
    public void postProcessEnvironment(ConfigurableEnvironment environment, SpringApplication application) {
        String calls = environment.getProperty("CALLS_DB_FILE", "/appdata/calls.db");
        Path parent = Paths.get(calls).toAbsolutePath().getParent();
        if (parent != null) {
            apply(parent);
        }
    }

    /** Returns the files it put in place (empty when nothing was waiting). */
    static List<String> apply(Path dataDir) {
        Path pending = dataDir.resolve("restore-pending");
        if (!Files.isRegularFile(pending.resolve(StorageBackups.READY))) {
            return List.of();
        }
        List<String> known = StorageBackups.GROUPS.values().stream().flatMap(List::stream).toList();
        Path replaced = dataDir.resolve("restore-replaced").resolve(Instant.now().toString().replace(':', '-'));
        try (Stream<Path> s = Files.list(pending)) {
            List<Path> staged = s.filter(p -> known.contains(p.getFileName().toString())).toList();
            Files.createDirectories(replaced);
            for (Path file : staged) {
                String name = file.getFileName().toString();
                for (String suffix : List.of("", "-wal", "-shm")) {
                    Path live = dataDir.resolve(name + suffix);
                    if (Files.exists(live)) {
                        Files.move(live, replaced.resolve(name + suffix), StandardCopyOption.REPLACE_EXISTING);
                    }
                }
                Files.move(file, dataDir.resolve(name), StandardCopyOption.REPLACE_EXISTING);
            }
            Files.deleteIfExists(pending.resolve(StorageBackups.READY));
            try (Stream<Path> rest = Files.list(pending)) {
                for (Path p : rest.toList()) {
                    Files.deleteIfExists(p);
                }
            }
            Files.deleteIfExists(pending);
            System.out.println("Alfred: restored " + staged.size() + " store file(s) from a backup; the replaced ones are in " + replaced);
            return staged.stream().map(p -> p.getFileName().toString()).toList();
        } catch (IOException e) {
            System.err.println("Alfred: could not apply the prepared restore (" + e.getMessage() + "); it stays in " + pending);
            return List.of();
        }
    }
}
