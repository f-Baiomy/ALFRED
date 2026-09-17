import { CallOverlapCandidate, CallRecord } from '../../core/models/call.model';
import { ExportFormData } from '../../core/models/export-metadata.model';
import { Comment, CommentBlock, COMMENT_BLOCK_LABELS } from '../../core/models/comment.model';
import { detectAndFormatBody } from './body-format';
import { CallStatusFilter, callKey, isInProgress, supplierOf, uriPath } from './call-utils';
import { buildExportNarrative, depthByCallId, depthSentence, ExportNarrative } from './export-narrative';
import { buildWaterfallBands, waterfallAsciiLines } from './waterfall';

function metadataValue(value: string): string {
  return value && value.trim().length > 0 ? value : '_(none provided)_';
}

/** A small table reads better than a long bullet list for a fixed set of fields, and keeps every export's metadata visually distinct from the per-call content around it. */
function metadataTable(form: ExportFormData): string[] {
  return [
    '| Field | Value |',
    '|---|---|',
    `| Supplier Name | ${metadataValue(form.supplierName)} |`,
    `| Supplier Credentials Used | ${metadataValue(form.credentialsUsed)} |`,
    `| Environment | ${metadataValue(form.environment)} |`,
    `| URL | ${metadataValue(form.url)} |`,
    `| API Key | ${metadataValue(form.apiKey)} |`,
    `| Description | ${metadataValue(form.description)} |`,
  ];
}

/** Thousands separators for readability on large payloads' durations; only shows decimals when the value actually has a fractional part, so integer durations don't grow a fake ".00". */
function formatMs(ms: number): string {
  const hasFraction = Math.abs(ms % 1) > 1e-9;
  return `${ms.toLocaleString('en-US', { minimumFractionDigits: hasFraction ? 2 : 0, maximumFractionDigits: 2 })} ms`;
}

function commentsForBlock(comments: readonly Comment[], block: CommentBlock): Comment[] {
  return comments.filter((c) => c.block === block).sort((a, b) => a.lineIndex - b.lineIndex);
}

/**
 * The "About This Document" section - see export-narrative.ts for why it exists and what it says.
 * This file only decides how to draw it: the topology goes in a plain fence rather than a Mermaid
 * diagram so it survives being pasted anywhere, and each slot is skipped entirely when the narrative
 * has nothing for it rather than rendering an empty heading.
 */
function aboutSectionMarkdown(narrative: ExportNarrative): string[] {
  const lines: string[] = ['## 📖 About This Document', ''];

  lines.push(`**What this is.** ${narrative.description}`, '');

  const depth = depthSentence(narrative);
  if (narrative.treeLines.length > 0 || narrative.flowSummary || depth) {
    lines.push(`**Who called whom.** ${depth ?? ''}`.trimEnd(), '');
    if (narrative.treeLines.length > 0) {
      lines.push('```', ...narrative.treeLines, '```', '');
    }
    if (narrative.flowSummary) {
      lines.push(narrative.flowSummary, '');
    }
  }

  // Only when something actually nests - see buildWaterfallRows. Placed straight after the tree
  // because it answers the question the tree raises: the tree says call 2 caused calls 3 and 4, and
  // this says whether they ran together or one after the other.
  const bands = buildWaterfallBands(narrative);
  if (bands) {
    lines.push(
      "**When each call ran.** One band per call that caused others, each scaled to that call's own window - so bars within a band can be compared to each other, but not across bands. Durations are absolute.",
      ''
    );
    lines.push('```', ...waterfallAsciiLines(bands), '```', '');
  }

  if (narrative.caveats.length > 0) {
    lines.push('**⚠️ Caveats for this capture.**', '');
    for (const caveat of narrative.caveats) lines.push(`- ${caveat}`);
    lines.push('');
  }

  if (narrative.timingRows.length > 0) {
    lines.push('**Where the time went.**', '');
    lines.push('| # | Call | Total | Waiting on downstream | Own work |', '|---|---|---|---|---|');
    for (const row of narrative.timingRows) {
      const downstream = row.downstreamMs != null ? formatMs(row.downstreamMs) : '— _(leaf)_';
      const own = row.selfMs != null ? `**${formatMs(row.selfMs)}**` : formatMs(row.durationMs);
      lines.push(`| ${row.number} | ${row.label} | ${formatMs(row.durationMs)} | ${downstream} | ${own} |`);
    }
    lines.push('');
    if (narrative.timingNote) lines.push(narrative.timingNote, '');
  } else if (narrative.timingNote) {
    lines.push(`**Where the time went.** ${narrative.timingNote}`, '');
  }

  if (narrative.orderingNote) {
    lines.push(`**How the list below is ordered.** ${narrative.orderingNote}`, '');
  }

  lines.push(`**Flagged lines (comments).** ${narrative.commentsNote}`, '');
  lines.push('---', '');

  return lines;
}

/**
 * `<details>` is GitHub-Flavored-Markdown's native collapsible section -
 * every export target this file is meant for (GitHub, most IDE previews,
 * modern chat tools) renders it. Left collapsed by default (no `open`
 * attribute) since a multi-call report is mostly scanned by heading first,
 * then expanded where the reader actually needs to look at the payload.
 * The label itself ("Headers"/"Body") *is* the clickable summary line -
 * there's no separate heading sitting above a "Show JSON" toggle.
 */
function collapsibleSection(label: string, fenced: string): string {
  return `<details>\n<summary>${label}</summary>\n\n${fenced}\n\n</details>`;
}

/**
 * Pretty-prints if the text is valid JSON or XML, otherwise embeds it
 * verbatim. Deliberately never truncates or summarizes - this file gets
 * handed to another team to diagnose a bug, so partial data would be worse
 * than no export at all. The whole fenced block is wrapped in a collapsible
 * `<details>` so a large payload doesn't force the reader to scroll past it
 * to reach the next section.
 *
 * Flagged lines get an inline `// FLAGGED: ...` marker appended, on top of
 * the dedicated "Flagged Issues" summary section below - the summary is
 * for scanning at a glance, the inline marker is for reading it in context
 * while looking at the actual data.
 */
function codeBlock(label: string, text: string | undefined, lineComments: readonly Comment[] = []): string {
  if (!text) return collapsibleSection(label, '```\n(empty)\n```');

  const { lang, body } = detectAndFormatBody(text);

  if (lineComments.length === 0) {
    return collapsibleSection(label, `\`\`\`${lang}\n${body}\n\`\`\``);
  }

  const byLine = new Map<number, Comment[]>();
  for (const c of lineComments) {
    const list = byLine.get(c.lineIndex) ?? [];
    list.push(c);
    byLine.set(c.lineIndex, list);
  }

  const annotated = body
    .split('\n')
    .map((line, i) => {
      const onThisLine = byLine.get(i);
      if (!onThisLine) return line;
      const notes = onThisLine.map((c) => `FLAGGED: ${c.comment}`).join(' | ');
      return `${line}  // ⚠ ${notes}`;
    })
    .join('\n');

  return collapsibleSection(label, `\`\`\`${lang}\n${annotated}\n\`\`\``);
}

function headersBlock(headers: Readonly<Record<string, string>> | undefined, lineComments: readonly Comment[] = []): string {
  return codeBlock('Headers', JSON.stringify(headers ?? {}), lineComments);
}

const BLOCK_ORDER: readonly CommentBlock[] = ['request-headers', 'request-body', 'response-headers', 'response-body'];

/** `level` matches whatever heading depth "Request"/"Response" sit at in the caller - `##` at the top level of a single-call export, `####` once nested inside a bulk export's per-call `<details>`. */
function flaggedIssuesSection(comments: readonly Comment[], level = 2): string {
  if (comments.length === 0) return '';

  const heading = '#'.repeat(level);
  const subheading = '#'.repeat(level + 1);
  const lines: string[] = [`${heading} 🚩 Flagged Issues`, ''];
  for (const block of BLOCK_ORDER) {
    const blockComments = commentsForBlock(comments, block);
    if (blockComments.length === 0) continue;

    lines.push(`${subheading} ${COMMENT_BLOCK_LABELS[block]}`, '');
    for (const c of blockComments) {
      lines.push(`- **Line ${c.lineIndex + 1}:** \`${c.lineText}\``);
      lines.push(`  > ${c.comment.replace(/\n/g, '\n  > ')}`);
    }
    lines.push('');
  }
  lines.push('---', '');

  return lines.join('\n');
}

/**
 * `overlapCandidates` is optional and used for one thing only: letting the About section say what
 * this call sat inside and what ran inside it, neither of which is in the file. A single-call export
 * is the one place a reader has no way to discover that from the document itself, and "this call is
 * 22s but 17s of that was someone else's work" is exactly the context they open the file for.
 */
export function buildExportMarkdown(
  call: CallRecord,
  form: ExportFormData,
  comments: readonly Comment[] = [],
  overlapCandidates: readonly CallOverlapCandidate[] = []
): string {
  const lines: string[] = [];
  const narrative = buildExportNarrative({
    calls: [call],
    commentsByCallId: new Map([[call.id, comments]]),
    overlapCandidates,
  });

  lines.push('# 📄 API Call Export', '');
  lines.push(...aboutSectionMarkdown(narrative));
  lines.push('## 🧾 Metadata', '');
  lines.push(...metadataTable(form));
  lines.push('', '---', '');

  const flagged = flaggedIssuesSection(comments);
  if (flagged) {
    lines.push(flagged);
  }

  lines.push('## 📤 Request', '');
  lines.push(`- **Method:** \`${call.method}\``);
  lines.push(`- **URL:** ${call.url}`);
  lines.push(`- **Timestamp:** ${call.timestamp}`);
  if (call.duration_ms != null) {
    lines.push(`- **Duration:** ${formatMs(call.duration_ms)}`);
  }
  lines.push('');
  lines.push(headersBlock(call.request?.headers, commentsForBlock(comments, 'request-headers')));
  lines.push('');
  lines.push(codeBlock('Body', call.request?.body, commentsForBlock(comments, 'request-body')));
  lines.push('', '---', '');

  lines.push('## 📥 Response', '');
  if (call.error) {
    const suffix = call.response ? '' : ' No response was received for this call.';
    lines.push(`> ⚠️ **Error:** ${call.error}${suffix}`);
  }
  if (call.response) {
    if (call.error) lines.push('');
    lines.push(`- **Status:** \`${call.response.status}\``);
    lines.push('');
    lines.push(headersBlock(call.response.headers, commentsForBlock(comments, 'response-headers')));
    lines.push('');
    lines.push(codeBlock('Body', call.response.body, commentsForBlock(comments, 'response-body')));
  }
  lines.push('', '---', '');
  lines.push(`*Exported from Alfred/Frontend*`);

  return lines.join('\n');
}

export function exportFilename(call: CallRecord): string {
  const supplier = supplierOf(call).replace(/[^a-zA-Z0-9.-]/g, '_');
  return `${supplier}-${callKey(call)}.md`;
}

function statusCell(call: CallRecord): string {
  if (call.error) return `❌ ${call.error}`;
  if (!call.response) return '❔ ?';
  return call.response.status < 400 ? `✅ ${call.response.status}` : `⚠️ ${call.response.status}`;
}

/**
 * One rendered block in the bulk report: a whole call ('full', today's behavior - always used for
 * external calls) or one half of a split internal call ('request'/'response'). See
 * buildRenderBlocks() - mirrors call-utils.ts's splitCallsForDisplay()/CallListRow, but this file's
 * split is driven purely by "is this an internal, resolved call", not by the live list's sort mode.
 */
interface RenderBlock {
  readonly call: CallRecord;
  readonly n: number;
  readonly variant: 'request' | 'response' | 'full';
  readonly sortTime: number;
}

/**
 * Same 3-check containment + ownership + ambiguity-veto algorithm as call-utils.ts's
 * qualifiesAsEvidence/computeSplitCallIds, re-implemented here per this codebase's
 * convention of mirroring shared logic per consumer rather than importing it across unrelated
 * layers (see buildRenderBlocks/isSplitInternalCall's own doc) - keep the actual math identical if
 * call-utils.ts's version ever changes.
 */
function targetWindow(target: CallRecord): { start: number; end: number } {
  const start = new Date(target.timestamp).getTime();
  return { start, end: start + (target.duration_ms ?? 0) };
}

/** Whether `inner` sits STRICTLY inside `outer` - one-directionally. Two calls with identical
 * windows contain each other, and that's ambiguity rather than nesting: there's no telling which of
 * them a call inside both belongs to, so neither may claim it. Mirrors call-tree.ts's resolveParent,
 * so the split and the tree views can never disagree about whose downstream work a call was. */
function strictlyContainsCall(outer: CallRecord, inner: CallRecord): boolean {
  if (outer.id === inner.id) return false;
  const o = targetWindow(outer);
  const i = targetWindow(inner);
  const innerFitsInOuter = i.start >= o.start && i.end <= o.end;
  const outerFitsInInner = o.start >= i.start && o.end <= i.end;
  return innerFitsInOuter && !outerFitsInInner;
}

function candidateWindow(candidate: CallOverlapCandidate): { start: number; end: number } {
  const start = new Date(candidate.timestamp).getTime();
  return { start, end: start + candidate.durationMs };
}

/** Check 1 of 4: strict containment - see call-utils.ts's isStrictlyContained. */
function isStrictlyContained(target: CallRecord, candidate: CallOverlapCandidate): boolean {
  if (candidate.id === target.id) return false;
  const t = targetWindow(target);
  const c = candidateWindow(candidate);
  return c.start >= t.start && c.end <= t.end;
}

/** Check 2 of 4: ownership/attribution - see call-utils.ts's passesOwnershipCheck. */
function passesOwnershipCheck(target: CallRecord, candidate: CallOverlapCandidate): boolean {
  const targetServiceName = target.service_name ?? null;
  if (candidate.source === 'internal') {
    return candidate.serviceName !== targetServiceName;
  }
  if (candidate.serviceName == null) return true;
  return candidate.serviceName === targetServiceName;
}

/** Checks 1-2 combined - see call-utils.ts's qualifiesAsNestedChild. */
function qualifiesAsNestedChild(target: CallRecord, candidate: CallOverlapCandidate): boolean {
  return isStrictlyContained(target, candidate) && passesOwnershipCheck(target, candidate);
}

/** Mirrors call-utils.ts's candidateMatchesStatusFilter - see its doc. */
function candidateMatchesStatusFilter(candidate: CallOverlapCandidate, filter: CallStatusFilter): boolean {
  switch (filter) {
    case 'all':
      return true;
    case 'inProgress':
      return false;
    case 'ok':
      return candidate.status != null && candidate.status < 400;
    case 'client':
      return candidate.status != null && candidate.status >= 400 && candidate.status < 500;
    case 'failed':
      return candidate.error != null || (candidate.status != null && candidate.status >= 500);
  }
}

/** Mirrors call-utils.ts's computeSplitCallIds - see its doc for the exact two-pass mechanics. */
function computeSplitCallIds(
  internalCalls: readonly CallRecord[],
  candidates: readonly CallOverlapCandidate[],
  statusFilter: CallStatusFilter
): ReadonlySet<string> {
  const visibleCandidates = candidates.filter((candidate) => candidateMatchesStatusFilter(candidate, statusFilter));

  const survivorsByCallId = new Map<string, CallOverlapCandidate[]>(internalCalls.map((call) => [call.id, []]));

  for (const candidate of visibleCandidates) {
    const owners = internalCalls.filter((call) => qualifiesAsNestedChild(call, candidate));
    if (owners.length === 0) continue;

    // The INNERMOST owner takes it, provided the owners form a single nested chain - odeysys
    // containing core-service containing this call isn't ambiguous at all, it just means
    // core-service is whose work it was. Only owners that merely OVERLAP, neither inside the other,
    // are genuinely ambiguous, and those give it up entirely rather than guess.
    const innermost = owners.reduce((best, owner) => ((owner.duration_ms ?? 0) < (best.duration_ms ?? 0) ? owner : best));
    const nestedChain = owners.every((owner) => owner.id === innermost.id || strictlyContainsCall(owner, innermost));
    if (!nestedChain) continue;

    survivorsByCallId.get(innermost.id)!.push(candidate);
  }

  const staysSplit = new Set<string>();
  for (const [callId, survivors] of survivorsByCallId) {
    if (survivors.length > 0) staysSplit.add(callId);
  }
  return staysSplit;
}

/** An internal call is eligible to be split at all only once it's resolved (has a response or
 * error, never while still in-progress) - see isSplitInternalCall/buildRenderBlocks. */
function isResolvedInternalCall(call: CallRecord): boolean {
  return call.source === 'internal' && (call.response !== undefined || call.error !== undefined) && !isInProgress(call);
}

/**
 * Expands the (already chronologically sorted) calls into their rendered blocks, then re-sorts by
 * each block's own effective time - a response block's time is its call's timestamp plus its
 * duration, so it can legitimately land after another call's request block that started later but
 * finished/was captured first. This is what produces the "Odeysys-request, core-service-request,
 * external-call, core-service-response, odeysys-response" interleaving from the spec.
 *
 * An internal call only reads sensibly as two separate blocks once it actually has a response or
 * error (a still-in-progress internal call stays a single (incomplete) block rather than
 * fabricating an empty response half) AND it stays split per the full 4-check algorithm computed
 * up front across every resolved internal call in `sortedCalls` at once (see computeSplitCallIds -
 * the ambiguity veto needs the whole picture before any one call's decision can be made).
 * `overlapCandidates` is the batch already fetched for the export's full time range (see
 * export-dialog.component.ts) under whatever filters were active at export time; `statusFilter` is
 * the status-pill bucket active then too.
 */
function buildRenderBlocks(
  sortedCalls: readonly CallRecord[],
  overlapCandidates: readonly CallOverlapCandidate[],
  statusFilter: CallStatusFilter
): { blocks: RenderBlock[]; staysSplitIds: ReadonlySet<string> } {
  const resolvedInternalCalls = sortedCalls.filter(isResolvedInternalCall);
  const staysSplitIds = computeSplitCallIds(resolvedInternalCalls, overlapCandidates, statusFilter);

  const blocks: RenderBlock[] = [];
  sortedCalls.forEach((call, i) => {
    const n = i + 1;
    const baseTime = new Date(call.timestamp).getTime();
    if (isResolvedInternalCall(call) && staysSplitIds.has(call.id)) {
      blocks.push({ call, n, variant: 'request', sortTime: baseTime });
      blocks.push({ call, n, variant: 'response', sortTime: baseTime + (call.duration_ms ?? 0) });
    } else {
      blocks.push({ call, n, variant: 'full', sortTime: baseTime });
    }
  });
  blocks.sort((a, b) => a.sortTime - b.sortTime);
  return { blocks, staysSplitIds };
}

function blockAnchor(block: RenderBlock): string {
  return block.variant === 'response' ? `call-${block.n}-response` : `call-${block.n}`;
}

function blockSuffix(block: RenderBlock): string {
  return block.variant === 'full' ? '' : ` · ${block.variant}`;
}

/**
 * A request block only ever exists for a call that has ALREADY resolved (see isSplitInternalCall -
 * a still-in-progress call stays a single 'full' block, never 'request'), so this must never say
 * "pending" - it settles to a plain "sent" marker exactly like the live list's request row does
 * once its paired response arrives, and the real outcome shows on the response block instead.
 */
function blockStatusCell(block: RenderBlock): string {
  return block.variant === 'request' ? '➡️ sent' : statusCell(block.call);
}

/** A request block's own flagged issues are request-side only (it can't show a response-side flag that hasn't arrived yet); a response block's are response-side only; a full block keeps showing everything, exactly as today. */
function commentsForVariant(comments: readonly Comment[], variant: RenderBlock['variant']): Comment[] {
  if (variant === 'request') return comments.filter((c) => c.block.startsWith('request'));
  if (variant === 'response') return comments.filter((c) => c.block.startsWith('response'));
  return [...comments];
}

function renderBlockBody(block: RenderBlock, allComments: readonly Comment[]): string[] {
  const { call, variant } = block;
  const comments = commentsForVariant(allComments, variant);
  const lines: string[] = [];

  lines.push(`- **Method:** \`${call.method}\``);
  lines.push(`- **URL:** ${call.url}`);
  if (variant !== 'response') {
    lines.push(`- **Timestamp:** ${call.timestamp}`);
  }
  if (variant !== 'request') {
    lines.push(`- **Status:** ${call.response ? `\`${call.response.status}\`` : call.error ? `⚠️ ${call.error}` : '`?`'}`);
    if (variant === 'response') {
      lines.push(`- **Received:** ${new Date(new Date(call.timestamp).getTime() + (call.duration_ms ?? 0)).toISOString()}`);
    }
    if (call.duration_ms != null) {
      lines.push(`- **Duration:** ${formatMs(call.duration_ms)}`);
    }
  }
  lines.push('');

  const flagged = flaggedIssuesSection(comments, 4);
  if (flagged) lines.push(flagged);

  if (variant !== 'response') {
    lines.push('#### 📤 Request', '');
    lines.push(headersBlock(call.request?.headers, commentsForBlock(allComments, 'request-headers')));
    lines.push('');
    lines.push(codeBlock('Body', call.request?.body, commentsForBlock(allComments, 'request-body')));
    lines.push('');
  }

  if (variant !== 'request') {
    if (call.error) {
      const suffix = call.response ? '' : ' No response was received for this call.';
      lines.push(`> ⚠️ **Error:** ${call.error}${suffix}`, '');
    }
    if (call.response) {
      lines.push('#### 📥 Response', '');
      lines.push(headersBlock(call.response.headers, commentsForBlock(allComments, 'response-headers')));
      lines.push('');
      lines.push(codeBlock('Body', call.response.body, commentsForBlock(allComments, 'response-body')));
      lines.push('');
    }
  }

  return lines;
}

/**
 * One combined report for several calls at once - a summary table up top
 * (so a reader can scan status/duration before diving in) followed by every
 * call's full detail, each collapsed into its own `<details open>` block
 * (open by default, unlike the Headers/Body blocks inside it) so a long
 * multi-call report still reads as a scannable list of headings rather
 * than one continuous wall of JSON.
 *
 * Internal calls (call.source === 'internal') that have resolved render as two separate,
 * flat/non-nested blocks - a request block and a response block - so the export reads in real
 * chronological order (e.g. request, request, external call, response, response) instead of
 * request+response always sitting glued together. External calls, and internal calls that haven't
 * resolved yet, always render as a single block exactly as before. See buildRenderBlocks().
 */
export function buildBulkExportMarkdown(
  calls: readonly CallRecord[],
  form: ExportFormData,
  commentsByCallId: ReadonlyMap<string, readonly Comment[]>,
  exportedAt: string,
  overlapCandidates: readonly CallOverlapCandidate[] = [],
  statusFilter: CallStatusFilter = 'all'
): string {
  const lines: string[] = [];
  const succeeded = calls.filter((c) => !c.error && c.response && c.response.status < 400).length;
  const failed = calls.length - succeeded;
  const totalDurationMs = calls.reduce((sum, c) => sum + (c.duration_ms ?? 0), 0);
  const totalFlagged = [...commentsByCallId.values()].reduce((sum, list) => sum + list.length, 0);
  const callWord = calls.length === 1 ? 'Call' : 'Calls';

  // The request/response sandwich split only reads sensibly in real time order - a caller may pass
  // pinned-first/supplier-grouped/custom-drag order, which would otherwise interleave nonsensically
  // once a call is split into two blocks. Sort a local copy; never mutate/reorder for the caller.
  const sortedCalls = [...calls].sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  const { blocks, staysSplitIds } = buildRenderBlocks(sortedCalls, overlapCandidates, statusFilter);
  const narrative = buildExportNarrative({ calls, commentsByCallId, splitCallIds: staysSplitIds });

  lines.push(`# 📋 API Calls Export — ${calls.length} ${callWord}`, '');
  lines.push(
    `**Exported:** ${exportedAt} &nbsp;•&nbsp; **Succeeded:** ${succeeded} ✅ &nbsp;•&nbsp; **Failed:** ${failed} ❌ &nbsp;•&nbsp; **Total duration:** ${formatMs(totalDurationMs)}`,
    ''
  );
  lines.push('---', '');

  lines.push(...aboutSectionMarkdown(narrative));

  lines.push('## 🧾 Metadata', '');
  lines.push(...metadataTable(form));
  lines.push('', '---', '');

  lines.push('## 📊 Summary', '');
  lines.push('| # | Method | Path | Status | Duration | Flagged |', '|---|--------|------|--------|----------|---------|');
  blocks.forEach((block) => {
    const { call } = block;
    const comments = commentsForVariant(commentsByCallId.get(call.id) ?? [], block.variant);
    const flaggedCount = comments.length;
    const duration = block.variant !== 'request' && call.duration_ms != null ? formatMs(call.duration_ms) : '—';
    const flaggedCell = flaggedCount > 0 ? `🚩 ${flaggedCount} issue${flaggedCount === 1 ? '' : 's'}` : '—';
    lines.push(
      `| [${block.n}${blockSuffix(block)}](#${blockAnchor(block)}) | \`${call.method}\` | \`${uriPath(call.url)}\` | ${blockStatusCell(block)} | ${duration} | ${flaggedCell} |`
    );
  });
  lines.push('', '---', '');

  const depthsByCallId = depthByCallId(narrative.topology);

  lines.push('## 🔗 Calls', '');

  blocks.forEach((block) => {
    const { call } = block;
    const allComments = commentsByCallId.get(call.id) ?? [];

    // Indented to match the topology, so the Calls list reads as the tree it already is: a split
    // parent's request and response sit at one level with everything it caused nested between them.
    // Drawn with &nbsp; and box characters rather than a style attribute because GitHub and most
    // other Markdown renderers strip inline CSS but keep both of these.
    const depth = depthsByCallId.get(call.id) ?? 0;
    const indent = depth > 0 ? `${'&nbsp;'.repeat(depth * 4)}└─ ` : '';

    lines.push(`<a id="${blockAnchor(block)}"></a>`);
    lines.push('<details open>');
    lines.push(
      `<summary>${indent}<b>Call ${block.n}</b>${blockSuffix(block)} &nbsp; <code>${call.method} ${uriPath(call.url)}</code> &nbsp; ${blockStatusCell(block)}</summary>`,
      ''
    );

    lines.push(...renderBlockBody(block, allComments));

    lines.push('</details>', '');
  });

  lines.push('---', '');
  lines.push(
    `*Exported from Alfred/Frontend — ${calls.length} call${calls.length === 1 ? '' : 's'}, ${totalFlagged} flagged issue${totalFlagged === 1 ? '' : 's'} total*`
  );

  return lines.join('\n');
}

export function bulkExportFilename(calls: readonly CallRecord[], extension: 'md' | 'json'): string {
  return `alfred-export-${calls.length}-calls.${extension}`;
}
