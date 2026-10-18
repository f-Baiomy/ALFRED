package com.fathy.alfred.backend.sessions.application.service;

import com.fathy.alfred.backend.sessions.adapter.out.files.ConnectFilesAdapter;
import com.fathy.alfred.backend.sessions.application.port.in.ConnectUseCase;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Files;
import java.nio.file.Path;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class ConnectServiceTest {

    @TempDir
    Path dir;

    private ConnectService service() {
        return new ConnectService(new ConnectFilesAdapter(dir.resolve("helper/alfred-helper.mjs").toString(), dir.resolve("skills").toString(),
                dir.resolve("node.exe").toString()));
    }

    @Test
    void theSkillsAreHandedOutAsInstalledEachWithTheSharedRules() throws Exception {
        Files.createDirectories(dir.resolve("skills/alfred-live/sub"));
        Files.createDirectories(dir.resolve("skills/_shared"));
        Files.createDirectories(dir.resolve("skills/not-a-skill"));
        Files.writeString(dir.resolve("skills/alfred-live/SKILL.md"), "live");
        Files.writeString(dir.resolve("skills/alfred-live/sub/x.mjs"), "x");
        Files.writeString(dir.resolve("skills/alfred-live/.alfred-skill"), "source");
        Files.writeString(dir.resolve("skills/_shared/rules.md"), "rules");
        Files.writeString(dir.resolve("skills/not-a-skill/SKILL.md"), "no");

        ConnectUseCase.Skills skills = service().skills().orElseThrow();

        assertThat(skills.files()).containsOnlyKeys("alfred-live/SKILL.md", "alfred-live/sub/x.mjs", "alfred-live/rules.md");
        assertThat(skills.files().get("alfred-live/rules.md")).isEqualTo("rules");
        String before = skills.version();
        Files.writeString(dir.resolve("skills/_shared/rules.md"), "rules v2");
        assertThat(service().versions().skills()).isNotEqualTo(before).hasSize(16);
    }

    @Test
    void versionsSayWhatThisAlfredCanHandOut() throws Exception {
        assertThat(service().versions()).isEqualTo(new ConnectUseCase.Versions("", "", false));
        Files.createDirectories(dir.resolve("helper"));
        Files.writeString(dir.resolve("helper/alfred-helper.mjs"), "// helper");
        Files.write(dir.resolve("node.exe"), new byte[]{1});

        assertThat(service().versions().helper()).hasSize(16);
        assertThat(service().versions().node()).isTrue();
    }

    @Test
    void theConnectFileCarriesOnlyAPlainOriginAndTheToken() {
        String token = "abcdefghijklmnopqrstuvwxyz0123456789_-";
        ConnectUseCase.Script cmd = service().script("http://192.168.1.80:3000/", token, "windows");

        assertThat(cmd.fileName()).isEqualTo("alfred-connect.cmd");
        assertThat(cmd.text()).contains("set \"ALFRED=http://192.168.1.80:3000\"", "set \"TOKEN=" + token + "\"", "\r\n")
                .contains("alfred-helper.mjs\" connect --server");
        assertThat(service().script("https://alfred.lan", token, "mac").text()).startsWith("#!/bin/sh").contains("ALFRED='https://alfred.lan'");

        assertThatThrownBy(() -> service().script("http://x\" & calc & \"", token, "windows")).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> service().script("http://x:3000/board?a=1", token, "windows")).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> service().script("http://x:3000", "short&", "windows")).isInstanceOf(IllegalArgumentException.class);
    }
}
