#!/bin/bash
#
# db-capture-off.sh <project> - switches database capture off for <project> (the ◆ switch in Live Calls).
# The agent stays loaded but records nothing for that project; a WildFly restart removes it completely
# (the Attach API cannot unload an agent).

set -eo pipefail

PROJECT="${1:?usage: db-capture-off.sh <project>}"
ALFRED_URL="${ALFRED_URL:-http://localhost:3000}"
curl -fsS -X PUT -H 'Content-Type: application/json' -d '{"enabled":false}' \
    "$ALFRED_URL/db-capture/projects/$PROJECT/enabled" >/dev/null
echo "Database capture OFF for $PROJECT."
