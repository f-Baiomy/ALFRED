import { Injectable } from '@angular/core';
import { CommentBlock } from '../models/comment.model';
import { panelViewStorageKey } from '../../shared/utils/panel-view-bridge';

export interface PanelViewSeed {
  readonly callId: string;
  readonly block: CommentBlock;
  readonly label: string;
  readonly rawValue: unknown;
}

/**
 * Opens a call's Headers/Body block in a genuinely separate browser tab,
 * seeded via sessionStorage (the browser clones it into any same-origin
 * tab opened via window.open, so no backend round-trip is needed just to
 * seed the view). That tab renders the exact same JsonPanelComponent this
 * one is, read-only-viewing-wise identical - there's no editing here, so
 * unlike a live-preview bridge there's nothing to stream back for the JSON
 * itself. Comments still sync live across tabs, but that's CommentsStore's
 * job, not this service's.
 */
@Injectable({ providedIn: 'root' })
export class PanelViewLauncherService {
  open(seed: PanelViewSeed): void {
    sessionStorage.setItem(panelViewStorageKey(seed.callId, seed.block), JSON.stringify(seed.rawValue ?? null));

    const url = `/view?callId=${encodeURIComponent(seed.callId)}&block=${encodeURIComponent(seed.block)}&label=${encodeURIComponent(seed.label)}`;
    window.open(url, '_blank');
  }
}
