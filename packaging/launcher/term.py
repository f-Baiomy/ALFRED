"""
term.py - colour, symbols and live step lists for the "alfred" command. Standard library only.

    t = Term()                      # decides once: colour? redraws? Unicode glyphs?
    print(t.ok("done"), t.c("text", "dim"))
    with t.steps("Starting Alfred 3.0.5") as steps:
        s = steps.add("backend")    # a waiting row
        s.run("starting")           # a spinner and a live detail
        s.done(":3000 · 11.2 s")    # ✓ - or s.fail(reason, hints) / s.warn(reason, hints)

Three rules, so the output reads the same everywhere:
  - Plain when it is not a terminal (the installers capture `alfred _wait-health`, CI logs, `| tee`), when NO_COLOR is set
    or TERM=dumb: no escape codes, no redraws, one line per finished step - the same words.
  - A state is never told by colour alone: every row has a symbol AND a word.
  - Unicode glyphs only where the font has them: Windows Terminal, VS Code, and UTF-8 terminals elsewhere. The classic
    Windows console (conhost + Consolas) has no braille spinner and few symbols - it gets an ASCII set.
"""

import os
import re
import shutil
import sys
import threading
import time

WINDOWS = os.name == "nt"

CODES = {"bold": "1", "dim": "2", "underline": "4", "red": "31", "green": "32", "yellow": "33", "blue": "34",
         "teal": "36", "white": "97", "gray": "90"}
ANSI = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07")

UNICODE_GLYPHS = {"ok": "✓", "fail": "✗", "warn": "!", "wait": "○", "run": "●", "part": "◐", "brand": "◆", "pause": "‖",
                  "arrow": "→", "dot": "·", "bar_full": "━", "bar_empty": "─", "spinner": "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏",
                  "box": ("╭", "╮", "╰", "╯", "─", "│"), "up": "↑", "retry": "↻"}
ASCII_GLYPHS = {"ok": "+", "fail": "x", "warn": "!", "wait": "o", "run": "*", "part": "~", "brand": "<>", "pause": "||",
                "arrow": "->", "dot": "·", "bar_full": "#", "bar_empty": "-", "spinner": "|/-\\",
                "box": ("+", "+", "+", "+", "-", "|"), "up": "^", "retry": "~"}
# The words a plain (no-terminal) line starts with, in place of a symbol.
PLAIN_MARKS = {"ok": "ok  ", "fail": "FAIL", "warn": "WARN", "wait": "....", "run": "... "}


def visible_len(text):
    return len(ANSI.sub("", text))


def pad(text, width):
    """Pads to a visible width - escape codes take no columns."""
    return text + " " * max(0, width - visible_len(text))


def _enable_windows_vt(stream):
    """Turns on escape-code processing in a Windows console (Windows 10+). False where it cannot."""
    try:
        import ctypes
        import msvcrt
        kernel32 = ctypes.windll.kernel32
        handle = msvcrt.get_osfhandle(stream.fileno())
        mode = ctypes.c_uint32()
        if not kernel32.GetConsoleMode(handle, ctypes.byref(mode)):
            return False
        return bool(kernel32.SetConsoleMode(handle, mode.value | 0x0004)) or bool(mode.value & 0x0004)
    except (AttributeError, OSError, ValueError, ImportError):
        return False


class Term:

    def __init__(self, stream=None, env=None):
        self.stream = stream or sys.stdout
        env = os.environ if env is None else env
        try:
            tty = self.stream.isatty()
        except (AttributeError, ValueError):
            tty = False
        self.color = tty and not env.get("NO_COLOR") and env.get("TERM") != "dumb"
        if self.color and WINDOWS and stream is None:
            self.color = _enable_windows_vt(self.stream)
        self.live = self.color  # redraws need the same escape codes colour does
        encoding = (getattr(self.stream, "encoding", "") or "").lower().replace("-", "")
        if not encoding.startswith("utf8"):
            self.unicode = False
        elif WINDOWS:
            self.unicode = bool(env.get("WT_SESSION") or env.get("TERM_PROGRAM") or env.get("ConEmuANSI") == "ON")
        else:
            self.unicode = True
        self.g = UNICODE_GLYPHS if self.unicode else ASCII_GLYPHS

    # -- text --------------------------------------------------------------------------------------------------------

    def c(self, text, *styles):
        if not self.color or not styles:
            return text
        return "\x1b[" + ";".join(CODES[s] for s in styles) + "m" + text + "\x1b[0m"

    def ok(self, text=""):
        return self.c(self.g["ok"], "green") + (" " + text if text else "")

    def fail(self, text=""):
        return self.c(self.g["fail"], "red", "bold") + (" " + text if text else "")

    def warn(self, text=""):
        return self.c(self.g["warn"], "yellow", "bold") + (" " + text if text else "")

    def brand(self, title, rest=""):
        return self.c(self.g["brand"], "teal", "bold") + " " + self.c(title, "white", "bold") + (self.c("  " + rest, "dim") if rest else "")

    def url(self, text):
        return self.c(text, "teal", "underline")

    def cmd(self, text):
        return self.c(text, "white")

    def state(self, state):
        """A process state as dot + word: running / stopped / crashed / restarting / starting."""
        word = state.lower()
        if state == "RUNNING":
            return self.c(self.g["run"], "green") + " " + self.c(word, "green")
        if state in ("RESTARTING", "STARTING"):
            return self.c(self.g["part"], "yellow") + " " + self.c(word, "yellow")
        if state == "CRASHED":
            return self.c(self.g["fail"], "red", "bold") + " " + self.c(word, "red")
        return self.c(self.g["wait"], "dim") + " " + self.c(word, "dim")

    def bar(self, fraction, width=24):
        filled = round(max(0.0, min(1.0, fraction)) * width)
        if self.unicode:
            return self.c(self.g["bar_full"] * filled, "teal") + self.c(self.g["bar_empty"] * (width - filled), "dim")
        return "[" + self.c("#" * filled, "teal") + self.c("-" * (width - filled), "dim") + "]"

    def box(self, title, rows, color="teal"):
        """Lines of a box: a title on the top edge, `rows` (already styled text) inside."""
        tl, tr, bl, br, h, v = self.g["box"]
        width = max([visible_len(title) + 4] + [visible_len(r) for r in rows]) + 4
        lines = ["  " + self.c(tl + h + " ", color) + self.c(title, "white", "bold") + self.c(" " + h * (width - visible_len(title) - 3) + tr, color)]
        lines += ["  " + self.c(v, color) + "  " + pad(r, width - 2) + self.c(v, color) for r in rows]
        lines.append("  " + self.c(bl + h * width + br, color))
        return lines

    def width(self):
        return shutil.get_terminal_size((100, 24)).columns

    def print(self, text=""):
        self.stream.write(text + "\n")
        self.stream.flush()

    def steps(self, title=None, label_width=12):
        return Steps(self, title, label_width)


class Step:

    def __init__(self, steps, label):
        self.steps, self.label = steps, label
        self.state, self.text, self.hints = "wait", "", []
        self.started = None

    def run(self, text=""):
        with self.steps.lock:
            self.state, self.text = "run", text
            if self.started is None:
                self.started = time.monotonic()
        self.steps.changed()
        return self

    def detail(self, text):
        with self.steps.lock:
            self.text = text
        self.steps.changed()
        return self

    def elapsed(self):
        return 0.0 if self.started is None else time.monotonic() - self.started

    def done(self, text=""):
        return self._end("ok", text, [])

    def fail(self, text="", hints=()):
        return self._end("fail", text, list(hints))

    def warn(self, text="", hints=()):
        return self._end("warn", text, list(hints))

    def _end(self, state, text, hints):
        with self.steps.lock:
            if self.state in ("ok", "fail", "warn"):
                return self
            self.state, self.text, self.hints = state, text, hints
        self.steps.finished(self)
        return self


class Steps:
    """A list of rows that tick off. Live: redrawn in place with a spinner, ~12 times a second. Plain: a row is printed
    once, when it finishes (a waiting or running row prints nothing)."""

    FPS = 12

    def __init__(self, term, title, label_width):
        self.term, self.title, self.label_width = term, title, label_width
        self.rows = []
        self.lock = threading.RLock()
        self.drawn = 0  # how many lines the last live frame took
        self.frame = 0
        self.stop = threading.Event()
        self.thread = None

    def __enter__(self):
        if self.title:
            if self.term.live:
                self.term.print()
                self.term.print("  " + self.term.brand(self.title))
                self.term.print()
            else:
                self.term.print(self.title)
        if self.term.live:
            self.term.stream.write("\x1b[?25l")  # no blinking cursor under the spinner
            self.thread = threading.Thread(target=self._animate, name="steps", daemon=True)
            self.thread.start()
        return self

    def __exit__(self, kind, value, tb):
        self.stop.set()
        if self.thread:
            self.thread.join(1)
            with self.lock:
                self._draw(final=True)
            self.term.stream.write("\x1b[?25h")
            self.term.stream.flush()
        return False

    def add(self, label):
        step = Step(self, label)
        with self.lock:
            self.rows.append(step)
        self.changed()
        return step

    def changed(self):
        pass  # the animation thread picks it up within one frame

    def finished(self, step):
        if not self.term.live:
            for line in self._lines(step, plain=True):
                self.term.print(line)

    # -- drawing -----------------------------------------------------------------------------------------------------

    def _animate(self):
        while not self.stop.wait(1 / self.FPS):
            with self.lock:
                self.frame += 1
                self._draw(final=False)

    def _lines(self, step, plain=False):
        t = self.term
        label = step.label.ljust(self.label_width)
        if plain:
            if step.state == "wait":
                return []
            return [f"  {PLAIN_MARKS[step.state]} {label} {step.text}".rstrip()] + [f"         {h}" for h in step.hints]
        if step.state == "wait":
            return ["  " + t.c(t.g["wait"] + " " + step.label, "dim")]
        if step.state == "run":
            spin = t.g["spinner"][self.frame % len(t.g["spinner"])]
            return ["  " + t.c(spin, "teal") + " " + t.c(label, "white", "bold") + " " + t.c(step.text, "dim")]
        mark = {"ok": t.c(t.g["ok"], "green"), "fail": t.c(t.g["fail"], "red", "bold"), "warn": t.c(t.g["warn"], "yellow", "bold")}[step.state]
        text = {"ok": t.c(step.text, "dim"), "fail": t.c(step.text, "red"), "warn": t.c(step.text, "yellow")}[step.state]
        name = label if step.state == "ok" else t.c(label, "white", "bold")
        return ["  " + mark + " " + name + " " + text] + ["      " + h for h in step.hints]

    def _draw(self, final):
        t = self.term
        lines = [line for step in self.rows for line in self._lines(step)]
        out = []
        if self.drawn:
            out.append(f"\x1b[{self.drawn}F")  # back to the first line of the last frame
        if final:
            out.append("\x1b[J")  # the final frame may wrap: clear what the last one left below, so nothing shows through
        width = t.width() - 1
        for line in lines:
            # A live frame never wraps (a wrapped line would break the next cursor-up); the final one is printed whole.
            shown = line if final or visible_len(line) <= width else _clip(line, width)
            out.append("\x1b[2K" + shown + "\n")
        t.stream.write("".join(out))
        t.stream.flush()
        self.drawn = 0 if final else len(lines)


def _clip(line, width):
    """Cuts a styled line to `width` visible columns, keeping escape codes intact."""
    out, seen, i = [], 0, 0
    while i < len(line) and seen < width - 1:
        m = ANSI.match(line, i)
        if m:
            out.append(m.group(0))
            i = m.end()
            continue
        out.append(line[i])
        seen += 1
        i += 1
    return "".join(out) + "…\x1b[0m"


def duration(seconds):
    """"0.4 s" / "12 s" / "2 min 18 s"."""
    if seconds < 10:
        return f"{seconds:.1f} s"
    if seconds < 60:
        return f"{seconds:.0f} s"
    return f"{int(seconds // 60)} min {int(seconds % 60)} s"
