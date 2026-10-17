# Connector SPI changes (028)

`teamboards-spi` stays free of Spring. Capabilities are still the interfaces a connector implements.

## Removed
- `Connector.changedItems(...)` and `ItemIdsReader` (no cache to fill).

## New read capabilities
```java
interface ItemSearcher {           // live search
    ItemPage search(Connection c, Token t, ItemQuery q) throws ProviderException;
    boolean fullText(Connection c, Token t);   // false → WIQL fallback was used
}
interface ItemReader {             // full items, many at once (≤ 200)
    List<FullItem> items(Connection c, Token t, List<String> ids, Set<Part> parts) throws ProviderException;
}
interface TreeReader {             // ancestors, descendants (recursive), one hop of links, as references
    ItemTree tree(Connection c, Token t, String rootId, int maxRefs) throws ProviderException;
}
interface QueryRunner {            // raw query, read-only (Azure: WIQL SELECT)
    ItemPage query(Connection c, Token t, String query, int max) throws ProviderException;
}
interface IdentityReader {         // token owner and people by id
    Person whoAmI(Connection c, Token t) throws ProviderException;
    List<Person> people(Connection c, Token t, Collection<String> ids) throws ProviderException;
}
interface StateCatalog {           // types with states and their categories
    List<TypeStates> types(Connection c, Token t, String project) throws ProviderException;
}
```
Models: `ItemQuery` (text, types, states, openOnly, areas, teams, iterations, assigned, createdBy, changedWithin, tags, parent, mine set, sort, page, size), `ItemPage(total, fullText, rows)`, `ItemRef(id, type, title, state, category, assigned, iteration, area, changedAt, rev)`, `FullItem(ref, fields map, description, repro, acceptance, comments, relations, attachments, rev)`, `ItemTree(root, refs[relation, depth, parent, linkKind])`, `Part` (FIELDS, COMMENTS, HISTORY, RELATIONS, ATTACHMENTS).

## New write capabilities (lifting 027's read-only rule; every call comes from an approved bundle or the user's direct action)
```java
interface ItemWriter {
    void comment(Connection c, Token t, String id, String markdown) throws ProviderException;
    void moveState(Connection c, Token t, String id, String state) throws ProviderException;
    String create(Connection c, Token t, NewItem item) throws ProviderException;          // returns the new id
    void hyperlink(Connection c, Token t, String id, URI url, String label, boolean add) throws ProviderException;
    void tag(Connection c, Token t, String id, String tag, boolean add) throws ProviderException;
}
interface AttachmentWriter {
    void attach(Connection c, Token t, String id, String name, byte[] data) throws ProviderException;
}
interface HookReader {             // parse a provider's service-hook body into ids
    List<String> ids(String body);
}
```

## Azure mapping
| Capability | Azure REST 7.1 |
|---|---|
| search (full text) | `POST https://almsearch.dev.azure.com/{org}/{project}/_apis/search/workitemsearchresults` |
| search (fallback), query | `POST {project}/_apis/wit/wiql?timePrecision=true` + `workitemsbatch` |
| items | `POST _apis/wit/workitemsbatch` (`$expand=all`), comments `GET .../workItems/{id}/comments`, history `GET .../updates` |
| tree | WIQL `SELECT ... FROM WorkItemLinks WHERE [Source].[System.Id] = {root} AND [System.Links.LinkType] = 'System.LinkTypes.Hierarchy-Forward' MODE (Recursive)`; ancestors by walking `Hierarchy-Reverse` |
| whoAmI | `GET _apis/connectionData` |
| people | `GET https://vssps.dev.azure.com/{org}/_apis/identities?identityIds=` |
| types/states | `GET {project}/_apis/wit/workitemtypes` (states with category) |
| comment | `POST {project}/_apis/wit/workItems/{id}/comments?api-version=7.1-preview.4` |
| moveState, tag, hyperlink | `PATCH _apis/wit/workitems/{id}` JSON-Patch (`/fields/System.State`, `/fields/System.Tags`, `/relations/-` `Hyperlink`) |
| create | `POST {project}/_apis/wit/workitems/${type}` JSON-Patch |
| attach | `POST _apis/wit/attachments?fileName=` then PATCH relation `AttachedFile` |
| hook ids | `resource.workItemId` (updated) / `resource.id` (created) |
