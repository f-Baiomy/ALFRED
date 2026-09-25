import { CallRecord } from '../../core/models/call.model';
import { ResendDraft, draftFrom } from './resend-draft';
import {
  ResendGroup,
  addMemberAt,
  addToGroup,
  extractToRun,
  groupDrafts,
  nextGroupName,
  pruneGroups,
  runAtOffset,
  runsOf,
  swapMembers,
  swapRuns,
  ungroup,
} from './resend-group';

function call(id: string): CallRecord {
  return { id, original_url: `/u/${id}`, url: `/u/${id}`, method: 'GET', timestamp: 't', duration_ms: 1, source: 'external' };
}

/** Drafts for these logged call ids, in this order - c1..cN by default. */
function draftsOf(...ids: string[]): ResendDraft[] {
  return ids.map((id) => draftFrom(call(id), null));
}

/** The drafts for these call ids, for passing as a group's members. */
function members(drafts: readonly ResendDraft[], ...callIds: string[]): ResendDraft[] {
  return callIds.map((id) => drafts.find((d) => d.ref.callId === id)!);
}

/** The logged call each draft came from, in order - the readable form of "what order are these in". */
const keys = (drafts: readonly ResendDraft[]): string[] => drafts.map((d) => d.ref.callId);

const G: ResendGroup = { id: 'g1', name: 'Group 1', mode: 'sequential' };

describe('resend-group', () => {
  describe('runsOf', () => {
    it('gives every loose call its own run, so it still drags and arrows on its own', () => {
      const runs = runsOf(draftsOf('c1', 'c2', 'c3'), {});
      expect(runs.map((r) => [r.kind, keys(r.drafts)])).toEqual([
        ['loose', ['c1']],
        ['loose', ['c2']],
        ['loose', ['c3']],
      ]);
    });

    it('gives a group one run, and keeps the loose calls around it as runs of their own', () => {
      const all = draftsOf('c1', 'c2', 'c3');
      const grouped = groupDrafts(all, members(all, 'c1', 'c3'), 'g1');
      const runs = runsOf([...grouped, ...draftsOf('c4')], { g1: G });
      expect(runs.map((r) => [r.kind, keys(r.drafts)])).toEqual([
        ['group', ['c1', 'c3']],
        ['loose', ['c2']],
        ['loose', ['c4']],
      ]);
    });

    it('reads a groupId with no group as loose, so a stale reference never renders a nameless header', () => {
      const all = draftsOf('c1', 'c2');
      expect(runsOf(groupDrafts(all, members(all, 'c1', 'c2'), 'gone'), {})[0].kind).toBe('loose');
    });
  });

  describe('groupDrafts', () => {
    it('pulls calls at 1, 4 and 7 together as 1, 2, 3 and shifts the rest up to fill the gaps', () => {
      // The case this exists for: grouping is free-form to create and contiguous to live.
      const all = draftsOf('c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7');
      const grouped = groupDrafts(all, members(all, 'c1', 'c4', 'c7'), 'g1');
      expect(keys(grouped)).toEqual(['c1', 'c4', 'c7', 'c2', 'c3', 'c5', 'c6']);
      expect(grouped.every((d, i) => (i < 3 ? d.groupId === 'g1' : d.groupId === null))).toBeTrue();
    });

    it('keeps the members in the order they were already in, not the order they were picked', () => {
      const all = draftsOf('c1', 'c2', 'c3', 'c4');
      expect(keys(groupDrafts(all, members(all, 'c3', 'c1'), 'g1'))).toEqual(['c1', 'c3', 'c2', 'c4']);
    });

    it('lands the block at the earliest member, not at the top', () => {
      const all = draftsOf('c1', 'c2', 'c3', 'c4');
      expect(keys(groupDrafts(all, members(all, 'c2', 'c4'), 'g1'))).toEqual(['c1', 'c2', 'c4', 'c3']);
    });

    it('refuses fewer than two calls - one call is not a group', () => {
      const all = draftsOf('c1', 'c2');
      expect(groupDrafts(all, members(all, 'c2'), 'g1')).toEqual(all);
    });

    it('moves a member out of whichever group it was in', () => {
      const first = draftsOf('c1', 'c2', 'c3', 'c4');
      const inG1 = groupDrafts(first, members(first, 'c1', 'c2'), 'g1');
      const inG2 = groupDrafts(inG1, members(inG1, 'c1', 'c3'), 'g2');
      expect(keys(inG2)).toEqual(['c1', 'c3', 'c2', 'c4']);
      expect(inG2.find((d) => d.ref.callId === 'c2')!.groupId).toBe('g1');
    });
  });

  describe('addToGroup', () => {
    it('lands a loose call just after the group, keeping the run contiguous', () => {
      const all = draftsOf('c1', 'c2', 'c3', 'c4');
      const grouped = groupDrafts(all, members(all, 'c2', 'c3'), 'g1');
      const joined = addToGroup(grouped, 'g1', members(grouped, 'c4'));
      expect(keys(joined)).toEqual(['c1', 'c2', 'c3', 'c4']);
      expect(runsOf(joined, { g1: G }).map((r) => [r.kind, keys(r.drafts)])).toEqual([
        ['loose', ['c1']],
        ['group', ['c2', 'c3', 'c4']],
      ]);
    });

    it('appends at the end when the group has no member left in the list to land after', () => {
      const all = draftsOf('c1', 'c2');
      expect(keys(addToGroup(all, 'g1', members(all, 'c1')))).toEqual(['c2', 'c1']);
    });
  });

  describe('ungroup', () => {
    it('dissolves the group in place, leaving the order untouched', () => {
      const all = draftsOf('c1', 'c2', 'c3');
      const dissolved = ungroup(groupDrafts(all, members(all, 'c1', 'c2'), 'g1'), 'g1');
      expect(keys(dissolved)).toEqual(['c1', 'c2', 'c3']);
      expect(dissolved.every((d) => d.groupId === null)).toBeTrue();
    });
  });

  describe('swapRuns', () => {
    it('exchanges two loose calls and leaves everything between them alone', () => {
      // The bug this guards: splicing the dragged run out and back in moved it to the target's
      // place but shoved every run in between along by one, so a drag from the top to the bottom
      // appeared to shuffle the whole list. A swap moves exactly the two named.
      expect(keys(swapRuns(draftsOf('c1', 'c2', 'c3', 'c4'), 0, 3))).toEqual(['c4', 'c2', 'c3', 'c1']);
    });

    it('exchanges neighbours, which is what an arrow does', () => {
      expect(keys(swapRuns(draftsOf('c1', 'c2', 'c3'), 1, 0))).toEqual(['c2', 'c1', 'c3']);
    });

    it('moves a group past a differently sized run, which cannot be exchanged with it', () => {
      const all = draftsOf('c1', 'c2', 'c3', 'c4');
      const drafts = [...groupDrafts(all, members(all, 'c1', 'c2'), 'g1'), ...draftsOf('c5')];
      // Runs: [g1: c1 c2] [c3] [c4] [c5]. A two-call group and a one-call run do not fit in each
      // other's places, so the group goes past c4 and c4 slides up to where the group was.
      expect(keys(swapRuns(drafts, 0, 2))).toEqual(['c3', 'c4', 'c1', 'c2', 'c5']);
    });

    it('exchanging neighbours reads the same whether or not the runs are the same size', () => {
      const all = draftsOf('c1', 'c2', 'c3', 'c4');
      const drafts = [...groupDrafts(all, members(all, 'c1', 'c2'), 'g1'), ...draftsOf('c5')];
      // [g1: c1 c2] down past [c3]: the group and the call have visibly changed places.
      expect(keys(swapRuns(drafts, 0, 1))).toEqual(['c3', 'c1', 'c2', 'c4', 'c5']);
    });

    it('exchanges two groups whole, neither splitting', () => {
      const all = draftsOf('c1', 'c2', 'c3', 'c4', 'c5', 'c6');
      const drafts = groupDrafts(groupDrafts(all, members(all, 'c1', 'c2'), 'g1'), members(all, 'c4', 'c5'), 'g2');
      // Runs: [g1: c1 c2] [c3] [g2: c4 c5] [c6].
      expect(keys(swapRuns(drafts, 0, 2))).toEqual(['c4', 'c5', 'c3', 'c1', 'c2', 'c6']);
    });

    it('is its own inverse', () => {
      const drafts = draftsOf('c1', 'c2', 'c3', 'c4');
      expect(keys(swapRuns(swapRuns(drafts, 0, 3), 0, 3))).toEqual(['c1', 'c2', 'c3', 'c4']);
    });

    it('refuses an index that names no run, or the same run twice', () => {
      const drafts = draftsOf('c1', 'c2');
      expect(keys(swapRuns(drafts, 0, 9))).toEqual(['c1', 'c2']);
      expect(keys(swapRuns(drafts, 1, 1))).toEqual(['c1', 'c2']);
    });
  });

  describe('swapMembers', () => {
    const threeInAGroup = () => {
      const all = draftsOf('c1', 'c2', 'c3', 'c4');
      return groupDrafts(all, members(all, 'c1', 'c2', 'c3'), 'g1');
    };

    it('exchanges two members, leaving the rest of the list where it was', () => {
      const drafts = threeInAGroup();
      expect(keys(swapMembers(drafts, 'g1', 0, 2))).toEqual(['c3', 'c2', 'c1', 'c4']);
    });

    it('refuses an index that is not a member place', () => {
      const drafts = threeInAGroup();
      expect(keys(swapMembers(drafts, 'g1', 0, 3))).toEqual(['c1', 'c2', 'c3', 'c4']);
      expect(keys(swapMembers(drafts, 'nope', 0, 1))).toEqual(['c1', 'c2', 'c3', 'c4']);
    });
  });

  describe('runAtOffset', () => {
    it('names the run a delta away, or null at either end', () => {
      expect(runAtOffset(0, 1, 3)).toBe(1);
      expect(runAtOffset(2, -1, 3)).toBe(1);
      expect(runAtOffset(0, -1, 3)).toBeNull();
      expect(runAtOffset(2, 1, 3)).toBeNull();
    });
  });


  describe('addMemberAt', () => {
    /** c1 and c2 grouped, c3 left loose after them. */
    const twoInAGroup = () => {
      const all = draftsOf('c1', 'c2', 'c3');
      return groupDrafts(all, members(all, 'c1', 'c2'), 'g1');
    };

    it('drops a loose call in at the member place it was let go over', () => {
      const drafts = twoInAGroup();
      const loose = drafts[2];
      const joined = addMemberAt(drafts, 'g1', loose, 0);
      expect(keys(joined)).toEqual(['c3', 'c1', 'c2']);
      expect(joined.every((d) => d.groupId === 'g1')).toBeTrue();
    });

    it('clamps a place past the end rather than losing the call', () => {
      const drafts = twoInAGroup();
      const joined = addMemberAt(drafts, 'g1', drafts[2], 99);
      expect(keys(joined)).toEqual(['c1', 'c2', 'c3']);
    });
  });

  describe('extractToRun', () => {
    it('takes a call out of its group and leaves it loose before the run it was dropped on', () => {
      const all = draftsOf('c1', 'c2', 'c3', 'c4');
      const drafts = groupDrafts(all, members(all, 'c1', 'c2'), 'g1');
      // Runs: [group: c1 c2] [loose: c3] [loose: c4]. c1 out, before run 1 (c3).
      const out = extractToRun(drafts, drafts[0], 1);
      expect(keys(out)).toEqual(['c2', 'c1', 'c3', 'c4']);
      expect(out[0].groupId).toBe('g1');
      expect(out[1].groupId).toBeNull();
    });

    it('leaves the remaining members contiguous, so the group is still one run', () => {
      const all = draftsOf('c1', 'c2', 'c3', 'c4');
      const drafts = groupDrafts(all, members(all, 'c1', 'c2', 'c3'), 'g1');
      const out = extractToRun(drafts, drafts[0], 0);
      expect(runsOf(out, { g1: G }).map((r) => r.kind)).toEqual(['loose', 'group', 'loose']);
    });

    it('appends when the run it was dropped on is past the end', () => {
      const all = draftsOf('c1', 'c2');
      const drafts = groupDrafts(all, members(all, 'c1', 'c2'), 'g1');
      expect(keys(extractToRun(drafts, drafts[0], 9))).toEqual(['c2', 'c1']);
    });
  });

  describe('nextGroupName', () => {
    it('counts up, and skips a default already taken by a rename', () => {
      expect(nextGroupName({})).toBe('Group 1');
      expect(nextGroupName({ a: { ...G, id: 'a', name: 'Group 1' } })).toBe('Group 2');
    });
  });
});
