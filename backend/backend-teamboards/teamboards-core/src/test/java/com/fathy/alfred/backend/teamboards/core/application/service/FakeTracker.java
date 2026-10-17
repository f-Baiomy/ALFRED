package com.fathy.alfred.backend.teamboards.core.application.service;

import com.fathy.alfred.backend.teamboards.spi.AttachmentWriter;
import com.fathy.alfred.backend.teamboards.spi.Connector;
import com.fathy.alfred.backend.teamboards.spi.HookReader;
import com.fathy.alfred.backend.teamboards.spi.IdentityReader;
import com.fathy.alfred.backend.teamboards.spi.ItemReader;
import com.fathy.alfred.backend.teamboards.spi.ItemSearcher;
import com.fathy.alfred.backend.teamboards.spi.ItemWriter;
import com.fathy.alfred.backend.teamboards.spi.ProviderException;
import com.fathy.alfred.backend.teamboards.spi.ProviderWords;
import com.fathy.alfred.backend.teamboards.spi.StateCatalog;
import com.fathy.alfred.backend.teamboards.spi.TreeReader;
import com.fathy.alfred.backend.teamboards.spi.model.Comment;
import com.fathy.alfred.backend.teamboards.spi.model.Connection;
import com.fathy.alfred.backend.teamboards.spi.model.Item;
import com.fathy.alfred.backend.teamboards.spi.model.ItemPage;
import com.fathy.alfred.backend.teamboards.spi.model.ItemQuery;
import com.fathy.alfred.backend.teamboards.spi.model.ItemTypeInfo;
import com.fathy.alfred.backend.teamboards.spi.model.Link;
import com.fathy.alfred.backend.teamboards.spi.model.NewItem;
import com.fathy.alfred.backend.teamboards.spi.model.Person;
import com.fathy.alfred.backend.teamboards.spi.model.Token;
import com.fathy.alfred.backend.teamboards.spi.model.TreeRef;
import com.fathy.alfred.backend.teamboards.spi.model.TypeStates;

import java.net.URI;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** An in-memory tracker for the core tests: items, a tree by Parent links, comments, and every write it was asked for. */
class FakeTracker implements Connector, ItemSearcher, ItemReader, TreeReader, IdentityReader, StateCatalog, ItemWriter, AttachmentWriter, HookReader {

    final Map<String, Item> items = new LinkedHashMap<>();
    final Map<String, List<Comment>> comments = new LinkedHashMap<>();
    final List<String> writes = new ArrayList<>();
    final List<ItemQuery> searches = new ArrayList<>();
    Person owner = new Person("p-1", "Sara Ali", "sara@example.com");
    String goodToken = "pat-1";
    int nextId = 900;

    @Override
    public String kind() {
        return "fake";
    }

    @Override
    public String displayName() {
        return "Fake tracker";
    }

    @Override
    public ProviderWords words() {
        return ProviderWords.NEUTRAL;
    }

    void check(Token t) throws ProviderException {
        if (t == null || !goodToken.equals(t.value())) {
            throw new ProviderException(ProviderException.Kind.TOKEN_REJECTED, "refused");
        }
    }

    static Item item(String id, String type, String title, String state, String parent, int rev) {
        List<Link> links = parent == null ? List.of() : List.of(new Link(parent, "Parent"));
        Map<String, String> fields = new LinkedHashMap<>();
        fields.put("System.Title", title);
        fields.put("System.State", state);
        fields.put("System.Description", "About " + title);
        return new Item(id, type, false, title, state, "Sara Ali", "Payments", "Sprint 1", "Odeysys\\Payments", URI.create("https://t/" + id), rev,
                Instant.parse("2026-10-01T00:00:00Z"), "Omar", fields, links, "{\"id\":" + id + "}",
                Map.of("assigned", new Person("p-1", "Sara Ali", "sara@example.com")), "Odeysys");
    }

    FakeTracker put(Item i) {
        // a child's Parent link also shows on its parent as Child
        items.put(i.extId(), i);
        return this;
    }

    @Override
    public Item item(Connection c, Token t, String extId) throws ProviderException {
        check(t);
        Item i = items.get(extId);
        if (i == null) {
            throw new ProviderException(ProviderException.Kind.NOT_FOUND, "Fake tracker has no item " + extId);
        }
        return withChildren(i);
    }

    Item withChildren(Item i) {
        List<Link> links = new ArrayList<>(i.links());
        for (Item o : items.values()) {
            if (o.links().stream().anyMatch(l -> l.kind().equals("Parent") && l.toId().equals(i.extId()))) {
                links.add(new Link(o.extId(), "Child"));
            }
        }
        return new Item(i.extId(), i.type(), i.customType(), i.title(), i.state(), i.assignee(), i.squad(), i.sprint(), i.area(), i.url(), i.rev(),
                i.changedAt(), i.changedBy(), i.fields(), links, i.nativeJson(), i.identities(), i.project());
    }

    @Override
    public List<ItemTypeInfo> types(Connection c, Token t) {
        return List.of(new ItemTypeInfo("Bug", false), new ItemTypeInfo("Task", false), new ItemTypeInfo("Feature", false));
    }

    @Override
    public List<Person> people(Connection c, Token t) {
        return List.of(owner, new Person("p-2", "Omar", "omar@example.com"));
    }

    @Override
    public ItemPage search(Connection c, Token t, ItemQuery q) throws ProviderException {
        check(t);
        searches.add(q);
        List<Item> all = new ArrayList<>();
        for (Item i : items.values()) {
            boolean open = !i.state().equals("Closed") && !i.state().equals("Removed");
            if ((!q.openOnly() || open) && (q.text() == null || i.title().toLowerCase().contains(q.text().toLowerCase()))
                    && (q.types().isEmpty() || q.types().contains(i.type()))) {
                all.add(withChildren(i));
            }
        }
        int from = Math.min(all.size(), q.page() * q.pageSize());
        return new ItemPage(all.subList(from, Math.min(all.size(), from + q.pageSize())), all.size(), q.text() != null);
    }

    @Override
    public List<Item> items(Connection c, Token t, List<String> ids) throws ProviderException {
        check(t);
        List<Item> out = new ArrayList<>();
        for (String id : ids) {
            if (items.containsKey(id)) {
                out.add(withChildren(items.get(id)));
            }
        }
        return out;
    }

    @Override
    public List<Comment> comments(Connection c, Token t, String id) throws ProviderException {
        check(t);
        return comments.getOrDefault(id, List.of());
    }

    @Override
    public List<TreeRef> tree(Connection c, Token t, String rootId, int max) throws ProviderException {
        check(t);
        List<TreeRef> out = new ArrayList<>();
        Item root = items.get(rootId);
        int depth = -1;
        String p = parentOf(root);
        while (p != null && items.containsKey(p)) {
            out.add(new TreeRef(p, TreeRef.ANCESTOR, depth--, parentOf(items.get(p)), null));
            p = parentOf(items.get(p));
        }
        descend(rootId, 1, out, max);
        return out;
    }

    private void descend(String id, int depth, List<TreeRef> out, int max) {
        for (Item o : items.values()) {
            if (id.equals(parentOf(o)) && out.size() <= max) {
                out.add(new TreeRef(o.extId(), TreeRef.DESCENDANT, depth, id, null));
                descend(o.extId(), depth + 1, out, max);
            }
        }
    }

    static String parentOf(Item i) {
        return i == null ? null : i.links().stream().filter(l -> l.kind().equals("Parent")).map(Link::toId).findFirst().orElse(null);
    }

    @Override
    public Person whoAmI(Connection c, Token t) throws ProviderException {
        check(t);
        return owner;
    }

    @Override
    public List<Person> peopleById(Connection c, Token t, Collection<String> ids) {
        return ids.stream().map(id -> new Person(id, "Person " + id, id + "@example.com")).toList();
    }

    @Override
    public List<TypeStates> states(Connection c, Token t) {
        List<TypeStates.State> s = List.of(new TypeStates.State("New", "Proposed"), new TypeStates.State("Active", "InProgress"),
                new TypeStates.State("Resolved", "Resolved"), new TypeStates.State("Closed", "Completed"));
        return List.of(new TypeStates("Odeysys", "Bug", s), new TypeStates("Odeysys", "Task", s));
    }

    @Override
    public String comment(Connection c, Token t, String id, String text) throws ProviderException {
        check(t);
        writes.add("comment " + id + ": " + text);
        return "c-" + writes.size();
    }

    @Override
    public void moveState(Connection c, Token t, String id, String state) throws ProviderException {
        check(t);
        writes.add("state " + id + " " + state);
        Item i = items.get(id);
        put(item(id, i.type(), i.title(), state, parentOf(i), i.rev() + 1));
    }

    @Override
    public String create(Connection c, Token t, NewItem item) throws ProviderException {
        check(t);
        String id = String.valueOf(nextId++);
        writes.add("create " + id + " " + item.type() + " " + item.title());
        put(item(id, item.type(), item.title(), "New", null, 1));
        return id;
    }

    @Override
    public void hyperlink(Connection c, Token t, String id, URI url, String label, boolean add) throws ProviderException {
        check(t);
        writes.add((add ? "hyperlink " : "unhyperlink ") + id + " " + url);
    }

    @Override
    public void tag(Connection c, Token t, String id, String tag, boolean add) throws ProviderException {
        check(t);
        writes.add((add ? "tag " : "untag ") + id + " " + tag);
    }

    @Override
    public void attach(Connection c, Token t, String id, String name, byte[] data) throws ProviderException {
        check(t);
        writes.add("attach " + id + " " + name + " " + data.length);
    }

    @Override
    public List<String> ids(String body) {
        java.util.regex.Matcher m = java.util.regex.Pattern.compile("\"workItemId\"\\s*:\\s*(\\d+)").matcher(body);
        return m.find() ? List.of(m.group(1)) : List.of();
    }
}
