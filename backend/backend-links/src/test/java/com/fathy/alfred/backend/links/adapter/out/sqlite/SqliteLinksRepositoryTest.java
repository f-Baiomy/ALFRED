package com.fathy.alfred.backend.links.adapter.out.sqlite;

import com.fathy.alfred.backend.links.domain.model.EnvMark;
import com.fathy.alfred.backend.links.domain.model.Link;
import com.fathy.alfred.backend.links.domain.model.LinkRequest;
import com.fathy.alfred.backend.links.domain.model.RequestKind;
import com.fathy.alfred.backend.links.domain.model.RequestState;
import com.fathy.alfred.backend.links.domain.model.Stream;
import com.fathy.alfred.backend.links.domain.model.StreamKind;
import com.fathy.alfred.backend.links.domain.model.StreamMode;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Path;
import java.time.Instant;

import static org.assertj.core.api.Assertions.assertThat;

/** links.db: what a restart must keep, and the compare-and-swap that makes the first answer the only one (D13). */
class SqliteLinksRepositoryTest {

    @TempDir
    Path dir;

    private SqliteLinksRepository repo;
    private final Instant t0 = Instant.parse("2026-10-19T08:00:00Z");

    @BeforeEach
    void open() {
        repo = new SqliteLinksRepository(dir.resolve("links.db").toString());
        repo.init();
    }

    private SqliteLinksRepository reopen() {
        SqliteLinksRepository again = new SqliteLinksRepository(dir.resolve("links.db").toString());
        again.init();
        return again;
    }

    private Link link() {
        return new Link("L1", "stg-83", "STG 83", "peer-1", "Alfred b", "http://10.0.0.83:3000", true, "s3cret", t0, null, "1.53.0", null);
    }

    private LinkRequest request(String id) {
        return new LinkRequest(id, "S1", "L1", true, RequestKind.CALL_NOTE, "k1", "GET /x", "why 500?", "{}", "PC-1",
                RequestState.WAITING, null, null, t0, null, false);
    }

    @Test
    void linksAndStreamsSurviveARestart() {
        repo.saveLink(link());
        repo.saveStream(new Stream("S1", true, "L1", StreamKind.CYCLE, "c1", "smoke", "odeysys", StreamMode.COMMENT, false, true,
                StreamMode.VIEW, false, null, null, t0, null));
        SqliteLinksRepository again = reopen();
        assertThat(again.linkBySlug("stg-83")).get().extracting(Link::secret, Link::peerAlfredId).containsExactly("s3cret", "peer-1");
        Stream s = again.stream("S1").orElseThrow();
        assertThat(s.mode()).isEqualTo(StreamMode.COMMENT);
        assertThat(s.passOn()).isTrue();
        assertThat(s.passMode()).isEqualTo(StreamMode.VIEW);
    }

    @Test
    void onlyTheFirstAnswerIsTaken() {
        repo.saveRequest(request("R1"));
        LinkRequest accepted = request("R1").answered(RequestState.ACCEPTED, "call:n1", null, t0.plusSeconds(1), false);
        LinkRequest rejected = request("R1").answered(RequestState.REJECTED, null, "no", t0.plusSeconds(2), false);
        assertThat(repo.answerRequest(accepted, RequestState.WAITING)).isTrue();
        assertThat(repo.answerRequest(rejected, RequestState.WAITING)).isFalse();
        LinkRequest kept = repo.request("R1").orElseThrow();
        assertThat(kept.state()).isEqualTo(RequestState.ACCEPTED);
        assertThat(kept.resultRef()).isEqualTo("call:n1");
        assertThat(repo.countRequests(true, RequestState.WAITING)).isZero();
    }

    @Test
    void eventsAreDeliveredOnceInOrderAndForgottenWhenAcked() {
        long a = repo.enqueue("L1", "stream", "{\"n\":1}", t0);
        long b = repo.enqueue("L1", "stream", "{\"n\":2}", t0);
        assertThat(b).isGreaterThan(a);
        assertThat(repo.outbox("L1")).extracting(e -> e.seq()).containsExactly(a, b);
        repo.acked("L1", a);
        assertThat(repo.outbox("L1")).extracting(e -> e.seq()).containsExactly(b);
        assertThat(repo.received("L1", 7)).isTrue();
        assertThat(repo.received("L1", 7)).as("a repeated event is not applied twice").isFalse();
        assertThat(repo.lastReceived("L1")).isEqualTo(7);
        repo.clearEvents("L1");
        assertThat(repo.outbox("L1")).isEmpty();
    }

    @Test
    void anEnvironmentMarkIsOnePerItemAndCanBeTakenBack() {
        repo.saveEnvMark(new EnvMark("H1", "B1", "spec.md", "AC1", "PASS", "", "user", t0, null));
        repo.saveEnvMark(new EnvMark("H1", "B1", "spec.md", "AC1", "FAIL", "500 on save", "claude", t0.plusSeconds(5), null));
        assertThat(repo.envMarks("H1", "B1")).singleElement().extracting(EnvMark::mark, EnvMark::evidence).containsExactly("FAIL", "500 on save");
        repo.deleteEnvMark("H1", "B1", "spec.md", "AC1");
        assertThat(repo.envMarks("H1", "B1")).isEmpty();
    }

    @Test
    void theReadLogCountsPerDay() {
        repo.countRead("L1", "cycle", "c1", null, t0);
        repo.countRead("L1", "cycle", "c1", null, t0.plusSeconds(60));
        repo.countRead("L1", "call", "k1", "Alfred c", t0.plusSeconds(90));
        assertThat(repo.reads("L1", "2026-10-19")).hasSize(2);
        repo.pruneReads("2026-10-20");
        assertThat(repo.reads("L1", "2026-10-01")).isEmpty();
    }
}
