# SPIKE S1: bundled Python running mitmdump and Alfred's addons

**Date**: 2026-10-07. **Result**: PASS on Linux and Windows.

## Setup

- Interpreter: python-build-standalone `cpython-3.13.16+20261003` "install_only", for
  `x86_64-unknown-linux-gnu` and `x86_64-pc-windows-msvc`.
- mitmproxy `12.2.3`, the version in the `mitmproxy/mitmproxy:latest` image that Docker runs today.
  That image uses Python 3.14; 12.2.3 supports 3.12+.
- Packages are installed into the interpreter's own `site-packages`:
  - Linux: `pip install --target`.
  - Windows (cross-install, run from a Linux container):
    `uv pip install --target <site> --python-platform x86_64-pc-windows-msvc --python-version 3.13 --only-binary :all: mitmproxy==12.2.3`.
  - **Plain `pip download --platform win_amd64` fails**. It evaluates environment markers for the
    host OS, so `mitmproxy-rs` asks for `mitmproxy-linux` and resolution fails. Use `uv` for every
    cross-platform install; `build-versions.json` pins it at `0.12.23`.

## Results

| Check | Linux (python:3.13-slim container, glibc) | Windows 10 (this machine) |
|---|---|---|
| `proxy/test_regex_worker.py` + `proxy/test_interception.py` | 331 passed (when run from a container-local copy) | 331 passed, 51 subtests |
| `mitmdump -s log_and_route.py --mode regular@127.0.0.2:8443` | HTTP through proxy 200; HTTPS with the generated CA 200 | HTTP through proxy 200; CA created under `confdir` |
| Regex worker (`multiprocessing`, spawn on Windows) | works | works |
| Webhook failure when no backend runs | logged, call proxied anyway (expected) | same |

The launch command that works (no console-script shims needed after `--target`):
`python -c "from mitmproxy.tools.main import mitmdump; mitmdump()" -s <addon> --mode ... --set confdir=...`

## Notes for the build

- Running the two timing tests (`test_the_event_loop_keeps_running_while_a_match_is_slow`,
  `test_many_delayed_flows_overlap_rather_than_queue`) with the interpreter on a Windows bind mount
  inside Docker made them fail (1.8 s against a 1.0 s budget). This is filesystem latency, not
  behavior: from a container-local copy they pass. Build-time tests must not run from a bind mount.
- Installed size: Windows `site-packages` 56 MB. Linux runtime folder 380 MB with pytest and the full
  stdlib test suite. `build_dist.py` drops `test/`, `idlelib/`, `tkinter/`, `ensurepip/` and
  `__pycache__` to cut that.
- Windows Server was not available; Windows 10 22H2 stands in. Both use the same interpreter and the
  same mitmproxy wheels.
- This machine's router DNS does not answer, so every download ran inside Docker with
  `--dns 8.8.8.8`. `build_dist.py` therefore does its downloads inside the build container, with an
  optional `--dns` flag.
