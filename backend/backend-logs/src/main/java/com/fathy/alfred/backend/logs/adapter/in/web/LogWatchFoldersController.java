package com.fathy.alfred.backend.logs.adapter.in.web;

import com.fathy.alfred.backend.logs.application.port.in.WatchFoldersUseCase;
import com.fathy.alfred.backend.logs.application.port.out.WatchFoldersPort;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;

/** The folders Alfred listens on live (settings.properties {@code logs_watch_dirs}) and their matching files. */
@RestController
@RequestMapping("/logs/watch-folders")
public class LogWatchFoldersController {

    private final WatchFoldersUseCase watch;

    public LogWatchFoldersController(WatchFoldersUseCase watch) {
        this.watch = watch;
    }

    @GetMapping
    public WatchFoldersUseCase.Folders folders() {
        return watch.folders();
    }

    /** Files of one folder matching a pattern - the wizard's preview before a folder is watched. */
    @GetMapping("/{name}/files")
    public List<WatchFoldersPort.WatchedFile> files(@PathVariable String name, @RequestParam(defaultValue = "*") String pattern,
                                                    @RequestParam(defaultValue = "false") boolean subfolders) {
        return watch.files(name, pattern, subfolders);
    }
}
