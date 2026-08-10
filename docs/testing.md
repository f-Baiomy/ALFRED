# Testing

No test suite/linter for `proxy` beyond the Docker build itself.

## Backend (`mvn test` at the `backend/` aggregator)

- **Application services** unit-tested against fake/mocked ports (`CallsServiceTest`, `CommentsServiceTest`, `ExportMetadataServiceTest`) — no Spring context, no filesystem; this is exactly what the ports interface is for.
- **File adapters** get focused tests against a real `@TempDir` rather than mocks (`FileCallLogAdapterTest`, `JsonFileCommentsStoreAdapterTest`), since their whole job is file I/O — including cache-invalidation-on-external-edit behavior.
- **Controllers** get thin `@WebMvcTest` coverage for HTTP-level concerns only (status codes, validation), use cases mocked (`CommentsControllerTest`). A slice needing `@WebMvcTest` needs its own tiny test-only `@SpringBootApplication` class (see `backend-comments`' `TestApplication`) — bare `@SpringBootConfiguration` does not imply component scanning.
- **`backend-architecture-test`'s `HexagonalArchitectureTest` (ArchUnit)** enforces what Maven module boundaries can't: intra-slice dependency direction (domain → application → adapter, never reversed), domain purity (no `org.springframework`; Jackson explicitly allowed), inbound adapters never reaching past ports into services or outbound adapters, and every slice-isolation rule (`calls`/`comments` mutually isolated and isolated from `export`/`session-cycles`/`profiles`; `session-cycles` isolated from `comments`/`export`/`profiles`; `profiles` isolated from everything). A violation fails `mvn test` outright — verified live by temporarily annotating a domain record with `@Component` and observing exactly one precise rule failure.
- `mvn package` (full build) produces the Spring Boot jar Docker packages; `docker compose up -d --build backend` builds with `-DskipTests` — tests run separately from the image build by convention.

## Frontend (`npm test` = `ng test`, Karma/Jasmine, watches by default)

- Pure functions (`call-utils.ts`'s merge/prune/memoized derivations, `markdown-builder.ts`, `bulk-json-builder.ts`, `curl-builder.ts`, `popover-position.ts`) are unit-tested directly rather than through the services that call them, since exercising a real `WebSocket` (or DOM layout for popover positioning) in Karma is unreliable.
- Export builders (`markdown-builder.spec.ts`, `bulk-json-builder.spec.ts`, `curl-builder.spec.ts`, `html-builder.spec.ts`) specifically assert against large generated bodies to guard the no-truncation requirement (see docs/architecture.md) — don't weaken these into small fixtures when refactoring.
- `npm run build` (`ng build`) is the production build; output in `dist/frontend/browser`.
