package com.fathy.alfred.backend.mcpbridge;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.FileTime;
import java.time.Duration;
import java.time.Instant;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

class McpExportsControllerTest {

    @TempDir
    Path exports;
    @TempDir
    Path elsewhere;

    @Test
    void oneFileByNameAsAnAttachmentAndNothingOutsideTheFolder() throws Exception {
        Files.writeString(exports.resolve("repro one.md"), "# calls");
        Files.writeString(elsewhere.resolve("secret.txt"), "no");
        MockMvc mvc = MockMvcBuilders.standaloneSetup(new McpExportsController(exports.toString())).build();

        mvc.perform(get("/mcp-exports/{name}", "repro one.md"))
                .andExpect(status().isOk())
                .andExpect(header().string("Content-Disposition", org.hamcrest.Matchers.startsWith("attachment;")))
                .andExpect(content().string("# calls"));
        mvc.perform(get("/mcp-exports/{name}", "..secret.txt")).andExpect(status().isNotFound());
        mvc.perform(get("/mcp-exports/{name}", "../" + elsewhere.getFileName() + "/secret.txt")).andExpect(status().isNotFound());
        mvc.perform(get("/mcp-exports/{name}", "missing.md")).andExpect(status().isNotFound());

        MockMvc docker = MockMvcBuilders.standaloneSetup(new McpExportsController("")).build();
        docker.perform(get("/mcp-exports/{name}", "repro one.md")).andExpect(status().isNotFound());
    }

    @Test
    void exportsOlderThanSevenDaysAreDeletedAtStart() throws Exception {
        Path old = Files.writeString(exports.resolve("old.md"), "x");
        Files.setLastModifiedTime(old, FileTime.from(Instant.now().minus(Duration.ofDays(8))));
        Path recent = Files.writeString(exports.resolve("recent.md"), "x");

        new McpExportsController(exports.toString()).deleteOldExports();
        assertThat(old).doesNotExist();
        assertThat(recent).exists();
    }
}
