package com.fathy.alfred.backend.sessions.application.service;

import com.fathy.alfred.backend.sessions.application.port.in.ConnectUseCase;
import com.fathy.alfred.backend.sessions.application.port.out.ConnectFilesPort;
import com.fathy.alfred.backend.sessions.domain.Keys;
import org.springframework.stereotype.Service;

import java.nio.file.Path;
import java.util.Map;
import java.util.Optional;
import java.util.TreeMap;
import java.util.regex.Pattern;

/** See {@link ConnectUseCase}. */
@Service
public class ConnectService implements ConnectUseCase {

    /** A plain origin: it is written into a script, so nothing else may reach it. */
    static final Pattern ORIGIN = Pattern.compile("https?://(\\[[0-9A-Fa-f:.]+]|[A-Za-z0-9.-]+)(:\\d{1,5})?");
    static final Pattern TOKEN = Pattern.compile("[A-Za-z0-9_-]{20,100}");

    private final ConnectFilesPort files;

    public ConnectService(ConnectFilesPort files) {
        this.files = files;
    }

    @Override
    public Versions versions() {
        return new Versions(files.helperScript().map(ConnectService::hash).orElse(""),
                skills().map(Skills::version).orElse(""), files.nodeExe().isPresent());
    }

    @Override
    public Optional<String> helperScript() {
        return files.helperScript();
    }

    @Override
    public Optional<Skills> skills() {
        Map<String, String> f = new TreeMap<>(files.skillFiles());
        if (f.isEmpty()) {
            return Optional.empty();
        }
        StringBuilder all = new StringBuilder();
        f.forEach((k, v) -> all.append(k).append('\0').append(v).append('\0'));
        return Optional.of(new Skills(hash(all.toString()), f));
    }

    @Override
    public Optional<Path> nodeExe() {
        return files.nodeExe();
    }

    @Override
    public Script script(String server, String token, String os) {
        String s = server == null ? "" : server.strip().replaceAll("/+$", "");
        if (!ORIGIN.matcher(s).matches()) {
            throw new IllegalArgumentException("Alfred's address must be a plain origin like http://192.168.1.80:3000");
        }
        if (token == null || !TOKEN.matcher(token).matches()) {
            throw new IllegalArgumentException("Not a connect token");
        }
        if ("windows".equalsIgnoreCase(os)) {
            return new Script("alfred-connect.cmd", WINDOWS.replace("@@ALFRED@@", s).replace("@@TOKEN@@", token).replace("\n", "\r\n"),
                    "Double-click alfred-connect.cmd in your Downloads");
        }
        return new Script("alfred-connect.sh", UNIX.replace("@@ALFRED@@", s).replace("@@TOKEN@@", token),
                "Run: sh ~/Downloads/alfred-connect.sh");
    }

    static String hash(String text) {
        return Keys.hash(text).substring(0, 16);
    }

    // The helper and Node go to %LOCALAPPDATA%\alfred-helper\app; the helper's `connect` does the rest (docs/server.md).
    private static final String WINDOWS = """
            @echo off
            setlocal EnableExtensions
            title Connect this PC to Alfred
            set "ALFRED=@@ALFRED@@"
            set "TOKEN=@@TOKEN@@"
            set "DIR=%LOCALAPPDATA%\\alfred-helper\\app"
            if not exist "%DIR%" mkdir "%DIR%"
            echo Connecting this PC to Alfred at %ALFRED% ...
            curl.exe -fsS "%ALFRED%/board/connect/alfred-helper.mjs" -o "%DIR%\\alfred-helper.mjs" || goto failed
            set "NODE="
            where node >nul 2>nul && node -e "process.exit(+process.versions.node.split('.')[0]<18)" >nul 2>nul && set "NODE=node"
            if not defined NODE if exist "%DIR%\\node.exe" set "NODE=%DIR%\\node.exe"
            if defined NODE goto run
            echo Getting Node from Alfred (once) ...
            curl.exe -fsS "%ALFRED%/board/connect/node.exe" -o "%DIR%\\node.exe" || goto nonode
            set "NODE=%DIR%\\node.exe"
            :run
            "%NODE%" "%DIR%\\alfred-helper.mjs" connect --server "%ALFRED%" --token "%TOKEN%"
            if errorlevel 1 goto failed
            echo.
            echo Done - go back to Alfred in your browser. This window closes by itself.
            "%SystemRoot%\\System32\\timeout.exe" /t 10 >nul
            exit /b 0
            :nonode
            echo This Alfred has no Node to hand out. Install Node 18 or newer from https://nodejs.org and run this file again.
            pause
            exit /b 1
            :failed
            echo.
            echo Connecting did not finish - the lines above say why.
            pause
            exit /b 1
            """;

    private static final String UNIX = """
            #!/bin/sh
            # Connect this PC to Alfred (specs/031): the helper from Alfred, then its `connect` does the rest.
            set -e
            ALFRED='@@ALFRED@@'
            TOKEN='@@TOKEN@@'
            DIR="${XDG_CONFIG_HOME:-$HOME/.config}/alfred-helper/app"
            mkdir -p "$DIR"
            echo "Connecting this PC to Alfred at $ALFRED ..."
            curl -fsS "$ALFRED/board/connect/alfred-helper.mjs" -o "$DIR/alfred-helper.mjs"
            if ! command -v node >/dev/null 2>&1 || ! node -e "process.exit(+process.versions.node.split('.')[0]<18)"; then
              echo "Install Node 18 or newer (https://nodejs.org), then run this again."
              exit 1
            fi
            node "$DIR/alfred-helper.mjs" connect --server "$ALFRED" --token "$TOKEN"
            echo "Done - go back to Alfred in your browser."
            """;
}
