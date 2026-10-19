import { Injectable, inject, signal } from '@angular/core';
import { LinksStateService } from './links-state.service';
import { Stream } from './links.models';
import { splitRef } from './remote-ref';

/**
 * What another Alfred's thing this page has open (specs/035): a remote cycle page, or a streamed board. A note on one of
 * its calls goes to its owner over the stream that carries it - the open cycle's, else the board's.
 */
@Injectable({ providedIn: 'root' })
export class RemoteContextService {
  private readonly links = inject(LinksStateService);
  /** The open remote cycle's ref, while its page is shown. */
  readonly cycleRef = signal<string | null>(null);
  /** The open remote board's ref, while it is shown. */
  readonly boardRef = signal<string | null>(null);

  /** The stream a request about a call (`<id>@<slug>`) goes over, or none when nothing streamed covers it. */
  streamForCall(callRef: string): Stream | undefined {
    const slug = splitRef(callRef)?.slug;
    const link = slug ? this.links.linkOf(slug) : undefined;
    if (!link) return undefined;
    const active = this.links.given().filter((s) => s.linkId === link.id && !s.endedAt);
    for (const ref of [this.cycleRef(), this.boardRef()]) {
      const s = splitRef(ref);
      if (!s || s.slug !== slug) continue;
      const hit = active.find((x) => x.target === s.inner);
      if (hit) return hit;
    }
    return active.find((s) => s.kind === 'BOARD') ?? active.find((s) => s.kind === 'CYCLE');
  }

  /**
   * The open cycle as the link a call is reached through names it (`<cycle>` for its owner's own, `<cycle>@<x>` for one
   * passed on from a third Alfred), so the owner can place a note on that call - none when the call is not the open cycle's.
   */
  cycleForCall(callRef: string): string | undefined {
    const call = splitRef(callRef);
    const cycle = splitRef(this.cycleRef());
    return call && cycle && cycle.slug === call.slug ? cycle.inner : undefined;
  }
}
