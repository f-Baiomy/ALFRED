package com.fathy.alfred.backend.board.application.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fathy.alfred.backend.board.domain.RichText;
import com.fathy.alfred.backend.board.domain.model.BoardImage;
import org.commonmark.ext.gfm.tables.TablesExtension;
import org.commonmark.parser.Parser;
import org.commonmark.renderer.html.HtmlRenderer;
import org.jsoup.Jsoup;
import org.jsoup.nodes.Document;
import org.jsoup.nodes.Element;
import org.jsoup.safety.Safelist;

import javax.imageio.IIOImage;
import javax.imageio.ImageIO;
import javax.imageio.ImageWriteParam;
import javax.imageio.ImageWriter;
import javax.imageio.stream.ImageOutputStream;
import java.awt.Color;
import java.awt.Graphics2D;
import java.awt.RenderingHints;
import java.awt.image.BufferedImage;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.Locale;
import java.util.Optional;
import java.util.function.Function;
import java.util.function.UnaryOperator;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * A question's details (specs/037 D13) made static for the offline questions form: Markdown (or the editor's HTML) to
 * cleaned HTML, pictures stored in Alfred embedded as {@code data:} (scaled to {@value #MAX_WIDTH} px), {@code ```stats}
 * and {@code ```chart} drawn as HTML and inline SVG, mentions as their labels. Nothing in the result loads anything:
 * no outside picture, no link target, no script. A live snippet cannot run offline - it becomes a note and is named in
 * {@link Rendered#leftOut()}.
 */
final class FormDetailsRenderer {

    static final int MAX_WIDTH = 1600;
    /** A picture larger than this (after scaling) is written again as JPEG. */
    static final int JPEG_ABOVE = 300 * 1024;

    record Rendered(String html, int pictures, List<String> leftOut) {
    }

    private static final ObjectMapper JSON = new ObjectMapper();
    private static final Pattern FENCE = Pattern.compile("(?ms)^```([A-Za-z]+)([ \\t]+live)?[^\\n]*\\n(.*?)\\n?```[ \\t]*$");
    private static final Pattern MENTION = Pattern.compile("@\\[([a-z]+):([^|\\]]+)(?:\\|([^\\]]*))?]");
    private static final Pattern IMAGE = Pattern.compile("/board/images/([A-Za-z0-9-]{8,64})");
    private static final Pattern TOKEN = Pattern.compile("ALFREDBLOCK(\\d+)X");
    private static final String[] SERIES = {"#7c6cf0", "#0ea5c6", "#1f9d6b", "#d99a1e", "#e0524d", "#3b82f6", "#db4fa0", "#7b8794"};

    private static final Parser MARKDOWN = Parser.builder().extensions(List.of(TablesExtension.create())).build();
    private static final HtmlRenderer HTML = HtmlRenderer.builder().extensions(List.of(TablesExtension.create())).escapeHtml(true).build();
    private static final Safelist SAFE = Safelist.relaxed().removeTags("img", "a").addTags("figure", "figcaption", "details", "summary", "mark", "hr");

    private final Function<String, Optional<BoardImage>> images;
    private final UnaryOperator<String> mask;

    FormDetailsRenderer(Function<String, Optional<BoardImage>> images, UnaryOperator<String> mask) {
        this.images = images;
        this.mask = mask;
    }

    Rendered render(String details) {
        if (details == null || details.isBlank()) {
            return new Rendered(null, 0, List.of());
        }
        List<String> blocks = new ArrayList<>();
        List<String> leftOut = new ArrayList<>();
        int[] pictures = {0};
        String text = mask.apply(details);
        text = MENTION.matcher(text).replaceAll(m -> Matcher.quoteReplacement(m.group(3) != null && !m.group(3).isBlank() ? m.group(3) : m.group(2)));

        // fixed blocks are drawn here; their place is kept by a token the Markdown leaves alone
        Matcher f = FENCE.matcher(text);
        StringBuilder sb = new StringBuilder();
        while (f.find()) {
            String lang = f.group(1).toLowerCase(Locale.ROOT);
            boolean live = f.group(2) != null;
            String body = f.group(3);
            String html;
            if (live || lang.equals("snippet")) {
                html = "<p class=\"fd-note\">" + esc(lang) + " snippet - open the board to see it</p>";
                leftOut.add("a " + lang + " live snippet");
            } else if (lang.equals("stats")) {
                html = stats(body);
            } else if (lang.equals("chart")) {
                html = chart(body);
            } else if (lang.equals("calls") || lang.equals("timeline") || lang.equals("questions") || lang.equals("answers")) {
                html = "<p class=\"fd-note\">" + esc(lang) + " - open the board to see it live</p>";
                if (lang.equals("calls") || lang.equals("timeline")) {
                    leftOut.add("a live " + lang + " block");
                }
            } else {
                html = "<pre><code>" + esc(body) + "</code></pre>";
            }
            blocks.add(html);
            f.appendReplacement(sb, Matcher.quoteReplacement("\n\nALFREDBLOCK" + (blocks.size() - 1) + "X\n\n"));
        }
        f.appendTail(sb);
        text = sb.toString();

        // pictures: kept out of the cleaning by a token, embedded after it
        Document raw = Jsoup.parseBodyFragment(RichText.isHtml(text) ? text : HTML.render(MARKDOWN.parse(text)));
        for (Element img : raw.select("img")) {
            Matcher im = IMAGE.matcher(img.attr("src"));
            String figure = "";
            if (im.find()) {
                Optional<String> uri = images.apply(im.group(1)).flatMap(FormDetailsRenderer::dataUri);
                if (uri.isPresent()) {
                    pictures[0]++;
                    String alt = img.attr("alt");
                    figure = "<figure><img src=\"" + uri.get() + "\" alt=\"" + esc(alt) + "\">" + (alt.isBlank() ? "" : "<figcaption>" + esc(alt) + "</figcaption>") + "</figure>";
                } else {
                    leftOut.add("a picture that is no longer in Alfred");
                }
            } else {
                leftOut.add("a picture from outside Alfred");
            }
            blocks.add(figure);
            img.replaceWith(new org.jsoup.nodes.TextNode("ALFREDBLOCK" + (blocks.size() - 1) + "X"));
        }
        // links: the words stay, the target goes (the form opens nothing)
        for (Element a : raw.select("a")) {
            a.unwrap();
        }
        String clean = Jsoup.clean(raw.body().html(), SAFE);
        Document out = Jsoup.parseBodyFragment(clean);
        out.outputSettings().prettyPrint(false);
        String html = out.body().html();
        Matcher t = TOKEN.matcher(html);
        StringBuilder done = new StringBuilder();
        while (t.find()) {
            int i = Integer.parseInt(t.group(1));
            t.appendReplacement(done, Matcher.quoteReplacement(i < blocks.size() ? blocks.get(i) : ""));
        }
        t.appendTail(done);
        String result = done.toString().replace("<p></p>", "").replaceAll("<p>\\s*(<(?:figure|div|svg|pre|p class=\"fd-note\")[\\s\\S]*?)</p>", "$1");
        return new Rendered(result, pictures[0], List.copyOf(leftOut));
    }

    // ------------------------------------------------------------------------------------------------------- pictures

    /** The picture as a data: URI, scaled down to {@value #MAX_WIDTH} px and written as JPEG when large. */
    static Optional<String> dataUri(BoardImage image) {
        if (image == null || image.data() == null || image.data().length == 0) {
            return Optional.empty();
        }
        String mime = image.mime() == null ? "" : image.mime().toLowerCase(Locale.ROOT);
        if (!mime.matches("image/(png|jpeg|gif|webp)")) {
            return Optional.empty();
        }
        byte[] bytes = image.data();
        try {
            BufferedImage read = ImageIO.read(new ByteArrayInputStream(bytes));
            if (read != null && (read.getWidth() > MAX_WIDTH || bytes.length > JPEG_ABOVE)) {
                int w = Math.min(MAX_WIDTH, read.getWidth());
                int h = Math.max(1, (int) Math.round(read.getHeight() * (w / (double) read.getWidth())));
                BufferedImage rgb = new BufferedImage(w, h, BufferedImage.TYPE_INT_RGB);
                Graphics2D g = rgb.createGraphics();
                g.setRenderingHint(RenderingHints.KEY_INTERPOLATION, RenderingHints.VALUE_INTERPOLATION_BILINEAR);
                g.setRenderingHint(RenderingHints.KEY_RENDERING, RenderingHints.VALUE_RENDER_QUALITY);
                g.setColor(Color.WHITE);
                g.fillRect(0, 0, w, h);
                g.drawImage(read, 0, 0, w, h, null);
                g.dispose();
                byte[] jpeg = jpeg(rgb);
                if (jpeg.length < bytes.length || read.getWidth() > MAX_WIDTH) {
                    bytes = jpeg;
                    mime = "image/jpeg";
                }
            }
        } catch (IOException | RuntimeException e) {
            // a picture the JDK cannot read (WebP) is embedded as it is
        }
        return Optional.of("data:" + mime + ";base64," + Base64.getEncoder().encodeToString(bytes));
    }

    private static byte[] jpeg(BufferedImage img) throws IOException {
        ImageWriter writer = ImageIO.getImageWritersByFormatName("jpeg").next();
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        try (ImageOutputStream ios = ImageIO.createImageOutputStream(out)) {
            writer.setOutput(ios);
            ImageWriteParam p = writer.getDefaultWriteParam();
            p.setCompressionMode(ImageWriteParam.MODE_EXPLICIT);
            p.setCompressionQuality(0.82f);
            writer.write(null, new IIOImage(img, null, null), p);
        } finally {
            writer.dispose();
        }
        return out.toByteArray();
    }

    // ---------------------------------------------------------------------------------------------------------- stats

    /** {@code label | value | colour | note} per line - the board's own format (board-visuals.ts parseStats). */
    static String stats(String source) {
        StringBuilder out = new StringBuilder("<div class=\"fd-stats\">");
        int n = 0;
        for (String raw : source.split("\\r?\\n")) {
            String line = raw.strip();
            if (line.isEmpty() || line.startsWith("#")) {
                continue;
            }
            String[] p = line.split("\\|", -1);
            if (p.length < 2 || p[0].isBlank()) {
                continue;
            }
            String note = p.length > 3 ? p[3].strip() : p.length > 2 && !isColor(p[2]) ? p[2].strip() : "";
            out.append("<div><b>").append(esc(p[1].strip())).append("</b>").append(esc(p[0].strip()))
                    .append(note.isEmpty() ? "" : "<small>" + esc(note) + "</small>").append("</div>");
            n++;
        }
        return n == 0 ? "<pre><code>" + esc(source) + "</code></pre>" : out.append("</div>").toString();
    }

    private static boolean isColor(String s) {
        return s != null && s.strip().toLowerCase(Locale.ROOT).matches("red|green|amber|blue|purple|cyan|dim");
    }

    // ---------------------------------------------------------------------------------------------------------- chart

    /** The board's chart JSON (board-visuals.ts parseChart) as an inline SVG: bars, lines or areas; a pie is drawn as bars. */
    static String chart(String source) {
        JsonNode raw;
        try {
            raw = JSON.readTree(source);
        } catch (IOException e) {
            raw = null;
        }
        if (raw == null || !raw.isObject()) {
            return "<pre><code>" + esc(source) + "</code></pre>";
        }
        String type = raw.path("type").asText("bar").toLowerCase(Locale.ROOT);
        List<String> labels = new ArrayList<>();
        raw.path("labels").forEach(l -> labels.add(l.asText()));
        List<String> names = new ArrayList<>();
        List<double[]> values = new ArrayList<>();
        if (raw.path("series").isArray()) {
            for (JsonNode s : raw.path("series")) {
                names.add(s.path("name").asText(""));
                values.add(numbers(s.path("values")));
            }
        } else if (raw.path("values").isArray()) {
            names.add(raw.path("name").asText(""));
            values.add(numbers(raw.path("values")));
        }
        int n = labels.size();
        for (double[] v : values) {
            n = Math.max(n, v.length);
        }
        if (values.isEmpty() || n == 0) {
            return "<pre><code>" + esc(source) + "</code></pre>";
        }
        double max = 0;
        for (double[] v : values) {
            for (double x : v) {
                max = Math.max(max, x);
            }
        }
        max = max <= 0 ? 1 : max;
        String unit = raw.path("unit").asText("");
        int w = 560;
        int h = 220;
        int left = 40;
        int bottom = 30;
        int top = 24;
        double plotW = w - left - 10;
        double plotH = h - top - bottom;
        StringBuilder svg = new StringBuilder("<svg class=\"fd-chart\" viewBox=\"0 0 " + w + " " + h + "\" role=\"img\">");
        String title = raw.path("title").asText("");
        if (!title.isBlank()) {
            svg.append("<text x=\"").append(left).append("\" y=\"14\" class=\"fd-ct\">").append(esc(title)).append("</text>");
        }
        svg.append("<line x1=\"").append(left).append("\" y1=\"").append(h - bottom).append("\" x2=\"").append(w - 10).append("\" y2=\"").append(h - bottom)
                .append("\" class=\"fd-axis\"/>");
        svg.append("<text x=\"").append(left - 4).append("\" y=\"").append(top + 4).append("\" text-anchor=\"end\" class=\"fd-cl\">")
                .append(esc(number(max) + (unit.isBlank() ? "" : " " + unit))).append("</text>");
        double slot = plotW / n;
        boolean lines = type.equals("line") || type.equals("area");
        for (int s = 0; s < values.size(); s++) {
            double[] v = values.get(s);
            String color = SERIES[s % SERIES.length];
            if (lines) {
                StringBuilder pts = new StringBuilder();
                for (int i = 0; i < v.length; i++) {
                    double x = left + slot * i + slot / 2;
                    double y = top + plotH - plotH * (v[i] / max);
                    pts.append(i == 0 ? "" : " ").append(fmt(x)).append(",").append(fmt(y));
                }
                if (type.equals("area") && v.length > 0) {
                    svg.append("<polygon points=\"").append(fmt(left + slot / 2)).append(",").append(h - bottom).append(" ").append(pts).append(" ")
                            .append(fmt(left + slot * (v.length - 1) + slot / 2)).append(",").append(h - bottom).append("\" fill=\"").append(color)
                            .append("\" fill-opacity=\"0.25\"/>");
                }
                svg.append("<polyline points=\"").append(pts).append("\" fill=\"none\" stroke=\"").append(color).append("\" stroke-width=\"2\"/>");
            } else {
                double bw = Math.max(2, slot * 0.7 / values.size());
                for (int i = 0; i < v.length; i++) {
                    double bh = plotH * (v[i] / max);
                    double x = left + slot * i + slot * 0.15 + bw * s;
                    svg.append("<rect x=\"").append(fmt(x)).append("\" y=\"").append(fmt(top + plotH - bh)).append("\" width=\"").append(fmt(bw))
                            .append("\" height=\"").append(fmt(bh)).append("\" rx=\"2\" fill=\"").append(color).append("\"><title>")
                            .append(esc((i < labels.size() ? labels.get(i) : String.valueOf(i + 1)) + ": " + number(v[i]) + (unit.isBlank() ? "" : " " + unit)))
                            .append("</title></rect>");
                }
            }
        }
        for (int i = 0; i < n; i++) {
            String label = i < labels.size() ? labels.get(i) : String.valueOf(i + 1);
            svg.append("<text x=\"").append(fmt(left + slot * i + slot / 2)).append("\" y=\"").append(h - bottom + 16)
                    .append("\" text-anchor=\"middle\" class=\"fd-cl\">").append(esc(label.length() > 14 ? label.substring(0, 13) + "…" : label)).append("</text>");
        }
        svg.append("</svg>");
        if (values.size() > 1) {
            svg.append("<div class=\"fd-legend\">");
            for (int s = 0; s < names.size(); s++) {
                svg.append("<span><i style=\"background:").append(SERIES[s % SERIES.length]).append("\"></i>").append(esc(names.get(s))).append("</span>");
            }
            svg.append("</div>");
        }
        return "<div class=\"fd-chartbox\">" + svg + "</div>";
    }

    private static double[] numbers(JsonNode node) {
        double[] out = new double[node.size()];
        for (int i = 0; i < node.size(); i++) {
            out[i] = node.get(i).isNumber() ? node.get(i).asDouble() : parse(node.get(i).asText());
        }
        return out;
    }

    private static double parse(String s) {
        try {
            return Double.parseDouble(s);
        } catch (NumberFormatException e) {
            return 0;
        }
    }

    private static String number(double v) {
        return v == Math.rint(v) ? String.valueOf((long) v) : String.format(Locale.ROOT, "%.1f", v);
    }

    private static String fmt(double v) {
        return String.format(Locale.ROOT, "%.1f", v);
    }

    static String esc(String s) {
        if (s == null) {
            return "";
        }
        StringBuilder out = new StringBuilder(s.length());
        for (char c : s.toCharArray()) {
            switch (c) {
                case '&' -> out.append("&amp;");
                case '<' -> out.append("&lt;");
                case '>' -> out.append("&gt;");
                case '"' -> out.append("&quot;");
                case '\'' -> out.append("&#39;");
                default -> out.append(c);
            }
        }
        return out.toString();
    }
}
