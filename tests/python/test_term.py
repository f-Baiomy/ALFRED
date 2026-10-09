"""packaging/launcher/term.py: plain output when not a terminal (no escape codes, one line per finished step), colour
and redraws in one, never colour alone, and glyphs the font can show."""

import io
import os
import sys
import unittest
from contextlib import redirect_stdout
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(ROOT, "packaging", "launcher"))

import alfred  # noqa: E402
import term  # noqa: E402


class FakeTty(io.StringIO):
    encoding = "utf-8"

    def isatty(self):
        return True


class TermDecisionTest(unittest.TestCase):

    def test_a_pipe_gets_no_colour_and_no_redraws(self):
        t = term.Term(io.StringIO(), env={})
        self.assertFalse(t.color)
        self.assertFalse(t.live)
        self.assertEqual(t.c("x", "red"), "x")

    def test_a_terminal_gets_colour_unless_no_color_or_dumb(self):
        self.assertTrue(term.Term(FakeTty(), env={"WT_SESSION": "1"}).color)
        self.assertFalse(term.Term(FakeTty(), env={"NO_COLOR": "1"}).color)
        self.assertFalse(term.Term(FakeTty(), env={"TERM": "dumb"}).color)

    def test_glyphs_follow_what_the_font_can_show(self):
        with mock.patch.object(term, "WINDOWS", True):
            self.assertFalse(term.Term(FakeTty(), env={}).unicode)  # classic console: ASCII
            self.assertTrue(term.Term(FakeTty(), env={"WT_SESSION": "x"}).unicode)  # Windows Terminal
            self.assertTrue(term.Term(FakeTty(), env={"TERM_PROGRAM": "vscode"}).unicode)
        with mock.patch.object(term, "WINDOWS", False):
            self.assertTrue(term.Term(FakeTty(), env={}).unicode)
            stream = FakeTty()
            stream.encoding = "cp1252"
            self.assertFalse(term.Term(stream, env={}).unicode)

    def test_visible_length_and_padding_ignore_escape_codes(self):
        t = term.Term(FakeTty(), env={"WT_SESSION": "1"})
        styled = t.c("abc", "red", "bold")
        self.assertEqual(term.visible_len(styled), 3)
        self.assertEqual(term.visible_len(term.pad(styled, 6)), 6)

    def test_a_state_is_never_told_by_colour_alone(self):
        t = term.Term(io.StringIO(), env={})
        for state in ("RUNNING", "STOPPED", "CRASHED", "RESTARTING"):
            self.assertIn(state.lower(), t.state(state))

    def test_bar_and_box(self):
        t = term.Term(io.StringIO(), env={})
        self.assertEqual(t.bar(0.5, 10), "[#####-----]")
        box = t.box("Title", ["one", "a longer row"])
        self.assertEqual(len({term.visible_len(line) for line in box}), 1)  # every edge lines up
        self.assertIn("Title", box[0])

    def test_durations(self):
        self.assertEqual(term.duration(0.43), "0.4 s")
        self.assertEqual(term.duration(12.2), "12 s")
        self.assertEqual(term.duration(138), "2 min 18 s")


class StepsTest(unittest.TestCase):

    def test_plain_prints_one_line_per_finished_step_and_nothing_for_waiting_ones(self):
        out = io.StringIO()
        t = term.Term(out, env={})
        with t.steps("Starting", label_width=8) as steps:
            a, b, c = steps.add("one"), steps.add("two"), steps.add("three")
            a.run("working").done("fine")
            b.fail("broke", ["try this"])
            c.run("never finishes")
        self.assertEqual(out.getvalue(), "Starting\n  ok   one      fine\n  FAIL two      broke\n         try this\n")

    def test_a_step_ends_once(self):
        out = io.StringIO()
        t = term.Term(out, env={})
        with t.steps() as steps:
            s = steps.add("x")
            s.done("first")
            s.fail("second")
        self.assertEqual(out.getvalue().count("x"), 1)
        self.assertEqual(s.state, "ok")

    def test_live_redraws_in_place_and_restores_the_cursor(self):
        out = FakeTty()
        t = term.Term(out, env={"WT_SESSION": "1"})
        with mock.patch.object(term.Steps, "FPS", 200):
            with t.steps("Live") as steps:
                s = steps.add("job").run("busy")
                import time
                time.sleep(0.05)
                s.done("ok")
        text = out.getvalue()
        self.assertIn("\x1b[?25l", text)
        self.assertTrue(text.endswith("\x1b[?25h"))
        self.assertIn("\x1b[2K", text)
        self.assertIn("✓", text)

    def test_a_live_frame_never_wraps_but_the_final_one_is_whole(self):
        long = "x" * 300
        out = FakeTty()
        t = term.Term(out, env={"WT_SESSION": "1"})
        with mock.patch.object(t, "width", return_value=40), mock.patch.object(term.Steps, "FPS", 200):
            with t.steps() as steps:
                s = steps.add("job").run(long)
                import time
                time.sleep(0.05)
                s.done(long)
        frames = out.getvalue().split("\x1b[2K")
        self.assertTrue(any("…" in f for f in frames))
        self.assertIn(long, frames[-1])


class AlfredOutputTest(unittest.TestCase):

    def run_main(self, argv):
        out = io.StringIO()
        with redirect_stdout(out):
            code = alfred.main(argv)
        return code, out.getvalue()

    def test_a_typo_suggests_the_closest_command_instead_of_the_whole_help(self):
        code, out = self.run_main(["stauts"])
        self.assertEqual(code, alfred.USAGE)
        self.assertIn("Did you mean status?", out)
        self.assertIn("alfred status", out)
        self.assertNotIn("Connect Java apps", out)

    def test_help_groups_the_commands_and_keeps_the_exit_codes_one_flag_away(self):
        code, out = self.run_main(["help"])
        self.assertEqual(code, alfred.OK)
        for group in ("Run Alfred", "Connect Java apps", "Settings", "Look after it"):
            self.assertIn(group, out)
        for name in ("start", "stop", "restart", "status", "logs", "jvms", "attach", "detach", "config", "project", "update", "uninstall"):
            self.assertIn(name, out)
        code, out = self.run_main(["help", "--codes"])
        self.assertEqual((code, out.strip()), (alfred.OK, alfred.EXIT_CODES))

    def test_log_lines_keep_every_character_and_only_gain_colour(self):
        t = term.Term(FakeTty(), env={"WT_SESSION": "1"})
        line = "2026-10-12 12:41:10.240 ERROR 5528 --- [ingest-2] c.f.Ingest : batch rejected"
        colored = alfred.color_log_line(t, line)
        self.assertEqual(term.ANSI.sub("", colored), line)
        self.assertIn("\x1b[31;1mERROR", colored)
        self.assertEqual(alfred.color_log_line(term.Term(io.StringIO(), env={}), line), line)


if __name__ == "__main__":
    unittest.main()
