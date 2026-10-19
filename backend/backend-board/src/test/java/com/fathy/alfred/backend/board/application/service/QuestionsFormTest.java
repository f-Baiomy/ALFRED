package com.fathy.alfred.backend.board.application.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.fathy.alfred.backend.board.adapter.out.sqlite.TestRepositories;
import com.fathy.alfred.backend.board.application.port.in.AnswersImportUseCase.Report;
import com.fathy.alfred.backend.board.application.port.in.AnswersImportUseCase.Verdict;
import com.fathy.alfred.backend.board.application.port.in.CommentOnCardUseCase;
import com.fathy.alfred.backend.board.application.port.in.CreateCardUseCase;
import com.fathy.alfred.backend.board.application.port.in.ManageBoardsUseCase.NewBoard;
import com.fathy.alfred.backend.board.application.port.in.QuestionsFormUseCase.Built;
import com.fathy.alfred.backend.board.application.port.in.QuestionsFormUseCase.Request;
import com.fathy.alfred.backend.board.application.port.in.SnippetsUseCase.Result;
import com.fathy.alfred.backend.board.application.port.out.BoardFileStorePort;
import com.fathy.alfred.backend.board.application.port.out.BoardImageStorePort;
import com.fathy.alfred.backend.board.application.port.out.QuestionFormStorePort;
import com.fathy.alfred.backend.board.domain.model.ActivityEntry;
import com.fathy.alfred.backend.board.domain.model.Actor;
import com.fathy.alfred.backend.board.domain.model.BoardImage;
import com.fathy.alfred.backend.board.domain.model.CardChange;
import com.fathy.alfred.backend.board.domain.model.CardKind;
import com.fathy.alfred.backend.board.domain.model.Flag;
import com.fathy.alfred.backend.board.domain.model.QuestionState;
import org.jsoup.Jsoup;
import org.jsoup.nodes.Document;
import org.jsoup.nodes.Element;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import javax.imageio.ImageIO;
import java.awt.image.BufferedImage;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * specs/037: the questions form made from a board's open questions, and the answers file applied back - ids, language and
 * direction, no network in the file, masking, details made static, the report (apply, already answered, changed,
 * unknown, later), applying as the user with the file named, and Claude applying only when the user asked.
 */
class QuestionsFormTest {

    @TempDir
    Path dir;

    private static final ObjectMapper JSON = new ObjectMapper();
    /** Set -Dalfred.fixtures=write to regenerate specs/037-questions-form/fixtures/form-*.html from this test. */
    private static final boolean WRITE_FIXTURES = "write".equals(System.getProperty("alfred.fixtures"));

    private BoardFixture f;
    private QuestionFormStorePort forms;
    private QuestionsFormService service;
    private AnswersImportService imports;
    private String boardId;
    private final List<String> secrets = new ArrayList<>(List.of("s3cr3t-value-77"));

    @BeforeEach
    void setUp() {
        f = new BoardFixture(dir);
        forms = TestRepositories.questionForms(f.store);
        service = new QuestionsFormService(f.store, f.boardModel, forms, (BoardImageStorePort) f.store, () -> List.copyOf(secrets), f.clock);
        imports = new AnswersImportService(forms, f.store, f.boardModel, (BoardFileStorePort) f.snippetStore, f.board, f.board,
                BoardFixture.provider(f.boards), f.clock);
        boardId = f.boards.create(Actor.USER, new NewBoard("odeysys", "AB#62565 Portal: Knowledge Base", List.of(), null, false, null)).board().id();
    }

    @AfterEach
    void tearDown() throws Exception {
        f.close();
    }

    private String card(String title) {
        CardChange c = f.board.create(Actor.USER, new CreateCardUseCase.NewCard("odeysys", CardKind.QUESTION, title, "", Set.of(), boardId, null, List.of()));
        assertThat(c.outcome()).as(c.message()).isEqualTo(CardChange.Outcome.OK);
        return c.card().card().id();
    }

    private long ask(String cardId, String text) {
        var out = f.board.comment(Actor.CLAUDE, cardId, new CommentOnCardUseCase.Comment(null, null, null, null, null, null, text));
        assertThat(out.outcome()).as(out.message()).isEqualTo(CardChange.Outcome.OK);
        return out.entry().id();
    }

    private int number(String cardId) {
        return f.store.find(cardId).orElseThrow().number();
    }

    private static final String VIEWED = """
            لما حد يفتح item، علامة New تختفي عند مين؟

            ```questions
            {"questions": [
              {"header": "Viewed", "question": "لما حد يفتح item، علامة New تختفي عند مين؟", "why": "البند 8 بيقول agency",
               "details": "Mona still sees **New**.\\n\\n| item | user |\\n|---|---|\\n| 412 | ahmed |\\n\\n```stats\\nUsers | 4\\nStill New | 3 | amber\\n```",
               "options": [{"label": "لكل user لوحده", "description": "كل user له حالة", "recommended": true, "then": "SECRET PLAN", "preview": "AC10 wins"},
                           {"label": "للـ agency كلها"}]}
            ]}
            ```""";

    private static final String LINK = """
            How are Google Docs links shown?

            ```questions
            {"questions": [
              {"header": "Link", "question": "How are Google Docs links shown? token s3cr3t-value-77", "options": [
                 {"label": "Portal converts", "recommended": true, "followUp": {"header": "Folder", "question": "And a Drive folder?",
                   "options": [{"label": "Message"}, {"label": "New tab", "recommended": true}]}},
                 {"label": "Admin pastes embed"}]},
              {"header": "Columns", "question": "Which columns does the Admin list show?", "multiSelect": true,
               "options": [{"label": "Label"}, {"label": "Link"}, {"label": "created at"}]}
            ]}
            ```""";

    private static final String FREE = "**Question** Who can give the Alfred token read access to AB#60766?";

    private Built build(Request r) {
        Result<Built> out = service.build(r);
        assertThat(out.isOk()).as(out.message()).isTrue();
        return out.value();
    }

    private static JsonNode formJson(String html) throws Exception {
        Element block = Jsoup.parse(html).getElementById("alfred-form");
        assertThat(block).isNotNull();
        return JSON.readTree(block.data());
    }

    private static String html(Built b) {
        return new String(b.bytes(), StandardCharsets.UTF_8);
    }

    // ------------------------------------------------------------------------------------------------------- the form

    @Test
    void theFormHoldsEveryOpenQuestionOfTheBoardWithIdsAndKeysAndNoNetwork() throws Exception {
        String a = card("New badge");
        String b = card("Google Docs viewer");
        String c = card("Parent not readable");
        long ea = ask(a, VIEWED);
        long eb = ask(b, LINK);
        ask(c, FREE);
        card("No questions here");

        Built built = build(new Request(boardId, List.of(), "auto", null, false));
        String html = html(built);
        JsonNode form = formJson(html);

        assertThat(built.questions()).isEqualTo(4);
        assertThat(built.cards()).containsExactly(number(a), number(b), number(c));
        assertThat(built.fileName()).isEqualTo("AB62565-questions-2026-10-10.html");
        assertThat(form.path("formId").asText()).matches("qf_[0-9a-f]{32}").isEqualTo(built.formId());
        assertThat(form.path("questions")).hasSize(4);
        List<String> keys = new ArrayList<>();
        form.path("questions").forEach(q -> keys.add(q.path("key").asText()));
        assertThat(keys).containsExactly(number(a) + "/" + ea + "/Viewed", number(b) + "/" + eb + "/Link", number(b) + "/" + eb + "/Columns",
                number(c) + "/" + f.board.questions(c).get(0).entryId() + "/Question");
        JsonNode viewed = form.path("questions").get(0);
        assertThat(viewed.path("id").asText()).isEqualTo("q1");
        assertThat(viewed.path("options").get(0).path("id").asText()).isEqualTo("o1");
        assertThat(viewed.path("options").get(0).path("recommended").asBoolean()).isTrue();
        assertThat(viewed.path("options").get(0).path("preview").asText()).isEqualTo("AC10 wins");
        // the follow-up rides under its option, with its own id
        JsonNode link = form.path("questions").get(1);
        assertThat(link.path("options").get(0).path("followUp").path("id").asText()).isEqualTo("f1");
        assertThat(link.path("options").get(0).path("followUp").path("options")).hasSize(2);
        assertThat(form.path("questions").get(2).path("multiSelect").asBoolean()).isTrue();
        assertThat(form.path("questions").get(3).path("options")).isEmpty();
        // "then" is Claude's own plan - never in the file
        assertThat(html).doesNotContain("SECRET PLAN");
        // the file asks nothing of the network
        Document doc = Jsoup.parse(html);
        for (Element e : doc.select("[src], [href]")) {
            assertThat(e.attr("src") + e.attr("href")).doesNotContainIgnoringCase("http");
        }
        assertThat(html).doesNotContain("<link").doesNotContainIgnoringCase("@import").doesNotContain("://cdn");
        assertThat(forms.findForm(built.formId())).isPresent();
        if (WRITE_FIXTURES) {
            Files.writeString(Path.of("../../specs/037-questions-form/fixtures/form-mixed.html"), html, StandardCharsets.UTF_8);
        }
    }

    @Test
    void anArabicFormIsRightToLeftAndAnEnglishOneLeftToRight() throws Exception {
        String a = card("Arabic");
        ask(a, VIEWED);
        String ar = html(build(new Request(boardId, List.of(), "auto", null, false)));
        assertThat(Jsoup.parse(ar).selectFirst("html").attr("dir")).isEqualTo("rtl");
        assertThat(Jsoup.parse(ar).selectFirst("html").attr("lang")).isEqualTo("ar");

        String b = card("English");
        ask(b, LINK);
        String en = html(build(new Request(boardId, List.of(number(b)), "auto", null, false)));
        assertThat(Jsoup.parse(en).selectFirst("html").attr("dir")).isEqualTo("ltr");
        // forced language wins
        String forced = html(build(new Request(boardId, List.of(number(b)), "ar", null, false)));
        assertThat(Jsoup.parse(forced).selectFirst("html").attr("dir")).isEqualTo("rtl");
        if (WRITE_FIXTURES) {
            Files.writeString(Path.of("../../specs/037-questions-form/fixtures/form-ar.html"), ar, StandardCharsets.UTF_8);
            Files.writeString(Path.of("../../specs/037-questions-form/fixtures/form-en.html"), en, StandardCharsets.UTF_8);
        }
    }

    @Test
    void chosenCardsOnlyAndCardsWithoutQuestionsAreNamedNotFailed() {
        String a = card("One");
        String b = card("Two");
        String none = card("None");
        ask(a, VIEWED);
        ask(b, LINK);

        Built built = build(new Request(boardId, List.of(number(b), number(none)), "auto", null, false));
        assertThat(built.cards()).containsExactly(number(b));
        assertThat(built.leftOut()).containsExactly("#" + number(none) + " has no open questions");

        Result<Built> nothing = service.build(new Request(boardId, List.of(number(none)), "auto", null, false));
        assertThat(nothing.isOk()).isFalse();
        assertThat(nothing.message()).isEqualTo("None of these cards has an open question");
    }

    @Test
    void answeredAndWithdrawnQuestionsAreNotInTheForm() throws Exception {
        String a = card("Answered");
        long e = ask(a, LINK);
        f.board.answer(Actor.USER, a, List.of(new com.fathy.alfred.backend.board.application.port.in.QuestionsUseCase.EntryAnswers(e,
                Map.of("Columns", new com.fathy.alfred.backend.board.application.port.in.QuestionsUseCase.AnswerIn(List.of("Label"), null, null, null)))), false);
        String b = card("Withdrawn");
        long w = ask(b, VIEWED);
        f.board.withdraw(Actor.CLAUDE, b, w, List.of(), "found it in the spec");

        // closing a card leaves its question open in the index, but nobody can answer it any more
        String c = card("Closed");
        ask(c, FREE);
        f.board.close(Actor.USER, c, com.fathy.alfred.backend.board.domain.model.Resolution.FINE, null);

        JsonNode form = formJson(html(build(new Request(boardId, List.of(), "auto", null, false))));
        assertThat(form.path("questions")).hasSize(1);
        assertThat(form.path("questions").get(0).path("header").asText()).isEqualTo("Link");
        assertThat(service.build(new Request(boardId, List.of(number(c)), "auto", null, false)).message())
                .isEqualTo("None of these cards has an open question");
    }

    @Test
    void secretsAreMaskedAndAClosingTagInATextCannotEndTheDataBlock() throws Exception {
        String a = card("Secrets");
        ask(a, LINK);
        ask(card("Tag"), "**Question** Is </script><script>alert(1)</script> shown? Authorization: Bearer abcdefghijklmnop");

        String html = html(build(new Request(boardId, List.of(), "auto", null, false)));
        assertThat(html).doesNotContain("s3cr3t-value-77").doesNotContain("abcdefghijklmnop").contains("***REDACTED***");
        Document doc = Jsoup.parse(html);
        // exactly the template's two scripts: the data block and the form's own code
        assertThat(doc.select("script")).hasSize(2);
        assertThat(formJson(html).path("questions").get(2).path("question").asText()).contains("</script><script>alert(1)</script>");
    }

    @Test
    void detailsAreStaticPicturesEmbeddedChartsDrawnLiveSnippetsNamed() throws Exception {
        BufferedImage img = new BufferedImage(2400, 1200, BufferedImage.TYPE_INT_RGB);
        ByteArrayOutputStream png = new ByteArrayOutputStream();
        ImageIO.write(img, "png", png);
        ((BoardImageStorePort) f.store).saveImage(new BoardImage("img-0001-abcdef", "image/png", png.toByteArray(), null, null, Instant.now()));
        String a = card("Details");
        ask(a, """
                Which one?

                ```questions
                {"questions": [{"header": "Pick", "question": "Which one?", "details": "![the badge](/board/images/img-0001-abcdef)\\n\\n![outside](https://evil.example/x.png)\\n\\n[a link](https://example.com/page)\\n\\n```chart\\n{\\"type\\": \\"bar\\", \\"labels\\": [\\"a\\", \\"b\\"], \\"values\\": [3, 5]}\\n```\\n\\n```html live\\n<b>x</b>\\n```\\n\\n<script>alert(1)</script> @[call:abc|GET /kb/home 200]",
                  "options": [{"label": "A"}, {"label": "B"}]}]}
                ```""");

        Built built = build(new Request(boardId, List.of(), "auto", null, false));
        String details = formJson(html(built)).path("questions").get(0).path("details").asText();
        Document d = Jsoup.parseBodyFragment(details);
        assertThat(d.select("img")).hasSize(1);
        assertThat(d.selectFirst("img").attr("src")).startsWith("data:image/jpeg;base64,");
        BufferedImage embedded = ImageIO.read(new ByteArrayInputStream(java.util.Base64.getDecoder().decode(d.selectFirst("img").attr("src").substring(23))));
        assertThat(embedded.getWidth()).isEqualTo(FormDetailsRenderer.MAX_WIDTH);
        assertThat(d.select("svg.fd-chart rect")).hasSize(2);
        assertThat(d.select("a")).isEmpty();
        assertThat(d.text()).contains("a link").contains("GET /kb/home 200").doesNotContain("@[call");
        assertThat(details).doesNotContain("evil.example").doesNotContain("<script");
        assertThat(built.leftOut()).anySatisfy(s -> assertThat(s).contains("live snippet")).anySatisfy(s -> assertThat(s).contains("outside Alfred"));
    }

    @Test
    void aZipHoldsExactlyTheHtml() throws Exception {
        ask(card("Zip"), VIEWED);
        Built zip = build(new Request(boardId, List.of(), "auto", null, true));
        assertThat(zip.fileName()).endsWith(".zip");
        assertThat(zip.contentType()).isEqualTo("application/zip");
        try (ZipInputStream z = new ZipInputStream(new ByteArrayInputStream(zip.bytes()))) {
            ZipEntry e = z.getNextEntry();
            assertThat(e.getName()).isEqualTo("AB62565-questions-2026-10-10.html");
            String inside = new String(z.readAllBytes(), StandardCharsets.UTF_8);
            assertThat(formJson(inside).path("formId").asText()).isEqualTo(zip.formId());
            assertThat(z.getNextEntry()).isNull();
        }
    }

    // ------------------------------------------------------------------------------------------------------ the import

    /** An answers file's machine block, as the form writes it. */
    private static ObjectNode answers(String formId, Object[]... rows) {
        ObjectNode a = JSON.createObjectNode();
        a.put("formId", formId);
        a.put("version", 1);
        a.put("board", "x");
        a.put("lang", "ar");
        a.put("answeredBy", "Ahmed Ghonim");
        a.put("role", "BA");
        a.put("answeredAt", "2026-10-10T08:30:00Z");
        ArrayNode list = a.putArray("answers");
        for (Object[] r : rows) {
            ObjectNode one = list.addObject();
            one.put("q", (String) r[0]);
            ArrayNode c = one.putArray("choice");
            for (String id : ((String) r[1]).isEmpty() ? new String[0] : ((String) r[1]).split(",")) {
                c.add(id);
            }
            one.put("other", (Boolean) r[2]);
            one.put("later", (Boolean) r[3]);
            one.put("note", (String) r[4]);
            if (r.length > 5 && r[5] != null) {
                one.put("sure", (String) r[5]);
            }
            if (r.length > 6 && r[6] != null) {
                String[] fo = ((String) r[6]).split(":");
                ObjectNode fj = one.putObject("follow");
                fj.put("q", fo[0]);
                fj.putArray("choice").add(fo[1]);
            }
        }
        return a;
    }

    private static String page(ObjectNode answers) {
        return "<!doctype html><html><body><h1>Answers</h1><script type=\"application/json\" id=\"alfred-answers\">"
                + answers.toString().replace("<", "\\u003c") + "</script></body></html>";
    }

    private Report run(String formId, boolean dryRun, Actor actor, String askedIn, Object[]... rows) {
        Result<Report> r = imports.fromFile(boardId, "AB62565-answers.html", page(answers(formId, rows)).getBytes(StandardCharsets.UTF_8), dryRun, actor, askedIn);
        assertThat(r.isOk()).as(r.message()).isTrue();
        return r.value();
    }

    @Test
    void aDryRunReportsEachAnswerAndWritesNothing() {
        String a = card("Viewed");
        String b = card("Docs");
        String c = card("Free");
        ask(a, VIEWED);
        ask(b, LINK);
        ask(c, FREE);
        Built built = build(new Request(boardId, List.of(), "auto", null, false));
        int before = f.store.activity(a, 0, 1000).size();

        Report r = run(built.formId(), true, Actor.USER, null,
                new Object[]{"q1", "o1", false, false, "", "sure"},
                new Object[]{"q2", "o1", false, false, "", null, "f1:o2"},
                new Object[]{"q3", "", false, true, "ask the DBA"},
                new Object[]{"q4", "", false, false, "Mona from DevOps"},
                new Object[]{"q9", "o1", false, false, ""});

        assertThat(r.rows()).extracting(x -> x.result()).containsExactly(Verdict.APPLY, Verdict.APPLY, Verdict.LATER, Verdict.APPLY, Verdict.UNKNOWN_KEY);
        assertThat(r.rows().get(0).choice()).extracting(x -> x.label()).containsExactly("لكل user لوحده");
        assertThat(r.rows().get(1).follow().choice()).extracting(x -> x.label()).containsExactly("New tab");
        assertThat(r.file().answeredBy()).isEqualTo("Ahmed Ghonim");
        assertThat(r.applied()).isZero();
        assertThat(f.store.activity(a, 0, 1000)).hasSize(before);
    }

    @Test
    void applyingRecordsTheAnswersAsTheUsersWithTheFileNamedAndASecondImportChangesNothing() {
        String a = card("Viewed");
        String b = card("Docs");
        String c = card("Free");
        ask(a, VIEWED);
        ask(b, LINK);
        ask(c, FREE);
        Built built = build(new Request(boardId, List.of(), "auto", null, false));
        Object[][] rows = {
                {"q1", "o1", false, false, "", "sure"},
                {"q2", "o1", false, false, "", "likely", "f1:o2"},
                {"q3", "o1,o3", true, false, "plus Status"},
                {"q4", "", false, false, "Mona from DevOps"}};

        Report r = run(built.formId(), false, Actor.USER, null, rows);

        assertThat(r.rows()).extracting(x -> x.result()).containsOnly(Verdict.APPLIED);
        assertThat(r.applied()).isEqualTo(4);
        assertThat(f.board.questions(a)).extracting(q -> q.state()).containsOnly(QuestionState.ANSWERED);
        assertThat(f.board.questions(b)).extracting(q -> q.header() + "=" + q.state())
                .containsExactly("Link=ANSWERED", "Columns=ANSWERED", "Folder=ANSWERED");
        assertThat(f.board.questions(c)).extracting(q -> q.state()).containsOnly(QuestionState.ANSWERED);
        ActivityEntry answer = f.store.activity(a, 0, 1000).stream().filter(e -> e.text() != null && e.text().startsWith("**Answers**")).findFirst().orElseThrow();
        assertThat(answer.actor()).isEqualTo(Actor.USER);
        assertThat(answer.text()).contains("from answers file by Ahmed Ghonim (BA), 2026-10-10 08:30 UTC").contains("[sure]");
        var parsed = QuestionBlocks.answers(answer.text()).get("Viewed");
        assertThat(parsed.via()).startsWith("answers file by Ahmed Ghonim");
        assertThat(parsed.sure()).isEqualTo("sure");
        String columns = f.store.activity(b, 0, 1000).stream().filter(e -> e.text() != null && e.text().startsWith("**Answers**")).findFirst().orElseThrow().text();
        assertThat(QuestionBlocks.answers(columns).get("Columns").chose()).containsExactly("Label", "created at");
        assertThat(QuestionBlocks.answers(columns).get("Columns").other()).isEqualTo("plus Status");
        assertThat(f.board.get(a).orElseThrow().card().flags()).doesNotContain(Flag.NEEDS_DECISION);
        assertThat(f.signals).anySatisfy(s -> assertThat(s).startsWith("activity"));

        int written = f.store.activity(a, 0, 1000).size();
        Report again = run(built.formId(), false, Actor.USER, null, rows);
        assertThat(again.rows()).extracting(x -> x.result()).containsOnly(Verdict.ALREADY_ANSWERED);
        assertThat(again.applied()).isZero();
        assertThat(f.store.activity(a, 0, 1000)).hasSize(written);
    }

    @Test
    void aWithdrawnOrRewordedQuestionIsReportedAsChanged() {
        String a = card("Withdrawn");
        long e = ask(a, VIEWED);
        String b = card("Answered on the board after the form");
        long eb = ask(b, LINK);
        Built built = build(new Request(boardId, List.of(), "auto", null, false));
        f.board.withdraw(Actor.CLAUDE, a, e, List.of(), "the spec says it");
        f.board.answer(Actor.USER, b, List.of(new com.fathy.alfred.backend.board.application.port.in.QuestionsUseCase.EntryAnswers(eb,
                Map.of("Columns", new com.fathy.alfred.backend.board.application.port.in.QuestionsUseCase.AnswerIn(List.of("Link"), null, null, null)))), false);

        Report r = run(built.formId(), false, Actor.USER, null,
                new Object[]{"q1", "o1", false, false, ""},
                new Object[]{"q3", "o1", false, false, ""});
        assertThat(r.rows()).extracting(x -> x.result()).containsExactly(Verdict.CHANGED, Verdict.ALREADY_ANSWERED);
        assertThat(r.rows().get(0).message()).isEqualTo("The question was withdrawn or changed since the form was made");
        assertThat(r.applied()).isZero();
    }

    @Test
    void laterLeavesTheQuestionOpenWithANoteOnTheCard() {
        String a = card("Later");
        ask(a, VIEWED);
        Built built = build(new Request(boardId, List.of(), "auto", null, false));

        Report r = run(built.formId(), false, Actor.USER, null, new Object[]{"q1", "", false, true, "need to ask product"});
        assertThat(r.rows().get(0).result()).isEqualTo(Verdict.LATER);
        assertThat(f.board.questions(a).get(0).state()).isEqualTo(QuestionState.OPEN);
        assertThat(f.store.activity(a, 0, 1000)).anySatisfy(e -> assertThat(e.text()).startsWith("**Later** Viewed - Ahmed Ghonim will answer later: need to ask product"));
    }

    @Test
    void refusedWhole() {
        ask(card("Q"), VIEWED);
        Built built = build(new Request(boardId, List.of(), "auto", null, false));

        assertThat(imports.fromFile(boardId, "a.html", page(answers("qf_" + "0".repeat(32), new Object[]{"q1", "o1", false, false, ""}))
                .getBytes(StandardCharsets.UTF_8), true, Actor.USER, null).message()).contains("not made by this Alfred");
        String other = f.boards.create(Actor.USER, new NewBoard("odeysys", "Another board", List.of(), null, false, null)).board().id();
        assertThat(imports.fromFile(other, "a.html", page(answers(built.formId(), new Object[]{"q1", "o1", false, false, ""}))
                .getBytes(StandardCharsets.UTF_8), true, Actor.USER, null).message()).isEqualTo("This answers file belongs to another board: AB#62565 Portal: Knowledge Base");
        ObjectNode v7 = answers(built.formId());
        v7.put("version", 7);
        assertThat(imports.fromFile(boardId, "a.html", page(v7).getBytes(StandardCharsets.UTF_8), true, Actor.USER, null).message())
                .isEqualTo("Unknown answers file version 7");
        assertThat(imports.fromFile(boardId, "a.html", "<html><body>hi</body></html>".getBytes(StandardCharsets.UTF_8), true, Actor.USER, null).message())
                .isEqualTo("Not an Alfred answers file");
        assertThat(imports.fromFile(boardId, "a.html", "<script>alert(1)</script>".getBytes(StandardCharsets.UTF_8), true, Actor.USER, null).message())
                .isEqualTo("Not an Alfred answers file");
        byte[] big = ("<html>" + "x".repeat(2 * 1024 * 1024) + "</html>").getBytes(StandardCharsets.UTF_8);
        assertThat(imports.fromFile(boardId, "a.html", big, true, Actor.USER, null).message()).isEqualTo("An answers file is at most 2 MB");
    }

    @Test
    void claudeAppliesOnlyWhenTheUserAsked() {
        String a = card("Claude");
        ask(a, VIEWED);
        Built built = build(new Request(boardId, List.of(), "auto", null, false));
        byte[] file = page(answers(built.formId(), new Object[]{"q1", "o1", false, false, ""})).getBytes(StandardCharsets.UTF_8);

        // a dry run is Claude's to make on its own
        assertThat(imports.fromFile(boardId, "a.html", file, true, Actor.CLAUDE, null).isOk()).isTrue();
        Result<Report> refused = imports.fromFile(boardId, "a.html", file, false, Actor.CLAUDE, null);
        assertThat(refused.outcome()).isEqualTo(CardChange.Outcome.REFUSED_FOR_CLAUDE);
        assertThat(f.board.questions(a).get(0).state()).isEqualTo(QuestionState.OPEN);

        Result<Report> asked = imports.fromFile(boardId, "a.html", file, false, Actor.CLAUDE, "terminal");
        assertThat(asked.isOk()).as(asked.message()).isTrue();
        assertThat(asked.value().applied()).isEqualTo(1);
        // still recorded as the user's answer
        assertThat(f.store.activity(a, 0, 1000)).anySatisfy(e -> {
            assertThat(e.text()).startsWith("**Answers**");
            assertThat(e.actor()).isEqualTo(Actor.USER);
        });
    }

    @Test
    void aStoredAnswersFileIsReadAndAnythingElseHtmlIsRefusedOnUpload() {
        String a = card("Stored");
        ask(a, VIEWED);
        Built built = build(new Request(boardId, List.of(), "auto", null, false));
        byte[] file = page(answers(built.formId(), new Object[]{"q1", "o2", false, false, ""})).getBytes(StandardCharsets.UTF_8);

        var stored = f.files.attach(Actor.USER, a, null, null, "AB62565-answers-2026-10-10.html", file);
        assertThat(stored.isOk()).as(stored.message()).isTrue();
        assertThat(stored.value().isAnswersFile()).isTrue();
        assertThat(stored.value().isText()).isFalse();
        Result<Report> read = imports.fromStoredFile(null, stored.value().id(), true, Actor.USER, null);
        assertThat(read.value().rows().get(0).choice()).extracting(x -> x.label()).containsExactly("للـ agency كلها");

        var page = f.files.attach(Actor.USER, a, null, null, "page.html", "<html><body><script>alert(1)</script></body></html>".getBytes(StandardCharsets.UTF_8));
        assertThat(page.isOk()).isFalse();
        assertThat(page.message()).isEqualTo("An HTML file is accepted only as an Alfred answers file");
        var zip = f.files.attach(Actor.USER, a, null, null, "x.zip", QuestionsFormService.zip("notes.txt", "hi".getBytes(StandardCharsets.UTF_8)));
        assertThat(zip.message()).isEqualTo("A .zip is accepted only when it holds one Alfred answers file");
        var answersZip = f.files.attach(Actor.USER, a, null, null, "AB62565-answers.zip", QuestionsFormService.zip("AB62565-answers.html", file));
        assertThat(answersZip.isOk()).as(answersZip.message()).isTrue();
        assertThat(imports.fromStoredFile(boardId, answersZip.value().id(), true, Actor.USER, null).value().rows()).hasSize(1);
    }
}
