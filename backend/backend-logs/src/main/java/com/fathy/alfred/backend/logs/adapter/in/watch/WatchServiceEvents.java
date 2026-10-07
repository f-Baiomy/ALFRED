package com.fathy.alfred.backend.logs.adapter.in.watch;

import com.fathy.alfred.backend.logs.application.port.in.WatchFoldersUseCase;
import com.fathy.alfred.backend.logs.application.port.out.WatchFoldersPort;
import jakarta.annotation.PreDestroy;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.nio.file.FileSystems;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardWatchEventKinds;
import java.nio.file.WatchEvent;
import java.nio.file.WatchKey;
import java.nio.file.WatchService;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.stream.Stream;

/**
 * Change notifications from the kernel (inotify on Linux) for every watched folder and its subfolders:
 * one blocking thread, woken only when something in a watched folder changes - no timer. Used when
 * ALFRED runs on Linux, or when the log writer shares a Docker volume with it ({@code LOGS_WATCH_MODE=events}).
 * On Docker Desktop (Windows/macOS) host changes produce no events inside the container; the host agent
 * reports them instead ({@code LogAgentController}).
 */
@Component
@ConditionalOnProperty(name = "LOGS_WATCH_MODE", havingValue = "events", matchIfMissing = true)
public class WatchServiceEvents {

    private static final Logger log = LoggerFactory.getLogger(WatchServiceEvents.class);

    private final WatchFoldersUseCase watch;
    private final WatchFoldersPort folders;
    private final Map<WatchKey, String[]> keys = new ConcurrentHashMap<>(); // key → {folder, folder dir, watched dir}
    private WatchService service;
    private Thread thread;

    public WatchServiceEvents(WatchFoldersUseCase watch, WatchFoldersPort folders) {
        this.watch = watch;
        this.folders = folders;
    }

    @EventListener(ApplicationReadyEvent.class)
    public void start() {
        try {
            service = FileSystems.getDefault().newWatchService();
        } catch (IOException e) {
            log.error("Change notifications are not available: {}", e.toString());
            return;
        }
        registerAll();
        thread = new Thread(this::loop, "logs-watch-events");
        thread.setDaemon(true);
        thread.start();
    }

    /** The watched folders were replaced while running (native install, a LIVE setting): watch the new list. */
    @EventListener(WatchFoldersUseCase.FoldersReplaced.class)
    public synchronized void foldersReplaced() {
        if (service == null) {
            return;
        }
        keys.keySet().forEach(WatchKey::cancel);
        keys.clear();
        registerAll();
    }

    private synchronized void registerAll() {
        for (WatchFoldersPort.Folder f : folders.folders()) {
            if (!f.available()) {
                log.warn("Watched folder {} ({}) is not mounted - run restart.py after changing logs_watch_dirs", f.name(), f.hostPath());
                continue;
            }
            Path root = Path.of(folders.dir(f.name()));
            try (Stream<Path> dirs = Files.walk(root)) {
                dirs.filter(Files::isDirectory).forEach(d -> register(f.name(), root, d));
            } catch (IOException e) {
                log.warn("Watched folder {} could not be listed: {}", f.name(), e.toString());
            }
        }
    }

    private void register(String folder, Path root, Path dir) {
        try {
            WatchKey key = dir.register(service, StandardWatchEventKinds.ENTRY_CREATE, StandardWatchEventKinds.ENTRY_MODIFY,
                    StandardWatchEventKinds.ENTRY_DELETE);
            keys.put(key, new String[]{folder, root.toString(), dir.toString()});
        } catch (IOException e) {
            // ENOSPC from inotify_add_watch: the kernel's watch limit is reached.
            log.error("Cannot watch {} ({}). On Linux raise the limit: sysctl fs.inotify.max_user_watches=524288", dir, e.toString());
        }
    }

    private void loop() {
        while (!Thread.currentThread().isInterrupted()) {
            WatchKey key;
            try {
                key = service.take(); // blocks until the kernel reports a change
            } catch (InterruptedException | java.nio.file.ClosedWatchServiceException e) {
                return;
            }
            String[] at = keys.get(key);
            if (at != null) {
                for (WatchEvent<?> ev : key.pollEvents()) {
                    try {
                        handle(at, ev);
                    } catch (RuntimeException e) {
                        log.warn("Watched change in {} could not be handled: {}", at[2], e.toString());
                    }
                }
            }
            if (!key.reset()) {
                keys.remove(key); // the directory itself is gone
            }
        }
    }

    private void handle(String[] at, WatchEvent<?> ev) {
        String folder = at[0];
        if (ev.kind() == StandardWatchEventKinds.OVERFLOW) {
            watch.rescan(folder); // too many changes at once: re-check every file from its saved position
            return;
        }
        Path root = Path.of(at[1]);
        Path changed = Path.of(at[2]).resolve((Path) ev.context());
        if (ev.kind() == StandardWatchEventKinds.ENTRY_CREATE && Files.isDirectory(changed)) {
            register(folder, root, changed); // a new subfolder is watched too
            return;
        }
        watch.changed(folder, root.relativize(changed).toString().replace('\\', '/'));
    }

    @PreDestroy
    void stop() {
        if (thread != null) {
            thread.interrupt();
        }
        try {
            if (service != null) {
                service.close();
            }
        } catch (IOException ignored) {
            // shutting down
        }
    }
}
