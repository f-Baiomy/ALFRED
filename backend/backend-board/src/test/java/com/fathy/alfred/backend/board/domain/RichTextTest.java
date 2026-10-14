package com.fathy.alfred.backend.board.domain;

import com.fathy.alfred.backend.board.domain.model.MentionRef;
import com.fathy.alfred.backend.board.domain.model.MentionType;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

/** Rich text: HTML cleaned to the board's tags on save, Markdown untouched, mentions and words read through it. */
class RichTextTest {

    @Test
    void markdownIsLeftExactlyAsWritten() {
        String md = "**Did** read <b>it</b>\n\n- a\n- b <script>x</script>";
        assertThat(RichText.isHtml(md)).isFalse();
        assertThat(RichText.clean(md)).isEqualTo(md);
        assertThat(RichText.plain(md)).isEqualTo(md);
    }

    @Test
    void htmlKeepsTheBoardsTagsAndDropsEverythingElse() {
        String dirty = "<p onclick=\"steal()\" class=\"x\" style=\"color:red\">Hi <b>there</b> <mark>now</mark> <span data-color=\"red\">red</span>"
                + " <span data-color=\"javascript\">bad</span><script>alert(1)</script></p>"
                + "<aside data-callout=\"bug\"><b>Wrong</b> fare</aside><aside data-callout=\"evil\">x</aside>"
                + "<iframe src=\"https://evil\"></iframe><a href=\"javascript:alert(1)\">js</a><a href=\"https://ok.example\">ok</a>"
                + "<img src=\"https://evil/pixel.png\"><img src=\"/board/images/0f1e2d3c-aaaa-bbbb\" alt=\"shot\">"
                + "<ul data-checklist=\"\"><li data-checked=\"true\">done</li><li data-checked=\"maybe\">open</li></ul>"
                + "<p dir=\"rtl\">عربي</p><p dir=\"sideways\">x</p>";

        String clean = RichText.clean(dirty);

        assertThat(clean).doesNotContain("onclick", "class=", "style=", "script", "alert(1)<", "iframe", "javascript", "https://evil", "evil\"");
        assertThat(clean).contains("<b>there</b>", "<mark>now</mark>", "<span data-color=\"red\">red</span>", "<aside data-callout=\"bug\">",
                "<a href=\"https://ok.example\">ok</a>", "<img src=\"/board/images/0f1e2d3c-aaaa-bbbb\" alt=\"shot\">",
                "<li data-checked=\"true\">done</li>", "<li data-checked=\"false\">open</li>", "<p dir=\"rtl\">عربي</p>");
        assertThat(clean).doesNotContain("dir=\"sideways\"");
        assertThat(RichText.isHtml(clean)).isTrue();
    }

    @Test
    void mentionsInsideHtmlAreReadWithTheirLabelsAsWritten() {
        String html = "<p>See @[call:in:abc|GET /a?x=1&amp;y=&lt;2&gt;] and <b>@[card:12|#12 fare]</b></p>";

        List<MentionRef> refs = MentionParser.mentions(RichText.clean(html));

        assertThat(refs).containsExactly(new MentionRef(MentionType.CALL, "in:abc", "GET /a?x=1&y=<2>"), new MentionRef(MentionType.CARD, "12", "#12 fare"));
    }

    @Test
    void plainWordsKeepALineBreakPerBlock() {
        assertThat(RichText.plain("<h2>Title</h2><p>one <b>two</b></p><ul><li>a</li><li>b</li></ul>")).isEqualTo("Title\none two\na\nb");
    }

    @Test
    void anHtmlSpecStillGivesItsAcceptanceItems() {
        String spec = "<h2>Acceptance</h2><ul data-checklist=\"\"><li data-checked=\"false\">Fare stays the same</li><li>No extra SQL</li></ul>"
                + "<h2>Notes</h2><p>x</p>";

        assertThat(AcceptanceItems.of(spec)).extracting(AcceptanceItems.Item::text).containsExactly("[ ] Fare stays the same", "No extra SQL");
    }

    @Test
    void picturesAreFoundInBothForms() {
        assertThat(RichText.imageIds("<p><img src=\"/board/images/aaaaaaaa-1\"></p> ![x](/board/images/bbbbbbbb-2)"))
                .containsExactly("aaaaaaaa-1", "bbbbbbbb-2");
    }
}
