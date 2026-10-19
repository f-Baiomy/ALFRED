package com.fathy.alfred.backend.board.application.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.fathy.alfred.backend.board.application.port.in.QuestionsFormUseCase;
import com.fathy.alfred.backend.board.application.port.in.SnippetsUseCase.Result;
import com.fathy.alfred.backend.board.application.port.out.BoardImageStorePort;
import com.fathy.alfred.backend.board.application.port.out.BoardModelStorePort;
import com.fathy.alfred.backend.board.application.port.out.BoardStorePort;
import com.fathy.alfred.backend.board.application.port.out.QuestionFormStorePort;
import com.fathy.alfred.backend.board.application.port.out.SecretValuesPort;
import com.fathy.alfred.backend.board.domain.model.ActivityEntry;
import com.fathy.alfred.backend.board.domain.model.Board;
import com.fathy.alfred.backend.board.domain.model.Card;
import com.fathy.alfred.backend.board.domain.model.CardStatus;
import com.fathy.alfred.backend.board.domain.model.CardChange.Outcome;
import com.fathy.alfred.backend.board.domain.model.Question;
import com.fathy.alfred.backend.board.domain.model.QuestionForm;
import com.fathy.alfred.backend.board.domain.model.QuestionState;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import java.util.function.Supplier;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

/**
 * Builds the questions form (specs/037 D1-D13): the board's open questions - all, or those of the cards asked for - in
 * the form template ({@code board/questions-form.html}), every text masked, every question and option given an id, the
 * details made static, and the whole stored under the form's id so the answers file that comes back can be checked.
 * A question is open as the board counts it (OPEN, or LATER whose time came); a follow-up rides under its option.
 */
@Service
public class QuestionsFormService implements QuestionsFormUseCase {

    static final String TEMPLATE = "/board/questions-form.html";
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final Pattern AB = Pattern.compile("^\\s*AB#(\\d+)");

    private final BoardStorePort store;
    private final BoardModelStorePort boards;
    private final QuestionFormStorePort forms;
    private final BoardImageStorePort images;
    private final Supplier<List<String>> secrets;
    private final Clock clock;

    @Autowired
    public QuestionsFormService(BoardStorePort store, BoardModelStorePort boards, QuestionFormStorePort forms, BoardImageStorePort images,
                                ObjectProvider<SecretValuesPort> secrets) {
        this(store, boards, forms, images, () -> {
            SecretValuesPort port = secrets.getIfAvailable();
            return port == null ? List.of() : port.secretValues();
        }, Clock.systemUTC());
    }

    QuestionsFormService(BoardStorePort store, BoardModelStorePort boards, QuestionFormStorePort forms, BoardImageStorePort images,
                         Supplier<List<String>> secrets, Clock clock) {
        this.store = store;
        this.boards = boards;
        this.forms = forms;
        this.images = images;
        this.secrets = secrets;
        this.clock = clock;
    }

    /** One card's open questions with what the form shows of them. */
    private record CardQuestions(Card card, List<Question> open) {
    }

    @Override
    public Result<Built> build(Request request) {
        Optional<Board> found = request.boardId() == null ? Optional.empty() : boards.board(request.boardId().strip());
        if (found.isEmpty()) {
            return Result.refused(Outcome.NOT_FOUND, "No such board");
        }
        Board board = found.get();
        String lang = request.lang() == null ? "auto" : request.lang().strip().toLowerCase(Locale.ROOT);
        if (!List.of("auto", "ar", "en", "").contains(lang)) {
            return Result.refused(Outcome.INVALID, "lang is ar, en or auto");
        }
        String title = request.title() == null || request.title().isBlank() ? null : request.title().strip();
        if (title != null && title.length() > 200) {
            return Result.refused(Outcome.INVALID, "A title is at most 200 characters");
        }
        Instant now = clock.instant();
        Set<Integer> wanted = new LinkedHashSet<>(request.cards());
        List<String> leftOut = new ArrayList<>();
        List<CardQuestions> picked = new ArrayList<>();
        Set<Integer> seen = new LinkedHashSet<>();
        for (String cardId : store.openQuestionCards(board.project(), null, now).keySet()) {
            Optional<Card> c = store.find(cardId);
            // a closed card's question can no longer be answered (the import reports it as changed), so it is not asked
            if (c.isEmpty() || c.get().status() == CardStatus.CLOSED || !board.id().equals(c.get().boardId())
                    || (!wanted.isEmpty() && !wanted.contains(c.get().number()))) {
                continue;
            }
            List<Question> open = store.questionsOf(cardId).stream().filter(q -> q.parentIdx() == null && q.open(now)).toList();
            if (!open.isEmpty()) {
                picked.add(new CardQuestions(c.get(), open));
                seen.add(c.get().number());
            }
        }
        for (Integer n : wanted) {
            if (!seen.contains(n)) {
                leftOut.add("#" + n + " has no open questions");
            }
        }
        if (picked.isEmpty()) {
            return Result.refused(Outcome.INVALID, wanted.isEmpty() ? "This board has no open questions" : "None of these cards has an open question");
        }
        picked.sort(Comparator.comparingInt(cq -> cq.card().number()));

        ProseMask mask = new ProseMask(secrets.get());
        FormDetailsRenderer renderer = new FormDetailsRenderer(images::findImage, mask::mask);
        Map<String, String> shortNames = store.shortNames("card", picked.stream().map(cq -> cq.card().id()).toList());
        String formId = "qf_" + UUID.randomUUID().toString().replace("-", "");

        ArrayNode cardsJson = JSON.createArrayNode();
        ArrayNode questionsJson = JSON.createArrayNode();
        List<QuestionForm.Item> items = new ArrayList<>();
        int qn = 0;
        int fn = 0;
        List<String> questionTexts = new ArrayList<>();
        for (CardQuestions cq : picked) {
            Card card = cq.card();
            String name = shortNames.getOrDefault(card.id(), null);
            ObjectNode cj = cardsJson.addObject();
            cj.put("card", card.number());
            cj.put("name", mask.mask(name == null || name.isBlank() ? oneLine(card.title(), 80) : name));
            cj.put("type", kind(card));
            Map<Long, Optional<ActivityEntry>> entries = new LinkedHashMap<>();
            List<Question> all = store.questionsOf(card.id());
            for (Question q : cq.open()) {
                Optional<ActivityEntry> entry = entries.computeIfAbsent(q.entryId(), store::activityEntry);
                if (entry.isEmpty()) {
                    continue;
                }
                JsonNode node = QuestionBlocks.questionsBlock(entry.get().text()).map(b -> b.path("questions").path(q.idx())).orElse(null);
                String questionText = node != null && node.isObject() ? node.path("question").asText(q.text()) : q.text();
                String qid = "q" + (++qn);
                ObjectNode qj = questionsJson.addObject();
                qj.put("id", qid);
                qj.put("key", card.number() + "/" + q.entryId() + "/" + q.header());
                qj.put("card", card.number());
                qj.put("entry", q.entryId());
                qj.put("header", mask.mask(q.header()));
                qj.put("question", mask.mask(questionText));
                questionTexts.add(questionText);
                boolean multi = node != null && node.path("multiSelect").asBoolean(false);
                qj.put("multiSelect", multi);
                putText(qj, "why", node == null ? null : text(node, "why"), mask);
                String details = node == null ? null : text(node, "details");
                if (details != null) {
                    FormDetailsRenderer.Rendered r = renderer.render(details);
                    qj.put("details", r.html());
                    r.leftOut().forEach(what -> leftOut.add("#" + card.number() + " " + q.header() + ": " + what));
                }
                ArrayNode oj = qj.putArray("options");
                List<QuestionForm.Option> options = new ArrayList<>();
                List<QuestionForm.FollowUp> follows = new ArrayList<>();
                List<String> labels = new ArrayList<>();
                int on = 0;
                if (node != null) {
                    for (JsonNode o : node.path("options")) {
                        String label = o.path("label").asText("");
                        String oid = "o" + (++on);
                        labels.add(label);
                        options.add(new QuestionForm.Option(oid, label));
                        ObjectNode one = option(oj.addObject(), oid, o, mask);
                        JsonNode f = o.path("followUp");
                        if (f.isObject()) {
                            Optional<Question> fq = all.stream().filter(x -> x.entryId() == q.entryId() && x.parentIdx() != null && x.parentIdx() == q.idx()
                                    && label.equals(x.parentOption())).findFirst();
                            if (fq.isEmpty() || fq.get().state() != QuestionState.PENDING) {
                                continue;
                            }
                            String fid = "f" + (++fn);
                            ObjectNode fj = one.putObject("followUp");
                            fj.put("id", fid);
                            fj.put("header", mask.mask(fq.get().header()));
                            fj.put("question", mask.mask(f.path("question").asText(fq.get().text())));
                            putText(fj, "why", text(f, "why"), mask);
                            ArrayNode fo = fj.putArray("options");
                            List<QuestionForm.Option> fopts = new ArrayList<>();
                            List<String> flabels = new ArrayList<>();
                            int k = 0;
                            for (JsonNode x : f.path("options")) {
                                String fl = x.path("label").asText("");
                                String xid = "o" + (++k);
                                fopts.add(new QuestionForm.Option(xid, fl));
                                flabels.add(fl);
                                option(fo.addObject(), xid, x, mask);
                            }
                            follows.add(new QuestionForm.FollowUp(fid, fq.get().header(), oid,
                                    hash(f.path("question").asText(fq.get().text()), flabels), fopts));
                        }
                    }
                }
                items.add(new QuestionForm.Item(qid, card.id(), card.number(), q.entryId(), q.header(), hash(questionText, labels), multi, options, follows));
            }
        }
        String resolved = lang.equals("ar") || lang.equals("en") ? lang : detect(questionTexts);
        String fileBase = fileBase(board.name());
        ObjectNode form = JSON.createObjectNode();
        form.put("formId", formId);
        form.put("version", 1);
        form.put("board", board.id());
        form.put("boardName", mask.mask(shortBoardName(board.name())));
        form.put("boardLabel", mask.mask(oneLine(board.name(), 160)));
        form.put("project", board.project());
        form.put("createdAt", now.toString());
        form.put("lang", lang.isEmpty() ? "auto" : lang);
        if (title != null) {
            form.put("title", mask.mask(title));
        }
        form.put("fileBase", fileBase);
        form.set("cards", cardsJson);
        form.set("questions", questionsJson);

        forms.saveForm(new QuestionForm(formId, board.id(), board.project(), now, resolved, items));

        String shownTitle = title != null ? mask.mask(title) : (resolved.equals("ar") ? "أسئلة " : "Questions: ") + mask.mask(shortBoardName(board.name()));
        String html = template()
                .replace("{{LANG}}", resolved)
                .replace("{{DIR}}", resolved.equals("ar") ? "rtl" : "ltr")
                .replace("{{TITLE}}", FormDetailsRenderer.esc(shownTitle))
                .replace("{{FORM_JSON}}", scriptJson(form));
        byte[] htmlBytes = html.getBytes(StandardCharsets.UTF_8);
        String date = now.atOffset(ZoneOffset.UTC).toLocalDate().toString();
        String name = fileBase + "-questions-" + date;
        byte[] bytes = request.zip() ? zip(name + ".html", htmlBytes) : htmlBytes;
        String warning = htmlBytes.length > WARN_BYTES
                ? "The form is " + (htmlBytes.length / (1024 * 1024)) + " MB - large for mail; send it through Teams or SharePoint" : null;
        return Result.ok(new Built(formId, name + (request.zip() ? ".zip" : ".html"), request.zip() ? "application/zip" : "text/html; charset=utf-8",
                bytes, htmlBytes.length, qn, picked.stream().map(cq -> cq.card().number()).toList(), leftOut, warning));
    }

    private static ObjectNode option(ObjectNode out, String id, JsonNode o, ProseMask mask) {
        out.put("id", id);
        out.put("label", mask.mask(o.path("label").asText("")));
        putText(out, "description", text(o, "description"), mask);
        if (o.path("recommended").asBoolean(false)) {
            out.put("recommended", true);
        }
        // the hover text says why; "then" is what Claude will do - for the board only, never shipped
        putText(out, "preview", text(o, "preview"), mask);
        return out;
    }

    private static void putText(ObjectNode node, String field, String value, ProseMask mask) {
        if (value != null) {
            node.put(field, mask.mask(value));
        }
    }

    private static String text(JsonNode v, String field) {
        String s = v.hasNonNull(field) ? v.get(field).asText().strip() : "";
        return s.isEmpty() ? null : s;
    }

    /** The language most questions are written in: per question, Arabic letters against Latin letters (a tie is Arabic). */
    static String detect(List<String> questions) {
        if (questions.isEmpty()) {
            return "ar";
        }
        int ar = 0;
        for (String q : questions) {
            long arabic = q.codePoints().filter(c -> c >= 0x0600 && c <= 0x06FF).count();
            long latin = q.codePoints().filter(c -> (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z')).count();
            if (arabic >= latin) {
                ar++;
            }
        }
        return ar * 2 >= questions.size() ? "ar" : "en";
    }

    /** The file names' start: {@code AB62565} for an Azure board, else the board name made safe. */
    static String fileBase(String boardName) {
        Matcher m = AB.matcher(boardName == null ? "" : boardName);
        if (m.find()) {
            return "AB" + m.group(1);
        }
        String slug = (boardName == null ? "" : boardName).toLowerCase(Locale.ROOT).replaceAll("[^a-z0-9]+", "-").replaceAll("^-+|-+$", "");
        slug = slug.length() > 40 ? slug.substring(0, 40).replaceAll("-+$", "") : slug;
        return slug.isEmpty() ? "board" : slug;
    }

    /** The board's name without its leading AB#id - the id is in the file name and the meta line. */
    static String shortBoardName(String name) {
        String n = name == null ? "" : name.replaceFirst("^\\s*AB#\\d+\\s*", "").strip();
        return oneLine(n.isEmpty() ? (name == null ? "" : name) : n, 80);
    }

    private static String kind(Card card) {
        String k = card.kind() == null ? "" : card.kind().name().toLowerCase(Locale.ROOT);
        return k.isEmpty() ? "" : Character.toUpperCase(k.charAt(0)) + k.substring(1);
    }

    /** What makes a question the same one: its words and its option labels. A changed one is not answered from an old file. */
    static String hash(String question, List<String> labels) {
        try {
            MessageDigest d = MessageDigest.getInstance("SHA-256");
            d.update(QuestionBlocks.sameness(question).getBytes(StandardCharsets.UTF_8));
            for (String l : labels) {
                d.update((byte) 0x1f);
                d.update((l == null ? "" : l.strip()).getBytes(StandardCharsets.UTF_8));
            }
            return HexFormat.of().formatHex(d.digest()).substring(0, 32);
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    /** JSON safe inside a script element: no text can close it ({@code <} as {@code \u003c}), and no line separator breaks it. */
    static String scriptJson(JsonNode node) {
        return node.toString().replace("<", "\\u003c").replace(">", "\\u003e").replace("&", "\\u0026")
                .replace("\u2028", "\\u2028").replace("\u2029", "\\u2029");
    }

    private static String oneLine(String s, int max) {
        String flat = s == null ? "" : s.replaceAll("\\s+", " ").strip();
        return flat.length() > max ? flat.substring(0, max - 1) + "…" : flat;
    }

    private static volatile String template;

    static String template() {
        if (template == null) {
            try (InputStream in = QuestionsFormService.class.getResourceAsStream(TEMPLATE)) {
                if (in == null) {
                    throw new IllegalStateException("The questions form template is missing: " + TEMPLATE);
                }
                template = new String(in.readAllBytes(), StandardCharsets.UTF_8);
            } catch (IOException e) {
                throw new UncheckedIOException(e);
            }
        }
        return template;
    }

    static byte[] zip(String entryName, byte[] data) {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        try (ZipOutputStream z = new ZipOutputStream(out, StandardCharsets.UTF_8)) {
            ZipEntry e = new ZipEntry(entryName);
            z.putNextEntry(e);
            z.write(data);
            z.closeEntry();
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
        return out.toByteArray();
    }
}
