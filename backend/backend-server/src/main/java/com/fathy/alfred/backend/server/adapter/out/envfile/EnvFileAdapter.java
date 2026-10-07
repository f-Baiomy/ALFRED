package com.fathy.alfred.backend.server.adapter.out.envfile;

import com.fathy.alfred.backend.server.application.port.out.EnvConflictException;
import com.fathy.alfred.backend.server.application.port.out.EnvFilePort;
import com.fathy.alfred.backend.server.domain.model.EnvDocument;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.nio.file.attribute.PosixFileAttributeView;
import java.nio.file.attribute.PosixFilePermission;
import java.nio.file.attribute.PosixFilePermissions;
import java.util.Set;

/**
 * .env on disk. A write goes to a temp file in the same folder, is forced to disk, then moved over the old file in
 * one step, so a reader (the supervisor, the CLI, a crash) never sees half a file. The file holds secrets, so it stays
 * owner-only: the old file's POSIX permissions are kept, and a new file gets rw------- (on Windows the install
 * folder's ACL, set by the installer, applies).
 *
 * <p>Plain class on purpose (no Spring annotations): ServerConfigCli builds it without a Spring context.
 */
public class EnvFileAdapter implements EnvFilePort {

    private static final Logger log = LoggerFactory.getLogger(EnvFileAdapter.class);
    private static final Set<PosixFilePermission> OWNER_ONLY = PosixFilePermissions.fromString("rw-------");

    private final Path file;

    public EnvFileAdapter(Path file) {
        this.file = file.toAbsolutePath().normalize();
    }

    /** Loud at startup when saving could never work (Constitution I: failures are loud). */
    public void checkWritable() {
        Path folder = file.getParent();
        if (folder == null || !Files.isDirectory(folder) || !Files.isWritable(folder)
                || (Files.exists(file) && !Files.isWritable(file))) {
            log.error("Settings file {} is not writable - server settings cannot be saved until it is", file);
        }
    }

    @Override
    public boolean exists() {
        return Files.isRegularFile(file);
    }

    @Override
    public EnvDocument read() {
        if (!exists()) {
            return EnvDocument.empty();
        }
        try {
            return EnvDocument.parse(Files.readString(file, StandardCharsets.UTF_8));
        } catch (IOException e) {
            log.error("Could not read settings file {}", file, e);
            throw new UncheckedIOException(e);
        }
    }

    @Override
    public synchronized void write(EnvDocument document, String expectedHash) {
        String current = currentHash();
        if (expectedHash != null && !expectedHash.equals(current)) {
            throw new EnvConflictException(current);
        }
        Path folder = file.getParent();
        Path temp = null;
        try {
            Set<PosixFilePermission> permissions = exists() ? posixPermissions(file) : OWNER_ONLY;
            temp = Files.createTempFile(folder, ".env.", ".tmp");
            try (FileChannel channel = FileChannel.open(temp, StandardOpenOption.WRITE, StandardOpenOption.TRUNCATE_EXISTING)) {
                channel.write(ByteBuffer.wrap(document.render().getBytes(StandardCharsets.UTF_8)));
                channel.force(true);
            }
            if (permissions != null) {
                Files.setPosixFilePermissions(temp, permissions);
            }
            try {
                Files.move(temp, file, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
            } catch (AtomicMoveNotSupportedException e) {
                Files.move(temp, file, StandardCopyOption.REPLACE_EXISTING);
            }
            temp = null;
        } catch (IOException e) {
            log.error("Could not write settings file {}", file, e);
            throw new UncheckedIOException("Could not write " + file + ": " + e.getMessage(), e);
        } finally {
            if (temp != null) {
                try {
                    Files.deleteIfExists(temp);
                } catch (IOException e) {
                    log.warn("Could not remove temp file {}", temp, e);
                }
            }
        }
    }

    @Override
    public String location() {
        return file.toString();
    }

    private String currentHash() {
        try {
            return EnvDocument.hashOf(exists() ? Files.readString(file, StandardCharsets.UTF_8) : "");
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    /** The file's POSIX permissions, or null where the file system has none (Windows). */
    private static Set<PosixFilePermission> posixPermissions(Path path) throws IOException {
        PosixFileAttributeView view = Files.getFileAttributeView(path, PosixFileAttributeView.class);
        return view == null ? null : view.readAttributes().permissions();
    }
}
