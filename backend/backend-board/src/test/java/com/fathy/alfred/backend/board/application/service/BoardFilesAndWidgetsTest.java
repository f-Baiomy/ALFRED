package com.fathy.alfred.backend.board.application.service;

import com.fathy.alfred.backend.board.domain.model.Actor;
import com.fathy.alfred.backend.board.domain.model.BoardFile;
import com.fathy.alfred.backend.board.domain.model.CardChange.Outcome;
import com.fathy.alfred.backend.board.domain.model.CardDetail;
import com.fathy.alfred.backend.board.domain.model.CardKind;
import com.fathy.alfred.backend.board.domain.model.Widget;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.charset.StandardCharsets;
import java.nio.file.Path;

import static org.assertj.core.api.Assertions.assertThat;

/** Files attached to cards and cycles (specs/017 R36) and a project's widgets (R34). */
class BoardFilesAndWidgetsTest {

    @TempDir
    Path dir;

    private BoardFixture f;
    private CardDetail card;

    @BeforeEach
    void setUp() {
        f = new BoardFixture(dir);
        card = f.add(Actor.USER, "odeysys", CardKind.BUG, "Fare drifts", "");
    }

    @AfterEach
    void tearDown() throws Exception {
        f.close();
    }

    private static byte[] text(String s) {
        return s.getBytes(StandardCharsets.UTF_8);
    }

    @Test
    void aFileIsKeptOnItsCardTypedByItsNameAndListedWithoutItsBytes() {
        var r = f.files.attach(Actor.USER, card.card().id(), null, null, "C:\\Users\\me\\fares.csv", text("a,b\n1,2\n"));
        assertThat(r.outcome()).as(r.message()).isEqualTo(Outcome.OK);
        assertThat(r.value().name()).isEqualTo("fares.csv");
        assertThat(r.value().mime()).isEqualTo("text/csv");
        assertThat(r.value().project()).isEqualTo("odeysys");
        assertThat(r.value().data()).isNull();
        assertThat(f.signals).contains("files:odeysys:null");

        var list = f.files.files(card.card().id(), null).value();
        assertThat(list).extracting(BoardFile::name).containsExactly("fares.csv");
        assertThat(list.get(0).data()).isNull();
        assertThat(f.files.file(r.value().id()).orElseThrow().data()).isEqualTo(text("a,b\n1,2\n"));
    }

    @Test
    void theBytesMustBeWhatTheNameSays() {
        String id = card.card().id();
        assertThat(f.files.attach(Actor.USER, id, null, null, "page.html", text("<b>x</b>")).message()).isEqualTo("An HTML file is accepted only as an Alfred answers file");
        assertThat(f.files.attach(Actor.USER, id, null, null, "app.exe", new byte[] {'M', 'Z'}).outcome()).isEqualTo(Outcome.INVALID);
        assertThat(f.files.attach(Actor.USER, id, null, null, "shot.png", text("not a png")).message()).contains("not a PNG");
        assertThat(f.files.attach(Actor.USER, id, null, null, "doc.pdf", text("hello")).message()).contains("not a PDF");
        assertThat(f.files.attach(Actor.USER, id, null, null, "x.log", new byte[] {'a', 0, 'b'}).message()).contains("not text");
        assertThat(f.files.attach(Actor.USER, id, null, null, "x.txt", new byte[] {(byte) 0xC3, (byte) 0x28}).message()).contains("not text");
        assertThat(f.files.attach(Actor.USER, id, null, null, "empty.txt", new byte[0]).message()).contains("empty");
        assertThat(f.files.attach(Actor.USER, id, null, null, "big.txt", new byte[BoardFile.MAX_BYTES + 1]).message()).contains("10 MB");
        assertThat(f.files.attach(Actor.USER, id, null, null, "a\"b.txt", text("x")).message()).contains("name");
        assertThat(f.files.attach(Actor.USER, id, null, null, "doc.pdf", text("%PDF-1.4 ...")).outcome()).isEqualTo(Outcome.OK);
        assertThat(f.files.attach(Actor.USER, null, null, null, "x.txt", text("x")).outcome()).isEqualTo(Outcome.INVALID);
        assertThat(f.files.attach(Actor.USER, "no-such-card", null, null, "x.txt", text("x")).outcome()).isEqualTo(Outcome.NOT_FOUND);
    }

    @Test
    void claudeRemovesOnlyWhatItAttached() {
        String id = card.card().id();
        BoardFile users = f.files.attach(Actor.USER, id, null, null, "a.txt", text("a")).value();
        BoardFile its = f.files.attach(Actor.CLAUDE, id, null, null, "b.txt", text("b")).value();
        assertThat(f.files.remove(Actor.CLAUDE, users.id()).outcome()).isEqualTo(Outcome.REFUSED_FOR_CLAUDE);
        assertThat(f.files.remove(Actor.CLAUDE, its.id()).outcome()).isEqualTo(Outcome.OK);
        assertThat(f.files.remove(Actor.USER, users.id()).outcome()).isEqualTo(Outcome.OK);
        assertThat(f.files.files(id, null).value()).isEmpty();
    }

    @Test
    void aCardsFilesGoWithTheCardAndACyclesWithTheCycle() {
        BoardFile onCard = f.files.attach(Actor.USER, card.card().id(), null, null, "a.txt", text("a")).value();
        BoardFile onCycle = f.files.attach(Actor.USER, null, "c-9aaaaaaa", "odeysys", "b.txt", text("b")).value();
        assertThat(f.files.files(null, "c-9aaaaaaa").value()).extracting(BoardFile::id).containsExactly(onCycle.id());

        f.board.delete(Actor.USER, card.card().id());
        assertThat(f.files.file(onCard.id())).isEmpty();
        f.briefs.cycleRemoved("c-9aaaaaaa");
        assertThat(f.files.file(onCycle.id())).isEmpty();
    }

    @Test
    void aWidgetIsReplacedByNameAndClaudeKeepsOffTheUsers() {
        var w = f.widgets.put(Actor.USER, "odeysys", "fare-chart", "block", "", "```chart\ntype: bar\n{{a}}: 1\n```");
        assertThat(w.outcome()).as(w.message()).isEqualTo(Outcome.OK);
        assertThat(w.value().kind()).isEqualTo(Widget.Kind.BLOCK);
        assertThat(f.signals).contains("widgets:odeysys:null");

        assertThat(f.widgets.put(Actor.CLAUDE, "odeysys", "fare-chart", "html", "", "<b>x</b>").outcome()).isEqualTo(Outcome.REFUSED_FOR_CLAUDE);
        assertThat(f.widgets.delete(Actor.CLAUDE, "odeysys", "fare-chart").outcome()).isEqualTo(Outcome.REFUSED_FOR_CLAUDE);
        assertThat(f.widgets.put(Actor.CLAUDE, "odeysys", "sql-heat", "html", "live", "<b>x</b>").outcome()).isEqualTo(Outcome.OK);
        assertThat(f.widgets.put(Actor.CLAUDE, "odeysys", "sql-heat", "html", "live", "<b>y</b>").outcome()).isEqualTo(Outcome.OK);
        assertThat(f.widgets.put(Actor.USER, "odeysys", "sql-heat", "html", "live", "<b>z</b>").value().author()).isEqualTo(Actor.CLAUDE);

        var list = f.widgets.widgets("odeysys").value();
        assertThat(list).extracting(Widget::name).containsExactly("fare-chart", "sql-heat");
        assertThat(list).allMatch(x -> x.source() == null);
        assertThat(f.widgets.widget("odeysys", "sql-heat").orElseThrow().source()).isEqualTo("<b>z</b>");
        assertThat(f.widgets.widgets("other").value()).isEmpty();

        assertThat(f.widgets.put(Actor.USER, "odeysys", "bad name", "html", "", "x").outcome()).isEqualTo(Outcome.INVALID);
        assertThat(f.widgets.put(Actor.USER, "odeysys", "ok", "svg", "", "x").outcome()).isEqualTo(Outcome.INVALID);
        assertThat(f.widgets.put(Actor.USER, "odeysys", "ok", "html", "", " ").outcome()).isEqualTo(Outcome.INVALID);
        assertThat(f.widgets.delete(Actor.USER, "odeysys", "fare-chart").outcome()).isEqualTo(Outcome.OK);
        assertThat(f.widgets.widget("odeysys", "fare-chart")).isEmpty();
    }
}
