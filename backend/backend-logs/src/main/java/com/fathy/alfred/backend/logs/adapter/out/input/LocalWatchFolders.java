package com.fathy.alfred.backend.logs.adapter.out.input;

import com.fathy.alfred.backend.logs.application.port.out.WatchFoldersPort;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.io.RandomAccessFile;
import java.nio.file.FileSystems;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.PathMatcher;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;
import java.util.stream.Stream;

/**
 * {@code LOGS_WATCH_DIRS} ("name:hostPath,name:hostPath" - settings.properties {@code logs_watch_dirs},
 * overridable in .env) names the folders; each is mounted at {@code LOGS_WATCH_ROOT}/‹name› (start.py
 * writes the mounts). Names are checked against a strict pattern and every path is resolved inside its
 * folder, so nothing outside a configured folder is ever read (constitution I).
 */
@Component
public class LocalWatchFolders implements WatchFoldersPort {

    static final Pattern NAME = Pattern.compile("^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$");
    /** detail.log.1, detail.log.12, detail.log.2026-10-03, detail.log.2026-10-03.1, detail.log.2026-10-03_14 */
    static final Pattern ROTATION_SUFFIX = Pattern.compile("\\.(\\d{1,4}|\\d{4}-\\d{2}-\\d{2}([._-]\\d{1,4})?)$");
    static final Pattern COMPRESSED = Pattern.compile("\\.(gz|zip|bz2|xz|zst|7z)$", Pattern.CASE_INSENSITIVE);
    static final int MAX_FILES = 2_000;
    private static final int SCAN = 64 * 1024;

    @Value("${LOGS_WATCH_DIRS:}")
    private String watchDirs;
    @Value("${LOGS_WATCH_ROOT:/watch}")
    private String watchRoot;

    /** name → host path, in configured order; invalid entries are skipped. */
    Map<String, String> configured() {
        Map<String, String> out = new LinkedHashMap<>();
        if (watchDirs == null) {
            return out;
        }
        for (String entry : watchDirs.split(",")) {
            String e = entry.strip();
            int colon = e.indexOf(':');
            if (colon <= 0) {
                continue;
            }
            String name = e.substring(0, colon).strip();
            if (NAME.matcher(name).matches()) {
                out.put(name, e.substring(colon + 1).strip());
            }
        }
        return out;
    }

    private Path folderPath(String folder) {
        return Path.of(watchRoot).toAbsolutePath().normalize().resolve(folder).normalize();
    }

    @Override
    public List<Folder> folders() {
        List<Folder> out = new ArrayList<>();
        configured().forEach((name, host) -> out.add(new Folder(name, host, Files.isDirectory(folderPath(name)))));
        return out;
    }

    @Override
    public String dir(String folder) {
        if (folder == null || !configured().containsKey(folder)) {
            throw new IllegalArgumentException("Not a watched folder: " + folder + " (see logs_watch_dirs)");
        }
        Path p = folderPath(folder);
        if (!Files.isDirectory(p)) {
            throw new IllegalArgumentException("Watched folder " + folder + " is not mounted yet - run restart.py after changing logs_watch_dirs");
        }
        return p.toString();
    }

    @Override
    public List<WatchedFile> files(String folder, String pattern, boolean subfolders) throws IOException {
        Path root = Path.of(dir(folder));
        List<WatchedFile> out = new ArrayList<>();
        try (Stream<Path> s = subfolders ? Files.walk(root) : Files.list(root)) {
            s.filter(Files::isRegularFile).limit(MAX_FILES * 4L).forEach(p -> {
                WatchedFile f = match(folder, root.relativize(p).toString().replace('\\', '/'), pattern, subfolders);
                if (f != null && out.size() < MAX_FILES) {
                    out.add(f);
                }
            });
        }
        // Live files first (they are followed), then archives newest first (read for "the last N lines").
        out.sort(Comparator.comparing(WatchedFile::archive).thenComparing(Comparator.comparingLong(WatchedFile::modified).reversed()));
        return out;
    }

    @Override
    public WatchedFile match(String folder, String relative, String pattern, boolean subfolders) {
        if (relative == null || relative.isBlank()) {
            return null;
        }
        String rel = relative.replace('\\', '/');
        if (!subfolders && rel.contains("/")) {
            return null;
        }
        Path root = folderPath(folder);
        Path p = root.resolve(rel).normalize();
        if (!p.startsWith(root)) {
            return null; // never outside the folder
        }
        String name = p.getFileName().toString();
        if (COMPRESSED.matcher(name).find()) {
            return null; // compressed archives are not text
        }
        PathMatcher glob = FileSystems.getDefault().getPathMatcher("glob:" + (pattern == null || pattern.isBlank() ? "*" : pattern));
        boolean archive;
        if (glob.matches(Path.of(name))) {
            archive = false;
        } else {
            String base = ROTATION_SUFFIX.matcher(name).replaceFirst("");
            if (base.equals(name) || !glob.matches(Path.of(base))) {
                return null;
            }
            archive = true;
        }
        long size = 0;
        long modified = 0;
        try {
            if (Files.isRegularFile(p)) {
                size = Files.size(p);
                modified = Files.getLastModifiedTime(p).toMillis();
            }
        } catch (IOException ignored) {
            // A file that vanished between the event and the check: matched, size unknown.
        }
        return new WatchedFile(p.toString(), rel, size, modified, archive);
    }

    @Override
    public LastLines lastLines(String path, long lines) throws IOException {
        try (RandomAccessFile f = new RandomAccessFile(path, "r")) {
            long size = f.length();
            if (lines <= 0 || size == 0) {
                return new LastLines(size, 0);
            }
            // Only complete lines count: a last line still being written (no line break yet) is not part
            // of the window; it is read once it is complete.
            long end = size;
            f.seek(size - 1);
            if (f.read() != '\n') {
                long b = lastBreakBefore(f, size - 1);
                if (b < 0) {
                    return new LastLines(0, 0); // not one complete line yet
                }
                end = b + 1;
            }
            // The final break ends the last line; each earlier break starts a later line. The window
            // starts after the `lines`-th break before the final one.
            long found = 0;
            long pos = end - 1;
            byte[] buf = new byte[SCAN];
            while (pos > 0) {
                int len = (int) Math.min(SCAN, pos);
                long start = pos - len;
                f.seek(start);
                f.readFully(buf, 0, len);
                for (int i = len - 1; i >= 0; i--) {
                    if (buf[i] == '\n') {
                        found++;
                        if (found == lines) {
                            return new LastLines(start + i + 1, lines);
                        }
                    }
                }
                pos = start;
            }
            return new LastLines(0, found + 1); // the whole file: `found` earlier breaks + the first line
        }
    }

    private static long lastBreakBefore(RandomAccessFile f, long before) throws IOException {
        byte[] buf = new byte[SCAN];
        long pos = before;
        while (pos > 0) {
            int len = (int) Math.min(SCAN, pos);
            long start = pos - len;
            f.seek(start);
            f.readFully(buf, 0, len);
            for (int i = len - 1; i >= 0; i--) {
                if (buf[i] == '\n') {
                    return start + i;
                }
            }
            pos = start;
        }
        return -1;
    }
}
