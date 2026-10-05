import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

/**
 * Ready-made debugging sessions (Claude Code lists them as /mcp__alfred__debug_cycle and
 * /mcp__alfred__debug_call): the order of steps that found the Air Arabia "322 inside a 200" fastest,
 * written down once so every session starts from it instead of rediscovering it.
 */

/** Last: the calls that succeeded are read too - the groups order the work, they do not rule anything out. */
const READ_THE_REST = 'Then read the group-6 calls related to the problem - first the ones just before a failing call (a login that set the '
  + 'session the next call rejected, a search whose result the booking used): a call that succeeded can hold the cause.';

const STEPS_AFTER_STORY = [
  'For every call marked ✖ (an error inside a successful response), ∅ (empty result) or with a failing status: open it with get_call '
    + '(fields responseBody / requestBody for just the bodies) and read the supplier calls listed under it (↳).',
  'Where a call has database capture (◆ DB), read its findings with db_overview; open the statements they name with db_statement - '
    + 'its "sources" give the project files (File.java:line) - and open those files in this project.',
  'If two attempts of the same call differ (a retry, a login that failed then worked), compare them with diff_calls.',
  'If a call is marked ⚡, a rule changed it - read the rule with get_rule before trusting what was recorded.',
  'When you have found the cause, explain it with the evidence (call numbers, statement numbers, file:line), propose the fix in this '
    + 'project\'s code, and ask the user before recording it in Alfred with add_comment on the call it is about (one whole-call note, '
    + 'or a line comment where one line is the proof).',
];

export function registerPrompts(server: McpServer): void {
  server.registerPrompt('debug_cycle', {
    title: 'Debug an Alfred session cycle',
    description: 'Walk a recorded session cycle from its story to the cause in this project\'s code.',
    argsSchema: {
      cycle: z.string().describe('Cycle id, or text from its name'),
      problem: z.string().optional().describe('What went wrong, in the user\'s words'),
    },
  }, ({ cycle, problem }) => ({
    messages: [{
      role: 'user',
      content: {
        type: 'text',
        text: [
          `Debug the Alfred session cycle "${cycle}"${problem ? ` - the problem: ${problem}` : ''}.`,
          '',
          '1. Run triage on it: what needs attention first, in groups 1-6, with the failing supplier calls and failed statements attached.',
          '2. Read it with get_cycle (page with nextOffset until you have all of it) for the flow around those calls. Spacers name its steps.',
          ...[...STEPS_AFTER_STORY, READ_THE_REST].map((s, i) => `${i + 3}. ${s}`),
        ].join('\n'),
      },
    }],
  }));

  server.registerPrompt('debug_call', {
    title: 'Debug one Alfred call',
    description: 'Investigate one recorded call: its bodies, supplier calls, database work and the code behind it.',
    argsSchema: {
      callId: z.string().describe('The call id'),
      problem: z.string().optional().describe('What went wrong, in the user\'s words'),
    },
  }, ({ callId, problem }) => ({
    messages: [{
      role: 'user',
      content: {
        type: 'text',
        text: [
          `Debug the Alfred call ${callId}${problem ? ` - the problem: ${problem}` : ''}.`,
          '',
          '1. Read it with get_call: status, attention (its triage group and failing supplier calls), softFailure / emptyResult, bodies, '
            + 'the supplier calls it made (children), its db summary and dbFailures (the failed statements).',
          ...[...STEPS_AFTER_STORY, READ_THE_REST].map((s, i) => `${i + 2}. ${s}`),
        ].join('\n'),
      },
    }],
  }));
}
