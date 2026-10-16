# Contract: connector SPI (`teamboards-spi`)

The SPI is a pure Java module (no Spring). A connector module depends on it and on nothing else in Alfred. It registers itself as a Spring `@Component`, and core receives `List<Connector>`.

```java
public interface Connector {
    String kind();                                   // "azure"
    String displayName();                            // "Azure DevOps"
    ProviderWords words();                           // e.g. sprint → "Iteration", squad → "Team", area → "Area Path"
    /** Items of the scope changed after {@code since} (null = full first fetch), streamed page by page. */
    void changedItems(Connection c, Token t, Instant since, Consumer<List<Item>> page) throws ProviderException;
    Item item(Connection c, Token t, String extId) throws ProviderException;
    List<ItemTypeInfo> types(Connection c, Token t) throws ProviderException;   // custom types included
    List<Person> people(Connection c, Token t) throws ProviderException;
}

public interface BoardsReader      { List<ProviderBoard> boards(Connection c, Token t) throws ProviderException; }
public interface SprintsReader     { List<Sprint> sprints(Connection c, Token t) throws ProviderException; }
public interface SquadsReader      { List<Squad> squads(Connection c, Token t) throws ProviderException; }
public interface RevisionsReader   { List<Revision> revisions(Connection c, Token t, String extId) throws ProviderException; }
public interface AttachmentsReader { List<Attachment> attachments(Connection c, Token t, String extId) throws ProviderException; }
/** Optional: extra seed parts beyond the neutral fields (e.g. Azure's Repro Steps HTML → steps). */
public interface SeedContributor   { SeedPart seed(Item item); }

public final class ProviderException extends Exception {
    public enum Kind { TOKEN_REJECTED, NOT_FOUND, BUSY, UNREACHABLE, BAD_RESPONSE }
    // carries kind + retryAfter; message never contains the token or a body
}
```

Rules:

- Core derives capabilities from `instanceof`, so a connector cannot claim one it does not implement.
- `Token` is passed per call and never kept in a field. `Token.toString()` is masked.
- Connectors return provider data converted to SPI records and keep the raw item in `Item.nativeJson`. Core stores it and lists never read it.
- Paging, throttling (`Retry-After`) and timeouts (connect 5 s, request 30 s) are the connector's job. A page callback lets core write as it goes, so a first fetch of 20,000 items never sits in memory at once.
- Adding a provider = new module `teamboards-<kind>` + one dependency in `backend-app` + a frontend folder `components/team/connectors/<kind>/`. Nothing else changes (SC-008).

Frontend counterpart (`core/team/connector-ui.ts`):

```ts
export interface ConnectorUi {
  kind: string;                         // matches Connector.kind()
  label: string; icon: string;
  settingsComponent: Type<unknown>;     // connection form fields beyond base URL
  fieldRenderer?: Type<unknown>;        // e.g. Azure HTML fields
  word(neutral: 'sprint' | 'squad' | 'area' | 'item'): string;
}
export const TEAM_CONNECTORS = new InjectionToken<ConnectorUi[]>('TEAM_CONNECTORS');  // multi provider
```
