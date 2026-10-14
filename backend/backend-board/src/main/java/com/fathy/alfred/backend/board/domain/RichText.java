package com.fathy.alfred.backend.board.domain;

import org.jsoup.Jsoup;
import org.jsoup.nodes.Document;
import org.jsoup.nodes.Element;
import org.jsoup.nodes.Node;
import org.jsoup.nodes.TextNode;
import org.jsoup.safety.Cleaner;
import org.jsoup.safety.Safelist;
import org.jsoup.select.NodeTraversor;
import org.jsoup.select.NodeVisitor;

import java.util.LinkedHashSet;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * The board's rich text (docs/board.md "Rich text"): a text is either Markdown - everything written before rich text,
 * and what Claude writes - or HTML from the board's editor. HTML is cleaned on every save to the tags and attributes the
 * board shows; anything else is dropped (scripts, styles, classes, handlers, frames, forms, outside pictures), so what is
 * stored is safe whoever wrote it. Mentions stay {@code @[type:ref|label]} text inside it; {@link #plain} gives the words
 * (mentions intact) to everything that reads text rather than shows it.
 */
public final class RichText {

    /** HTML starts with one of the editor's block tags; Markdown never does. */
    private static final Pattern HTML = Pattern.compile("^\\s*<(p|h[1-4]|ul|ol|div|aside|table|pre|blockquote|details|hr|img|figure)[\\s>/]",
            Pattern.CASE_INSENSITIVE);
    /** A picture stored in Alfred: the only {@code src} kept. */
    private static final Pattern IMAGE = Pattern.compile("/board/images/([A-Za-z0-9-]{8,64})");
    private static final Set<String> CALLOUTS = Set.of("info", "warn", "bug", "ok", "next");
    private static final Set<String> COLORS = Set.of("red", "green", "amber", "blue", "purple");
    private static final Set<String> PILLS = Set.of("ok", "fail", "wait", "info");

    private static final Safelist SAFE = new Safelist()
            .addTags("p", "h1", "h2", "h3", "h4", "br", "hr", "b", "strong", "i", "em", "u", "s", "mark", "sub", "sup", "kbd", "code",
                    "pre", "blockquote", "ul", "ol", "li", "table", "thead", "tbody", "tr", "th", "td", "a", "img", "details", "summary",
                    "aside", "span", "div")
            .addAttributes("a", "href", "title")
            .addAttributes("img", "src", "alt", "width")
            .addAttributes("pre", "data-lang")
            .addAttributes("ul", "data-checklist")
            .addAttributes("li", "data-checked")
            .addAttributes("aside", "data-callout")
            .addAttributes("span", "data-color", "data-pill")
            .addAttributes("th", "colspan", "rowspan")
            .addAttributes("td", "colspan", "rowspan")
            .addAttributes(":all", "dir")
            .addProtocols("a", "href", "http", "https", "mailto");

    private RichText() {
    }

    public static boolean isHtml(String text) {
        return text != null && HTML.matcher(text).find();
    }

    /** Markdown as written; HTML cleaned to what the board shows. */
    public static String clean(String text) {
        if (!isHtml(text)) {
            return text;
        }
        Document clean = new Cleaner(SAFE).clean(Jsoup.parseBodyFragment(text));
        for (Element img : clean.select("img")) {
            if (!IMAGE.matcher(img.attr("src")).matches()) {
                img.remove(); // only pictures stored in Alfred - never one that loads from elsewhere
            }
        }
        keepOnly(clean, "aside", "data-callout", CALLOUTS);
        keepOnly(clean, "span", "data-color", COLORS);
        keepOnly(clean, "span", "data-pill", PILLS);
        for (Element e : clean.select("[dir]")) {
            String dir = e.attr("dir");
            if (!"rtl".equals(dir) && !"ltr".equals(dir) && !"auto".equals(dir)) {
                e.removeAttr("dir");
            }
        }
        for (Element li : clean.select("li[data-checked]")) {
            li.attr("data-checked", "true".equals(li.attr("data-checked")) ? "true" : "false");
        }
        clean.outputSettings().prettyPrint(false);
        String out = clean.body().html();
        return isHtml(out) ? out : "<p>" + out + "</p>";
    }

    private static void keepOnly(Document doc, String tag, String attr, Set<String> allowed) {
        for (Element e : doc.select(tag + "[" + attr + "]")) {
            if (!allowed.contains(e.attr(attr))) {
                e.removeAttr(attr);
            }
        }
    }

    /**
     * The words of a text, for whatever reads it rather than shows it (mentions, signatures, search): Markdown as it is;
     * HTML as text with a line break per block and its entities decoded, so a mention label reads as written.
     */
    public static String plain(String text) {
        if (!isHtml(text)) {
            return text;
        }
        Document doc = Jsoup.parseBodyFragment(text);
        StringBuilder out = new StringBuilder();
        NodeTraversor.traverse(new NodeVisitor() {
            @Override
            public void head(Node node, int depth) {
                if (node instanceof TextNode t) {
                    out.append(t.getWholeText());
                } else if (node instanceof Element e && ("br".equals(e.tagName()) || e.isBlock()) && !out.isEmpty()
                        && out.charAt(out.length() - 1) != '\n') {
                    out.append('\n');
                }
            }

            @Override
            public void tail(Node node, int depth) {
                if (node instanceof Element e && e.isBlock() && !out.isEmpty() && out.charAt(out.length() - 1) != '\n') {
                    out.append('\n');
                }
            }
        }, doc.body());
        return out.toString().strip();
    }

    /**
     * HTML as the Markdown lines readers of structure expect - headings as {@code #}, list items as {@code - } (checked
     * ones {@code - [x]}), other blocks as their text - so a spec file or brief written in the editor still gives its
     * acceptance items. Markdown is returned as it is.
     */
    public static String markdownLines(String text) {
        if (!isHtml(text)) {
            return text;
        }
        StringBuilder out = new StringBuilder();
        for (Element e : Jsoup.parseBodyFragment(text).body().select("h1, h2, h3, h4, li, p, pre, blockquote, td, th, summary")) {
            if (!e.select("> li, > p, > ul, > ol").isEmpty() && !"li".equals(e.tagName())) {
                continue;
            }
            String words = e.text().strip();
            if (words.isEmpty()) {
                continue;
            }
            switch (e.tagName()) {
                case "h1", "h2", "h3", "h4" -> out.append("#".repeat(e.tagName().charAt(1) - '0')).append(' ').append(words);
                case "li" -> out.append(e.hasAttr("data-checked") ? ("true".equals(e.attr("data-checked")) ? "- [x] " : "- [ ] ") : "- ").append(words);
                default -> out.append(words);
            }
            out.append('\n');
        }
        return out.toString();
    }

    /** The ids of the pictures a text shows (Markdown {@code ![](/board/images/id)} or HTML {@code <img src>}). */
    public static Set<String> imageIds(String text) {
        Set<String> out = new LinkedHashSet<>();
        if (text == null) {
            return out;
        }
        Matcher m = IMAGE.matcher(text);
        while (m.find()) {
            out.add(m.group(1));
        }
        return out;
    }
}
