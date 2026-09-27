package com.fathy.alfred.backend.settings.application.port.out;

import java.util.Map;
import java.util.function.UnaryOperator;

public interface GlobalVariablesStorePort {
    Map<String, Object> load();
    Map<String, Object> save(Map<String, Object> state);

    /**
     * Runs load, {@code change}, and (if anything changed) save as one atomic operation under the
     * adapter's own lock - the scope a promote-vs-save race needs, since {@code promote}/{@code save}
     * previously did their own unsynchronized load-then-save and could lose one side's write to the
     * other. {@code change} receives the freshest loaded state (including anything absorbed from a
     * proxy-written file) and returns the next state; if it returns a state {@link Map#equals equal}
     * to what it was given, the write/publish is skipped entirely and {@link Update#changed()} is
     * {@code false} so the caller knows not to broadcast a change that didn't happen.
     */
    Update update(UnaryOperator<Map<String, Object>> change);

    record Update(Map<String, Object> state, boolean changed) {}
}
