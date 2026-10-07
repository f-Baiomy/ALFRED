"""
Where everything is in a native install, and the effective settings (specs/012-server-program data-model "Files on
disk"). Shared by supervisor.py, alfred.py and docker_import.py.

    <home>/
      alfred, alfred.cmd            launchers
      .env                          the user's settings (written only by ServerConfigCli / the backend)
      settings.properties           defaults, replaced on upgrade
      runtime/{java,python,node}    bundled runtimes
      app/                          alfred.jar, alfred-agent.jar, attach-cli.jar, mcp-server.mjs, proxy/, launcher/,
                                    log-agent/, alfred_settings.py, settings-env-map.json, VERSION
      data/                         everything recorded; never touched by an upgrade
"""

import json
import os
import platform
import re
import sys

WINDOWS = platform.system() == "Windows"
_PLACEHOLDER = re.compile(r"^\$\{([A-Za-z_][A-Za-z0-9_]*)(?::(.*))?\}$")


class Layout:
    """Paths of one install, derived from its home folder."""

    def __init__(self, home):
        self.home = os.path.abspath(home)
        self.app = os.path.join(self.home, "app")
        self.runtime = os.path.join(self.home, "runtime")
        self.data = os.path.join(self.home, "data")
        self.env_file = os.path.join(self.home, ".env")
        self.defaults_file = os.path.join(self.home, "settings.properties")
        self.appdata = os.path.join(self.data, "appdata")
        self.proxy_data = os.path.join(self.data, "proxy")
        self.interception = os.path.join(self.proxy_data, "interception")
        self.certs = os.path.join(self.data, "certs")
        self.exports = os.path.join(self.data, "exports")
        self.logs = os.path.join(self.data, "log")
        self.run = os.path.join(self.data, "run")
        self.control_file = os.path.join(self.run, "control.json")

    # -- runtimes ---------------------------------------------------------------------------------------------------

    @property
    def java(self):
        return os.path.join(self.runtime, "java", "bin", "java.exe" if WINDOWS else "java")

    @property
    def python(self):
        if WINDOWS:
            return os.path.join(self.runtime, "python", "python.exe")
        return os.path.join(self.runtime, "python", "bin", "python3")

    @property
    def node(self):
        return os.path.join(self.runtime, "node", "node.exe" if WINDOWS else os.path.join("bin", "node"))

    @property
    def jar(self):
        return os.path.join(self.app, "alfred.jar")

    def config_cli(self, *args):
        """The command line of ServerConfigCli, the Java settings engine (research R7). alfred.jar is a Spring Boot jar
        (classes under BOOT-INF/), so a plain -cp cannot see them: Spring Boot's PropertiesLauncher loads the jar's own
        classpath and then runs the given main class."""
        return [self.java, "-Dloader.main=com.fathy.alfred.backend.server.cli.ServerConfigCli", "-cp", self.jar,
                "org.springframework.boot.loader.launch.PropertiesLauncher", "--home", self.home, *args]

    def version(self):
        try:
            with open(os.path.join(self.app, "VERSION"), encoding="utf-8") as f:
                return f.read().strip()
        except OSError:
            return "unknown"

    def make_dirs(self):
        for folder in (self.data, self.appdata, self.proxy_data, self.interception, self.certs, self.exports,
                       self.logs, self.run, os.path.join(self.data, "logs-drop")):
            os.makedirs(folder, exist_ok=True)
        if not WINDOWS:
            os.chmod(self.data, 0o700)

    # -- settings ---------------------------------------------------------------------------------------------------

    def defaults(self):
        """ENV_NAME -> default, from settings.properties' ${ENV_NAME:default} placeholders (same rule as
        backend-server's SettingsPropertiesDefaultsAdapter)."""
        out = {}
        try:
            with open(self.defaults_file, encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line or line.startswith("#") or "=" not in line:
                        continue
                    match = _PLACEHOLDER.match(line.split("=", 1)[1].strip())
                    if match:
                        out[match.group(1)] = match.group(2) or ""
        except OSError:
            pass
        return out

    def settings(self):
        """The effective settings: .env over the defaults."""
        sys.path.insert(0, self.app)
        import alfred_settings  # noqa: E402 - lives in app/ in an install, at the repo root in a checkout
        effective = self.defaults()
        effective.update(alfred_settings.read_env_file(self.env_file))
        return effective

    def env_map(self):
        with open(os.path.join(self.app, "settings-env-map.json"), encoding="utf-8") as f:
            return json.load(f)["settings"]

    def ui_port(self, settings=None):
        return int((settings or self.settings()).get("ALFRED_UI_PORT") or 3000)

    def local_url(self, settings=None):
        return f"http://127.0.0.1:{self.ui_port(settings)}"


def home_from_here():
    """The install folder: ALFRED_HOME, else two levels up from app/launcher/."""
    if os.environ.get("ALFRED_HOME"):
        return os.environ["ALFRED_HOME"]
    return os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
