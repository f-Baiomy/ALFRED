# native.sh - sourced by the scripts in this folder. On a machine where Alfred is installed as a program
# (specs/012-server-program), they hand over to "alfred attach/detach": the bundled JDK does the attach (no JDK 8 or
# tools.jar needed), with the same agent and the settings from Alfred's .env. Elsewhere (the Docker install, a dev
# checkout) native_alfred is false and the scripts work as they always did.

ALFRED_HOME="${ALFRED_HOME:-/opt/alfred}"

native_alfred() {
    [ -x "$ALFRED_HOME/alfred" ] && [ -f "$ALFRED_HOME/app/attach-cli.jar" ]
}

# native_run attach|detach [FLAGS...] - on the one running WildFly, or on WILDFLY_PID.
native_run() {
    action="$1"
    shift
    pid="$WILDFLY_PID"
    if [ -z "$pid" ]; then
        pid="$("$ALFRED_HOME/alfred" jvms | awk '$2 == "WildFly" {print $1}')"
        count="$(printf '%s\n' "$pid" | grep -c .)" || true
        if [ "$count" = "0" ]; then
            echo "No running WildFly found. 'alfred jvms' lists every Java app; 'alfred $action PID' works on any of them."
            return 1
        fi
        if [ "$count" != "1" ]; then
            echo "More than one WildFly is running - set WILDFLY_PID to pick one:"
            "$ALFRED_HOME/alfred" jvms
            return 1
        fi
    fi
    "$ALFRED_HOME/alfred" "$action" "$pid" "$@"
}
