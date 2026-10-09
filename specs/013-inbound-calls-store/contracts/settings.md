# Contract: settings

Follows the existing rule: `.env` wins, `settings.properties` only fills a missing key (`${ENV:default}`), compose
passes env to the container, the native supervisor maps env to the backend.

| setting (env) | property | default | where | live? |
|---|---|---|---|---|
| `INTERNAL_CALLS_STORAGE` | `alfred.storage.internal-calls.type` | `sqlite` (`file` = today's store) | backend | restart |
| `INTERNAL_CALLS_DB_FILE` | (adapter `@Value`) | `/appdata/internal-calls.db`; native `<data>/internal-calls.db` | backend | restart |
| `INTERNAL_CALLS_MAX_SIZE_BYTES` | `alfred.storage.internal-calls.max-size-bytes` | `10737418240` | backend | restart |
| `INTERNAL_CALLS_RETENTION_ROWS` | `alfred.internal-calls.retention-rows` | `1500` (unchanged; this install 7000) | backend | live (as today) |
| `INTERNAL_CALLS_FILE` | (unchanged) | `/appdata/internal-calls.log` | backend | kept for the `file` store and the one-time migration |
| `WEBHOOK_TIMEOUT_SECONDS` | - | `15` (was 2) | both proxies | restart |
| `PREPARE_TIMEOUT_SECONDS` | - | `15` (was 2) | both proxies | restart |
| `PYTHONUNBUFFERED` | - | `1` | both proxy containers | restart |
| heap share | `backend/Dockerfile` `-XX:MaxRAMPercentage` | `75` (was 50) | Docker image | rebuild |
| `ALFRED_MEMORY` | native `-Xmx` | `2g` (unchanged; already above the 1.5 GB target) | native supervisor | restart |

New keys appear in the native install's `.env` / Server settings the same way every other backend setting does
(`ServerConfigCli`, `backend-server`), with a one-line explanation each.
