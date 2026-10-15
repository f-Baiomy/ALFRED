package com.fathy.alfred.backend.board.application.service;

import com.fathy.alfred.backend.board.application.port.out.BoardNotificationPort;
import com.fathy.alfred.backend.board.domain.model.AgentStatus;
import com.fathy.alfred.backend.board.domain.model.LiveWork;
import com.fathy.alfred.backend.board.domain.model.SkillRun;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import java.util.concurrent.CopyOnWriteArrayList;

/**
 * Tells waiters (Claude's board_wait) that the board changed - the same moment /ws/board is signalled, never a timer.
 * Each listener is called once, on the next change, and is then gone; a waiter that still has nothing to report
 * subscribes again.
 */
@Component
public class BoardChangeFeed {

    private static final Logger log = LoggerFactory.getLogger(BoardChangeFeed.class);

    private final CopyOnWriteArrayList<Runnable> listeners = new CopyOnWriteArrayList<>();

    /** Told of every "board changed" signal, for as long as the application runs (the chat's watches, specs/022). */
    public interface ChangeObserver {
        void changed(String project, String cycleId, String cardId, String what);
    }

    private final CopyOnWriteArrayList<ChangeObserver> observers = new CopyOnWriteArrayList<>();

    public void observe(ChangeObserver observer) {
        observers.add(observer);
    }

    void observed(String project, String cycleId, String cardId, String what) {
        for (ChangeObserver o : observers) {
            try {
                o.changed(project, cycleId, cardId, what);
            } catch (RuntimeException e) {
                log.warn("A board change observer failed: {}", e.toString());
            }
        }
    }

    public AutoCloseable once(Runnable listener) {
        listeners.add(listener);
        return () -> listeners.remove(listener);
    }

    public void fire() {
        for (Runnable listener : listeners) {
            if (listeners.remove(listener)) {
                try {
                    listener.run();
                } catch (RuntimeException e) {
                    log.warn("A board change listener failed: {}", e.toString());
                }
            }
        }
    }

    int waiting() {
        return listeners.size();
    }

    /** The services' notification port, also firing this feed after every "board changed" signal. */
    BoardNotificationPort feeding(BoardNotificationPort notifications) {
        return new BoardNotificationPort() {
            @Override
            public void changed(String project, String cycleId, String cardId, String what) {
                notifications.changed(project, cycleId, cardId, what);
                observed(project, cycleId, cardId, what);
                fire();
            }

            @Override
            public void agentStatus(AgentStatus status) {
                notifications.agentStatus(status);
            }

            @Override
            public void liveWork(LiveWork work) {
                notifications.liveWork(work);
            }

            @Override
            public void liveRunner(String project, String host, String kind) {
                notifications.liveRunner(project, host, kind);
            }

            @Override
            public void cycleChat(String project, String cycleId) {
                notifications.cycleChat(project, cycleId);
            }

            /** A chat message waiting for Claude wakes board_wait like a card comment does (specs/022 R2). */
            @Override
            public void chatChanged(String project, String scope, Long id) {
                notifications.chatChanged(project, scope, id);
                fire();
            }

            @Override
            public void skillRun(SkillRun run) {
                notifications.skillRun(run);
            }
        };
    }
}
