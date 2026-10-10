package com.fathy.alfred.backend.board.application.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fathy.alfred.backend.board.application.port.in.ImportBoardUseCase;
import com.fathy.alfred.backend.board.application.port.out.BoardNotificationPort;
import com.fathy.alfred.backend.board.application.port.out.BoardStorePort;
import com.fathy.alfred.backend.board.application.port.out.MentionedCallsChangedPort;
import com.fathy.alfred.backend.board.domain.MentionParser;
import com.fathy.alfred.backend.board.domain.model.ActivityEntry;
import com.fathy.alfred.backend.board.domain.model.ActivityKind;
import com.fathy.alfred.backend.board.domain.model.Actor;
import com.fathy.alfred.backend.board.domain.model.Card;
import com.fathy.alfred.backend.board.domain.model.CardKind;
import com.fathy.alfred.backend.board.domain.model.CardStatus;
import com.fathy.alfred.backend.board.domain.model.ChecklistMark;
import com.fathy.alfred.backend.board.domain.model.CycleBrief;
import com.fathy.alfred.backend.board.domain.model.Flag;
import com.fathy.alfred.backend.board.domain.model.Mark;
import com.fathy.alfred.backend.board.domain.model.MentionOwner;
import com.fathy.alfred.backend.board.domain.model.MentionRef;
import com.fathy.alfred.backend.board.domain.model.MentionType;
import com.fathy.alfred.backend.board.domain.model.Resolution;
import com.fathy.alfred.backend.board.domain.model.Scope;
import com.fathy.alfred.backend.board.domain.model.SpecFile;
import org.springframework.stereotype.Service;

import java.io.BufferedReader;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.ArrayList;
import java.util.EnumSet;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Reads an {@code alfred-board/1} export (written by the frontend's board-json.ts: a header line, every card, then
 * activity, briefs, spec files and marks, one JSON record per line) into a project. A card keeps its number when that
 * number is free in the target project and gets the next one otherwise; {@code @[card:...]} mentions of moved cards are
 * rewritten to match (spec edge case "Import of a JSON file with card numbers that already exist").
 */
@Service
public class ImportBoardService implements ImportBoardUseCase {

    public static final String FORMAT = "alfred-board/1";
    private static final Pattern CARD_MENTION = Pattern.compile("@\\[card:([^|\\]#]*)#(\\d+)\\|");

    private final BoardStorePort store;
    private final BoardNotificationPort notifications;
    private final MentionedCallsChangedPort mentionedCalls;
    private final ObjectMapper json = new ObjectMapper();

    public ImportBoardService(BoardStorePort store, BoardNotificationPort notifications, MentionedCallsChangedPort mentionedCalls,
                              BoardChangeFeed feed) {
        this.store = store;
        this.notifications = feed.feeding(notifications);
        this.mentionedCalls = mentionedCalls;
    }

    private record PendingCard(Card card, List<MentionRef> links) {
    }

    @Override
    public synchronized ImportResult importBoard(String project, BufferedReader lines) throws IOException {
        String target = project == null ? "" : project.strip();
        String header = lines.readLine();
        long bytes = header == null ? 0 : header.getBytes(StandardCharsets.UTF_8).length;
        if (header == null || !FORMAT.equals(json.readTree(header).path("format").asText())) {
            throw new IllegalArgumentException("Not an " + FORMAT + " file");
        }
        List<PendingCard> pending = new ArrayList<>();
        Map<String, Integer> numbers = new HashMap<>();
        Map<Integer, String> idByOldNumber = new HashMap<>();
        List<Renumbered> renumbered = new ArrayList<>();
        String sourceProject = null;
        boolean cardsWritten = false;
        String line;
        while ((line = lines.readLine()) != null) {
            bytes += line.getBytes(StandardCharsets.UTF_8).length + 1L;
            if (bytes > MAX_BYTES) {
                throw new IllegalArgumentException("The file is larger than " + (MAX_BYTES / (1024 * 1024)) + " MB");
            }
            if (line.isBlank()) {
                continue;
            }
            JsonNode r = json.readTree(line);
            String kind = r.path("record").asText();
            if ("card".equals(kind)) {
                JsonNode c = r.path("card");
                if (sourceProject == null) {
                    sourceProject = c.path("project").asText("");
                }
                pending.add(new PendingCard(card(c, target), links(r.path("links"))));
                continue;
            }
            if (!cardsWritten) {
                writeCards(target, sourceProject, pending, numbers, idByOldNumber, renumbered);
                cardsWritten = true;
            }
            switch (kind) {
                case "activity" -> {
                    String cardId = idByOldNumber.get(r.path("cardNumber").asInt(-1));
                    if (cardId != null) {
                        JsonNode e = r.path("entry");
                        String text = rewrite(text(e, "text"), sourceProject, target, numbers);
                        long id = store.append(new ActivityEntry(0, cardId, actor(e.path("actor").asText()),
                                ActivityKind.valueOf(e.path("kind").asText()), text, text(e, "oldValue"), text(e, "newValue"),
                                instant(e.path("at").asText())));
                        if (text != null) {
                            store.replaceMentions(MentionOwner.ACTIVITY, Long.toString(id), cardId, MentionParser.mentions(text));
                        }
                    }
                }
                case "brief" -> {
                    String text = r.path("text").asText("");
                    store.putBrief(new CycleBrief(r.path("cycleId").asText(), text, instant(r.path("updatedAt").asText())));
                    store.replaceMentions(MentionOwner.BRIEF, r.path("cycleId").asText(), null, MentionParser.mentions(text));
                }
                case "spec" -> {
                    String content = r.path("content").asText("");
                    store.putSpec(new SpecFile(r.path("cycleId").asText(), r.path("name").asText(), content,
                            content.getBytes(StandardCharsets.UTF_8).length, instant(r.path("uploadedAt").asText())));
                }
                case "mark" -> store.putMark(new ChecklistMark(r.path("cycleId").asText(), r.path("fileName").asText(),
                        r.path("itemKey").asText(), Mark.valueOf(r.path("mark").asText()), actor(r.path("actor").asText()),
                        r.path("evidence").asText(""), List.of(), instant(r.path("updatedAt").asText())));
                default -> {
                    // A newer exporter's record this reader does not know: skipped, not fatal.
                }
            }
        }
        if (!cardsWritten) {
            writeCards(target, sourceProject, pending, numbers, idByOldNumber, renumbered);
        }
        mentionedCalls.mentionedCallsChanged();
        notifications.changed(target, null, null, "card");
        return new ImportResult(pending.size(), renumbered);
    }

    private void writeCards(String target, String sourceProject, List<PendingCard> pending, Map<String, Integer> numbers,
                            Map<Integer, String> idByOldNumber, List<Renumbered> renumbered) {
        // Keep every free number first, then hand out new ones that none of the kept numbers can collide with.
        Set<Integer> kept = new java.util.HashSet<>();
        for (PendingCard p : pending) {
            int old = p.card().number();
            if (old > 0 && store.findByNumber(target, old).isEmpty() && kept.add(old)) {
                numbers.put(Integer.toString(old), old);
            }
        }
        for (PendingCard p : pending) {
            int old = p.card().number();
            if (kept.contains(old)) {
                continue; // an export holds one card per number, so a kept number is this card's
            }
            int number;
            do {
                number = store.nextNumber(target);
            } while (kept.contains(number));
            renumbered.add(new Renumbered(old, number));
            numbers.put(Integer.toString(old), number);
        }
        for (PendingCard p : pending) {
            int number = numbers.get(Integer.toString(p.card().number()));
            Card card = p.card().withNumber(number)
                    .withDescription(rewrite(p.card().description(), sourceProject, target, numbers));
            store.insert(card);
            idByOldNumber.put(p.card().number(), card.id());
            store.replaceMentions(MentionOwner.CARD, card.id(), card.id(), MentionParser.mentions(card.description()));
            for (MentionRef link : p.links()) {
                store.addDirect(card.id(), link);
            }
            store.append(new ActivityEntry(0, card.id(), Actor.USER, ActivityKind.IMPORTED, null, null, Integer.toString(number),
                    Instant.now()));
        }
    }

    /** {@code @[card:<source>#N|} becomes {@code @[card:<target>#M|} for every imported card. */
    static String rewrite(String text, String sourceProject, String target, Map<String, Integer> numbers) {
        if (text == null || !text.contains("@[card:")) {
            return text;
        }
        Matcher m = CARD_MENTION.matcher(text);
        StringBuilder out = new StringBuilder();
        while (m.find()) {
            Integer to = m.group(1).equals(sourceProject == null ? "" : sourceProject) ? numbers.get(m.group(2)) : null;
            m.appendReplacement(out, Matcher.quoteReplacement(to == null ? m.group() : "@[card:" + target + "#" + to + "|"));
        }
        m.appendTail(out);
        return out.toString();
    }

    private Card card(JsonNode c, String target) {
        EnumSet<Flag> flags = EnumSet.noneOf(Flag.class);
        c.path("flags").forEach(f -> flags.add(Flag.valueOf(f.asText())));
        String status = c.path("status").asText("INBOX");
        Instant created = instant(c.path("createdAt").asText());
        return new Card(UUID.randomUUID().toString(), target, c.path("number").asInt(0), CardKind.valueOf(c.path("kind").asText("TASK")),
                c.path("title").asText(), c.path("description").asText(""), CardStatus.valueOf(status),
                c.hasNonNull("resolution") ? Resolution.valueOf(c.get("resolution").asText()) : null, text(c, "reason"), Set.copyOf(flags),
                Scope.valueOf(c.path("scope").asText("NOT_DECIDED")), actor(c.path("author").asText()), text(c, "cycleId"),
                c.path("cycleDeleted").asBoolean(false), text(c, "signature"), created, instant(c.path("updatedAt").asText()),
                actor(c.path("updatedBy").asText()));
    }

    private static List<MentionRef> links(JsonNode links) {
        List<MentionRef> out = new ArrayList<>();
        links.forEach(l -> out.add(new MentionRef(MentionType.valueOf(l.path("type").asText().toUpperCase(Locale.ROOT)),
                l.path("ref").asText(), l.path("label").asText())));
        return out;
    }

    private static String text(JsonNode n, String field) {
        return n.hasNonNull(field) ? n.get(field).asText() : null;
    }

    private static Actor actor(String s) {
        return "CLAUDE".equals(s) ? Actor.CLAUDE : Actor.USER;
    }

    private static Instant instant(String s) {
        try {
            return s == null || s.isBlank() ? Instant.now() : Instant.parse(s);
        } catch (java.time.format.DateTimeParseException e) {
            return Instant.now();
        }
    }
}
