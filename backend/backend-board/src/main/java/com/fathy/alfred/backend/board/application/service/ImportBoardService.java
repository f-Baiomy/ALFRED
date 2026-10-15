package com.fathy.alfred.backend.board.application.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fathy.alfred.backend.board.application.port.in.ImportBoardUseCase;
import com.fathy.alfred.backend.board.application.port.out.BoardFileStorePort;
import com.fathy.alfred.backend.board.application.port.out.BoardImageStorePort;
import com.fathy.alfred.backend.board.application.port.out.SnippetStorePort;
import com.fathy.alfred.backend.board.application.port.out.WidgetStorePort;
import com.fathy.alfred.backend.board.domain.model.BoardFile;
import com.fathy.alfred.backend.board.domain.model.Snippet;
import com.fathy.alfred.backend.board.domain.model.SnippetShot;
import com.fathy.alfred.backend.board.domain.model.SnippetState;
import com.fathy.alfred.backend.board.domain.model.SnippetVersion;
import com.fathy.alfred.backend.board.domain.model.Widget;
import com.fathy.alfred.backend.board.application.port.out.BoardNotificationPort;
import com.fathy.alfred.backend.board.application.port.out.BoardStorePort;
import com.fathy.alfred.backend.board.application.port.out.ChatStorePort;
import com.fathy.alfred.backend.board.application.port.out.CycleNamesPort;
import com.fathy.alfred.backend.board.application.port.out.MentionedCallsChangedPort;
import com.fathy.alfred.backend.board.domain.MentionParser;
import com.fathy.alfred.backend.board.domain.RichText;
import com.fathy.alfred.backend.board.domain.model.BoardImage;
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
import java.util.Base64;
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
    private final BoardImageStorePort images;
    private final ObjectMapper json = new ObjectMapper();
    private SnippetStorePort snippets;
    private BoardFileStorePort files;
    private WidgetStorePort widgets;

    /** Pages, saved values, shots, files and widgets (specs/017 R43) come back too where those stores are present. */
    @org.springframework.beans.factory.annotation.Autowired(required = false)
    void setVisualStores(SnippetStorePort snippets, BoardFileStorePort files, WidgetStorePort widgets) {
        this.snippets = snippets;
        this.files = files;
        this.widgets = widgets;
    }

    private ChatStorePort chats;
    private CycleNamesPort cycleNames;

    /** The board chats come back too (specs/022 T052) where the chat store is present. */
    @org.springframework.beans.factory.annotation.Autowired(required = false)
    void setChats(ChatStorePort chats) {
        this.chats = chats;
    }

    /** A cycle chat whose cycle is not here lands in the project chat; without this port every cycle counts as missing. */
    @org.springframework.beans.factory.annotation.Autowired(required = false)
    void setCycleNames(CycleNamesPort cycleNames) {
        this.cycleNames = cycleNames;
    }

    public ImportBoardService(BoardStorePort store, BoardNotificationPort notifications, MentionedCallsChangedPort mentionedCalls,
                              BoardChangeFeed feed, BoardImageStorePort images) {
        this.store = store;
        this.images = images;
        this.notifications = feed.feeding(notifications);
        this.mentionedCalls = mentionedCalls;
    }

    private record PendingCard(Card card, List<MentionRef> links, String shortName) {
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
        Map<Long, Long> newIds = new HashMap<>(); // an exported entry id -> its id here, for replies
        List<Renumbered> renumbered = new ArrayList<>();
        // Pictures the texts show, by the card (or cycle) that shows them - attached once their records are read.
        Map<String, Set<String>> cardImages = new HashMap<>();
        Map<String, Set<String>> cycleImages = new HashMap<>();
        String sourceProject = null;
        boolean cardsWritten = false;
        Map<String, String> pageIds = new HashMap<>(); // an exported page id -> its id here
        ChatTransfer.Importer chatImport = null;
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
                pending.add(new PendingCard(card(c, target), links(r.path("links")), c.path("shortName").isTextual() ? c.path("shortName").asText() : null));
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
                        String text = RichText.clean(rewrite(text(e, "text"), sourceProject, target, numbers));
                        cardImages.computeIfAbsent(cardId, k -> new java.util.HashSet<>()).addAll(RichText.imageIds(text));
                        // Replies point at the new id of the comment they answer (comments come before their replies).
                        Long replyTo = e.hasNonNull("replyTo") ? newIds.get(e.path("replyTo").asLong()) : null;
                        long id = store.append(new ActivityEntry(0, cardId, actor(e.path("actor").asText()),
                                ActivityKind.valueOf(e.path("kind").asText()), text, text(e, "oldValue"), text(e, "newValue"),
                                instant(e.path("at").asText()), replyTo));
                        if (e.hasNonNull("id")) {
                            newIds.put(e.path("id").asLong(), id);
                        }
                        if (text != null) {
                            store.replaceMentions(MentionOwner.ACTIVITY, Long.toString(id), cardId, MentionParser.mentions(text));
                        }
                    }
                }
                case "brief" -> {
                    String text = RichText.clean(r.path("text").asText(""));
                    cycleImages.computeIfAbsent(r.path("cycleId").asText(), k -> new java.util.HashSet<>()).addAll(RichText.imageIds(text));
                    store.putBrief(new CycleBrief(r.path("cycleId").asText(), text, instant(r.path("updatedAt").asText())));
                    store.replaceMentions(MentionOwner.BRIEF, r.path("cycleId").asText(), null, MentionParser.mentions(text));
                }
                case "spec" -> {
                    String content = RichText.clean(r.path("content").asText(""));
                    store.putSpec(new SpecFile(r.path("cycleId").asText(), r.path("name").asText(), content,
                            content.getBytes(StandardCharsets.UTF_8).length, instant(r.path("uploadedAt").asText())));
                }
                case "mark" -> store.putMark(new ChecklistMark(r.path("cycleId").asText(), r.path("fileName").asText(),
                        r.path("itemKey").asText(), Mark.valueOf(r.path("mark").asText()), actor(r.path("actor").asText()),
                        RichText.clean(r.path("evidence").asText("")), List.of(), instant(r.path("updatedAt").asText())));
                case "image" -> image(r);
                case "page" -> page(r, target, idByOldNumber, pageIds);
                case "state" -> state(r, idByOldNumber, newIds, pageIds);
                case "shot" -> shot(r, idByOldNumber, newIds, pageIds);
                case "file" -> file(r, target, idByOldNumber);
                case "widget" -> widget(r, target);
                case "chat", "chatRecord", "chatTerminal", "chatSettings" -> {
                    if (chats != null) {
                        if (chatImport == null) {
                            String from = sourceProject;
                            chatImport = new ChatTransfer(chats, cycleNames).new Importer(target, store, t -> rewrite(t, from, target, numbers));
                        }
                        chatImport.accept(r);
                    }
                }
                default -> {
                    // A newer exporter's record this reader does not know: skipped, not fatal.
                }
            }
        }
        if (!cardsWritten) {
            writeCards(target, sourceProject, pending, numbers, idByOldNumber, renumbered);
        }
        for (PendingCard p : pending) {
            String id = idByOldNumber.get(p.card().number());
            if (id != null) {
                cardImages.computeIfAbsent(id, k -> new java.util.HashSet<>()).addAll(RichText.imageIds(p.card().description()));
            }
        }
        cardImages.forEach((cardId, ids) -> store.attachImages(ids, cardId, null));
        cycleImages.forEach((cycleId, ids) -> store.attachImages(ids, null, cycleId));
        mentionedCalls.mentionedCallsChanged();
        notifications.changed(target, null, null, "card");
        if (chatImport != null && chatImport.count() > 0) {
            notifications.chatChanged(target, null, null);
        }
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
            String shortName = p.shortName() == null ? "" : p.shortName().strip().replaceAll("\\s+", " ");
            if (!shortName.isEmpty() && shortName.length() <= com.fathy.alfred.backend.board.application.port.in.ShortNameUseCase.MAX_SHORT_NAME
                    && !shortName.contains("|") && !shortName.contains("]")) {
                store.putShortName("card", card.id(), shortName); // specs/021: what its mentions read comes along
            }
            for (MentionRef link : p.links()) {
                store.addDirect(card.id(), link);
            }
            store.append(new ActivityEntry(0, card.id(), Actor.USER, ActivityKind.IMPORTED, null, null, Integer.toString(number),
                    Instant.now()));
        }
    }

    /**
     * A picture a text shows ({@code record: "image"}, base64): kept under its id when it is a real picture and not here
     * already - importing into the Alfred it came from keeps the one it has.
     */
    private void image(JsonNode r) {
        String id = r.path("id").asText("");
        String mime = r.path("mime").asText("");
        if (!id.matches("^[A-Za-z0-9-]{8,64}$") || !com.fathy.alfred.backend.board.application.port.in.BoardImagesUseCase.TYPES.contains(mime)
                || images.findImage(id).isPresent()) {
            return;
        }
        byte[] data;
        try {
            data = Base64.getDecoder().decode(r.path("data").asText(""));
        } catch (IllegalArgumentException e) {
            return;
        }
        if (data.length == 0 || data.length > BoardImage.MAX_BYTES || !BoardImagesService.looksLike(mime, data)) {
            return;
        }
        images.saveImage(new BoardImage(id, mime, data, null, null, Instant.now()));
    }

    // -------------------------------------------------------------------------------- visuals (specs/017 R43)

    private static final Pattern INLINE_CARD = Pattern.compile("^inline:card:#(\\d+):(desc|(\\d+)(p\\d+)?):(\\d{1,3})$");
    private static final Pattern INLINE_CYCLE = Pattern.compile("^inline:cycle:[A-Za-z0-9-]{1,64}:(goal|desc|o\\d+):\\d{1,3}$");

    /** Where a page goes here: its card (by the number it had), its cycle, or the project imported into. */
    private void page(JsonNode r, String target, Map<Integer, String> idByOldNumber, Map<String, String> pageIds) {
        if (snippets == null) {
            return;
        }
        String owner = r.path("owner").asText();
        String cardId = "card".equals(owner) ? idByOldNumber.get(r.path("cardNumber").asInt(-1)) : null;
        String cycleId = "cycle".equals(owner) ? text(r, "cycleId") : null;
        if (("card".equals(owner) && cardId == null) || ("cycle".equals(owner) && (cycleId == null || !cycleId.matches("^[A-Za-z0-9-]{1,64}$")))) {
            return;
        }
        Snippet.Kind kind;
        try {
            kind = Snippet.Kind.valueOf(r.path("kind").asText("HTML"));
        } catch (IllegalArgumentException e) {
            return;
        }
        String source = r.path("source").asText("");
        if (source.getBytes(StandardCharsets.UTF_8).length > 256 * 1024) {
            return;
        }
        Snippet.Owner o = cardId != null ? Snippet.Owner.CARD : cycleId != null ? Snippet.Owner.CYCLE : Snippet.Owner.PROJECT;
        String id = UUID.randomUUID().toString();
        int version = Math.max(1, r.path("version").asInt(1));
        Snippet s = new Snippet(id, o, cardId != null ? cardId : cycleId != null ? cycleId : target, target, cardId, cycleId,
                r.path("name").asText("Page"), kind, r.path("info").asText(""), source, actor(r.path("author").asText()),
                r.path("pinned").asBoolean(false), r.path("position").asInt(0), version, instant(text(r, "createdAt")),
                instant(text(r, "updatedAt")), actor(r.path("updatedBy").asText()));
        snippets.insert(s);
        pageIds.put(r.path("id").asText(), id);
        for (JsonNode v : r.path("versions")) {
            if (v.path("version").asInt() != version && v.path("source").asText("").getBytes(StandardCharsets.UTF_8).length <= 256 * 1024) {
                snippets.importVersion(new SnippetVersion(id, v.path("version").asInt(), v.path("name").asText(""), v.path("info").asText(""),
                        v.path("source").asText(""), 0, actor(v.path("author").asText()), instant(text(v, "at"))));
            }
        }
    }

    /** An exported snippet id as the id here: a page's new id, an inline block on its card's new id and its comment's new id. */
    private record Place(String snippetId, String cardId, String cycleId) {
    }

    private Place place(String exported, Map<Integer, String> idByOldNumber, Map<Long, Long> newIds, Map<String, String> pageIds) {
        if (exported == null) {
            return null;
        }
        if (exported.startsWith("page:")) {
            String id = pageIds.get(exported.substring(5));
            return id == null ? null : snippets.find(id).map(p -> new Place(id, p.cardId(), p.cycleId())).orElse(null);
        }
        Matcher m = INLINE_CARD.matcher(exported);
        if (m.matches()) {
            String cardId = idByOldNumber.get(Integer.parseInt(m.group(1)));
            if (cardId == null) {
                return null;
            }
            String where = m.group(2);
            if (m.group(3) != null) {
                Long entry = newIds.get(Long.parseLong(m.group(3)));
                if (entry == null) {
                    return null;
                }
                where = entry + (m.group(4) == null ? "" : m.group(4));
            }
            return new Place("inline:card:" + cardId + ":" + where + ":" + m.group(5), cardId, null);
        }
        if (INLINE_CYCLE.matcher(exported).matches()) {
            return new Place(exported, null, exported.split(":")[2]);
        }
        return null;
    }

    private void state(JsonNode r, Map<Integer, String> idByOldNumber, Map<Long, Long> newIds, Map<String, String> pageIds) {
        if (snippets == null) {
            return;
        }
        Place p = place(text(r, "snippetId"), idByOldNumber, newIds, pageIds);
        String key = r.path("key").asText("");
        String value = r.path("value").asText("");
        if (p == null || key.isEmpty() || key.length() > SnippetState.MAX_KEY || value.getBytes(StandardCharsets.UTF_8).length > SnippetState.MAX_VALUE_BYTES) {
            return;
        }
        try {
            json.readTree(value); // a value is JSON text, as alfred.state keeps it
        } catch (IOException e) {
            return;
        }
        snippets.putState(new SnippetState(p.snippetId(), key, value, actor(r.path("updatedBy").asText()), instant(text(r, "at"))), p.cardId(), p.cycleId());
    }

    private void shot(JsonNode r, Map<Integer, String> idByOldNumber, Map<Long, Long> newIds, Map<String, String> pageIds) {
        if (snippets == null) {
            return;
        }
        Place p = place(text(r, "snippetId"), idByOldNumber, newIds, pageIds);
        byte[] png;
        try {
            png = Base64.getDecoder().decode(r.path("png").asText(""));
        } catch (IllegalArgumentException e) {
            return;
        }
        if (p == null || png.length == 0 || png.length > SnippetShot.MAX_PNG_BYTES || !BoardImagesService.looksLike("image/png", png)) {
            return;
        }
        String console = r.path("console").asText("");
        snippets.putShot(new SnippetShot(p.snippetId(), r.path("version").asInt(1), png,
                console.length() > SnippetShot.MAX_CONSOLE ? console.substring(console.length() - SnippetShot.MAX_CONSOLE) : console,
                instant(text(r, "at"))), p.cardId(), p.cycleId());
    }

    /** A file keeps its id (the texts link to it) unless that id is here already - then the one here is what they show. */
    private void file(JsonNode r, String target, Map<Integer, String> idByOldNumber) {
        if (files == null) {
            return;
        }
        String id = r.path("id").asText("");
        String name = r.path("name").asText("");
        String mime = BoardFile.TYPES.get(BoardFile.extension(name));
        String cardId = r.has("cardNumber") ? idByOldNumber.get(r.path("cardNumber").asInt(-1)) : null;
        String cycleId = cardId == null ? text(r, "cycleId") : null;
        if (!id.matches("^[A-Za-z0-9-]{8,64}$") || mime == null || (cardId == null && cycleId == null) || files.findFile(id).isPresent()) {
            return;
        }
        byte[] data;
        try {
            data = Base64.getDecoder().decode(r.path("data").asText(""));
        } catch (IllegalArgumentException e) {
            return;
        }
        if (data.length == 0 || data.length > BoardFile.MAX_BYTES || BoardFilesService.content(mime, data) != null) {
            return;
        }
        String cycle = cardId != null ? store.find(cardId).map(Card::cycleId).orElse(null) : cycleId;
        files.saveFile(new BoardFile(id, target, cardId, cycle, name, mime, data.length, data, actor(r.path("author").asText()), instant(text(r, "createdAt"))));
    }

    /** A widget comes in under its name unless the project has one by that name already - that one is kept. */
    private void widget(JsonNode r, String target) {
        if (widgets == null) {
            return;
        }
        String name = r.path("name").asText("");
        String source = r.path("source").asText("");
        Widget.Kind kind;
        try {
            kind = Widget.Kind.valueOf(r.path("kind").asText("HTML"));
        } catch (IllegalArgumentException e) {
            return;
        }
        if (!name.matches(Widget.NAME) || source.isBlank() || source.getBytes(StandardCharsets.UTF_8).length > Widget.MAX_SOURCE
                || widgets.widget(target, name).isPresent()) {
            return;
        }
        widgets.putWidget(new Widget(target, name, kind, r.path("info").asText(""), source, actor(r.path("author").asText()),
                instant(text(r, "updatedAt")), actor(r.path("updatedBy").asText())));
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
                c.path("title").asText(), RichText.clean(c.path("description").asText("")), CardStatus.valueOf(status),
                c.hasNonNull("resolution") ? Resolution.valueOf(c.get("resolution").asText()) : null, text(c, "reason"), Set.copyOf(flags),
                Scope.valueOf(c.path("scope").asText("NOT_DECIDED")), actor(c.path("author").asText()), text(c, "cycleId"),
                c.path("cycleDeleted").asBoolean(false), text(c, "signature"), created, instant(c.path("updatedAt").asText()),
                actor(c.path("updatedBy").asText()), teams(c.path("teams")));
    }

    /** The card's teams that exist here - a file from another Alfred may name teams this one does not have. */
    private List<String> teams(JsonNode teams) {
        java.util.Set<String> known = new java.util.HashSet<>();
        store.teams().forEach(t -> known.add(t.id()));
        List<String> out = new ArrayList<>();
        teams.forEach(t -> {
            if (known.contains(t.asText())) {
                out.add(t.asText());
            }
        });
        return out;
    }

    private static List<MentionRef> links(JsonNode links) {
        List<MentionRef> out = new ArrayList<>();
        links.forEach(l -> {
            // A link type this Alfred does not know (a newer export, specs/022 R14) is skipped, never a failed import.
            MentionType type = mentionType(l.path("type").asText());
            if (type != null) {
                out.add(new MentionRef(type, l.path("ref").asText(), l.path("label").asText()));
            }
        });
        return out;
    }

    private static MentionType mentionType(String name) {
        try {
            return MentionType.valueOf(name.strip().toUpperCase(Locale.ROOT));
        } catch (IllegalArgumentException e) {
            return null;
        }
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
