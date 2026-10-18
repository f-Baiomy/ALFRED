package com.fathy.alfred.backend.sessions.application.service;

import com.fathy.alfred.backend.sessions.adapter.out.sqlite.SqliteSessionsRepositoryAccess;
import com.fathy.alfred.backend.sessions.application.port.in.HoldersUseCase;
import com.fathy.alfred.backend.sessions.application.port.out.SessionsStorePort;
import com.fathy.alfred.backend.sessions.domain.model.Caller;
import com.fathy.alfred.backend.sessions.domain.model.Issued;

import java.nio.file.Path;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.List;

/** The sessions services over a real sessions.db, with a clock the test moves. */
final class SessionsFixture {

    final SessionsStorePort store;
    final List<String> events = new ArrayList<>();
    /** Each paired browser's raw key, by key id. */
    final java.util.Map<String, String> browserKeys = new java.util.HashMap<>();
    final MutableClock clock = new MutableClock(Instant.parse("2026-10-18T10:00:00Z"));
    final HoldersService holders;
    final KeysService keys;
    final SessionsService sessions;
    final UserSettingsService settings;

    SessionsFixture(Path dir) {
        store = SqliteSessionsRepositoryAccess.open(dir.resolve("sessions.db").toString());
        holders = new HoldersService(store, (what, board) -> events.add(what + ":" + board), clock);
        keys = new KeysService(store, (what, board) -> events.add(what + ":" + board), new org.springframework.beans.factory.ObjectProvider<>() {
            @Override
            public HoldersUseCase getObject(Object... args) {
                return holders;
            }

            @Override
            public HoldersUseCase getIfAvailable() {
                return holders;
            }

            @Override
            public HoldersUseCase getIfUnique() {
                return holders;
            }

            @Override
            public HoldersUseCase getObject() {
                return holders;
            }
        }, clock);
        sessions = new SessionsService(store, (what, board) -> events.add(what + ":" + board), clock);
        settings = new UserSettingsService(store, (what, board) -> events.add(what + ":" + board));
    }

    /** A registered helper and the caller it authenticates as. */
    Caller helper(String user, String machine) {
        Issued i = keys.registerHelper(user, machine, user, "10.0.0.1");
        return keys.authenticate(i.key()).orElseThrow();
    }

    /** A browser paired with {@code helper}. */
    Caller browser(Caller helper) {
        String code = keys.pairCode(helper).code();
        Issued i = keys.pairBrowser(code, "Chrome").orElseThrow();
        browserKeys.put(i.keyId(), i.key());
        return keys.authenticate(i.key()).orElseThrow();
    }

    static final class MutableClock extends Clock {

        Instant now;

        MutableClock(Instant now) {
            this.now = now;
        }

        void plusMinutes(long m) {
            now = now.plusSeconds(m * 60);
        }

        @Override
        public java.time.ZoneId getZone() {
            return ZoneOffset.UTC;
        }

        @Override
        public Clock withZone(java.time.ZoneId zone) {
            return this;
        }

        @Override
        public Instant instant() {
            return now;
        }
    }
}
