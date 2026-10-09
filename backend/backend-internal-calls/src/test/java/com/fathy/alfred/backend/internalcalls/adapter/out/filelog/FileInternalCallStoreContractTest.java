package com.fathy.alfred.backend.internalcalls.adapter.out.filelog;

import com.fathy.alfred.backend.internalcalls.adapter.out.InternalCallStoreContractTest;
import com.fathy.alfred.backend.internalcalls.application.port.out.CallLogPort;

import java.lang.reflect.Field;
import java.nio.file.Path;

/** The store contract against the file store ({@code alfred.storage.internal-calls.type=file}). */
class FileInternalCallStoreContractTest extends InternalCallStoreContractTest {

    @Override
    protected CallLogPort openStore(Path dir, int retentionRows, int wsMaxMessages) throws Exception {
        InternalCallsFileLogAdapter adapter = new InternalCallsFileLogAdapter();
        set(adapter, "internalCallsFile", dir.resolve("internal-calls.log").toString());
        set(adapter, "retentionRows", retentionRows);
        set(adapter, "wsMaxMessages", wsMaxMessages);
        return adapter;
    }

    private static void set(InternalCallsFileLogAdapter adapter, String name, Object value) throws Exception {
        Field field = InternalCallsFileLogAdapter.class.getDeclaredField(name);
        field.setAccessible(true);
        field.set(adapter, value);
    }
}
