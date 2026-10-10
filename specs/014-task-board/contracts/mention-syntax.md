# Mention syntax (014)

Inline in any Markdown text (card description, comment, cycle brief, checklist evidence):

```
@[<type>:<ref>|<label>]
```

- `type`: lower-case `MentionType`.
- `ref`: no `|` or `]`; `\|` and `\]` escape them inside `label` only.
- `label`: one-line summary shown when the item cannot be resolved (≤ 200 chars).
- Anything not matching the grammar is plain text. A lone `@` is plain text.

| Type | `ref` form | Example |
|------|-----------|---------|
| `call` | `in:<callId>` / `out:<callId>`, optional `@<cycleId>` for a captured cycle call | `@[call:in:5f2c9e@c-81|POST /api/orders · 201]` |
| `stmt` | `<callId>/<seq>` | `@[stmt:5f2c9e/88|INSERT ORDERS #88]` |
| `log` | `<callId>/<lineId>` | `@[log:5f2c9e/L1203|WARN DiscountMapper]` |
| `redis` | `<callId>/<seq>` | `@[redis:5f2c9e/12|GET cart:9921]` |
| `spec` | `<cycleId>/<fileName>` optional `#<section-slug>` | `@[spec:c-81/ODY-482-spec.md#acceptance|ODY-482-spec.md §Acceptance]` |
| `code` | `<path>:<line>` | `@[code:src/main/java/OrderMapper.java:142|OrderMapper.java:142]` |
| `cycle` | `<cycleId>` | `@[cycle:c-81|order-flow-3]` |
| `spacer` | `<cycleId>/<spacerId>` | `@[spacer:c-81/s-3|apply code]` |
| `card` | `<project>#<number>` (project may be empty) | `@[card:odeysys#7|Discount not saved]` |
| `rule` | `<ruleId>` | `@[rule:r-12|pricing-mock]` |

Section slug: heading text lower-cased, non-alphanumerics → `-`, trimmed.

Parsers: `frontend/src/app/shared/utils/mention-syntax.ts` and `backend-board` `MentionParser` - both run `specs/014-task-board/vectors/mentions.json` (input text → expected mentions and plain-text segments), so they cannot drift.
