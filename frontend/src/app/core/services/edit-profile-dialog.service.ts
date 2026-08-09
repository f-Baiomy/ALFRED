import { Injectable, signal } from '@angular/core';
import { Profile } from '../models/profile.model';

export interface EditProfileResult {
  readonly name: string;
  readonly avatar: string | null;
}

/** Single source of truth for "is the edit-profile dialog open, for which profile" - mirrors EditCycleDialogService's Promise-based one-instance-at-the-root pattern. */
@Injectable({ providedIn: 'root' })
export class EditProfileDialogService {
  readonly state = signal<Profile | null>(null);

  private resolve: ((result: EditProfileResult | null) => void) | null = null;

  open(profile: Profile): Promise<EditProfileResult | null> {
    this.state.set(profile);
    return new Promise<EditProfileResult | null>((resolve) => {
      this.resolve = resolve;
    });
  }

  submit(result: EditProfileResult): void {
    this.resolve?.(result);
    this.resolve = null;
    this.state.set(null);
  }

  cancel(): void {
    this.resolve?.(null);
    this.resolve = null;
    this.state.set(null);
  }
}
