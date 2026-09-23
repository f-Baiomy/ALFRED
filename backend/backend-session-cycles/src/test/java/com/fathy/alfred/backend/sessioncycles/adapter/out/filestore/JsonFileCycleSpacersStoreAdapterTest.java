package com.fathy.alfred.backend.sessioncycles.adapter.out.filestore;

import com.fathy.alfred.backend.sessioncycles.domain.model.CycleSpacer;
import com.fathy.alfred.backend.sessioncycles.domain.model.LegacyCycleSpacer;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.lang.reflect.Field;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

class JsonFileCycleSpacersStoreAdapterTest {

    @TempDir
    Path dir;

    private final JsonFileCycleSpacersStoreAdapter adapter = new JsonFileCycleSpacersStoreAdapter();

    @BeforeEach
    void pointAtTempDir() throws Exception {
        Field field = JsonFileCycleSpacersStoreAdapter.class.getDeclaredField("sessionCyclesDir");
        field.setAccessible(true);
        field.set(adapter, dir.toString());
    }

    @Test
    void aSpacerWrittenBeforeAfterAnchorsReadsAsLegacyUntilMoved() throws Exception {
        Files.writeString(dir.resolve("c1.spacers.json"),
                "[{\"id\":\"s1\",\"cycleId\":\"c1\",\"label\":\"Old\",\"beforeCallId\":\"call-1\",\"createdAt\":\"t\"}]");

        assertThat(adapter.findLegacyByCycle("c1")).containsExactly(new LegacyCycleSpacer("s1", "call-1", null));
        assertThat(adapter.findAllByCycle("c1")).containsExactly(new CycleSpacer("s1", "c1", "Old", null, "t", null));

        adapter.move("c1", "s1", "call-0", "t0");

        assertThat(adapter.findLegacyByCycle("c1")).isEmpty();
        assertThat(adapter.findAllByCycle("c1")).containsExactly(new CycleSpacer("s1", "c1", "Old", "call-0", "t", "t0"));
    }

    @Test
    void createRenameAndDropAnchorsRoundTripTheAfterAnchor() {
        CycleSpacer created = adapter.create("c1", "Retry", "call-1", "t1");
        adapter.rename("c1", created.id(), "Renamed");

        assertThat(adapter.findLegacyByCycle("c1")).isEmpty();
        assertThat(adapter.findAllByCycle("c1")).singleElement().satisfies(s -> {
            assertThat(s.label()).isEqualTo("Renamed");
            assertThat(s.afterCallId()).isEqualTo("call-1");
        });

        adapter.dropAnchorsTo("c1", List.of("call-1"));

        assertThat(adapter.findAllByCycle("c1")).singleElement().satisfies(s -> {
            assertThat(s.afterCallId()).isNull();
            assertThat(s.anchorTimestamp()).isEqualTo("t1");
        });
    }
}
