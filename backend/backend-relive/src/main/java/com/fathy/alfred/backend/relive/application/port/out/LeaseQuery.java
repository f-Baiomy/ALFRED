package com.fathy.alfred.backend.relive.application.port.out;

/** Outbound port: whether a WebSocket tab currently holds a run's lease (research D1). Its own
 *  interface, implemented by {@code RunLeaseRegistry} (T047), so ReliveRunsService can depend on
 *  it by DI without a circular dependency back onto RunLeaseRegistry (which depends on
 *  ReliveRunsService for {@code interrupt()}). */
public interface LeaseQuery {

    boolean hasActiveLease(String runId);
}
