import { DatePipe } from '@angular/common';
import { Component, inject, signal } from '@angular/core';
import { ConfirmDialogComponent } from '../../components/confirm-dialog/confirm-dialog.component';
import { EditProfileDialogComponent } from '../../components/edit-profile-dialog/edit-profile-dialog.component';
import { EmojiPickerComponent } from '../../components/emoji-picker/emoji-picker.component';
import { randomAvatarEmoji } from '../../core/models/avatar-emojis';
import { Profile } from '../../core/models/profile.model';
import { ConfirmDialogService } from '../../core/services/confirm-dialog.service';
import { EditProfileDialogService } from '../../core/services/edit-profile-dialog.service';
import { ProfilesStateService } from '../../core/state/profiles-state.service';

@Component({
  selector: 'app-profiles-list',
  standalone: true,
  imports: [DatePipe, ConfirmDialogComponent, EditProfileDialogComponent, EmojiPickerComponent],
  templateUrl: './profiles-list.component.html',
})
export class ProfilesListComponent {
  private readonly confirmDialog = inject(ConfirmDialogService);
  private readonly editDialog = inject(EditProfileDialogService);
  readonly state = inject(ProfilesStateService);

  readonly newName = signal('');
  /** A fresh random pick every time this page loads and after every create, per the "always a random default" requirement - not a fixed constant. */
  readonly newAvatar = signal(randomAvatarEmoji().char);
  readonly creating = signal(false);

  createProfile(): void {
    const name = this.newName().trim();
    if (!name) return;
    this.creating.set(true);
    this.state.create({ name, avatar: this.newAvatar() }).subscribe(() => {
      this.creating.set(false);
      this.newName.set('');
      this.newAvatar.set(randomAvatarEmoji().char);
    });
  }

  async edit(profile: Profile): Promise<void> {
    const result = await this.editDialog.open(profile);
    if (!result) return;
    this.state.update(profile.id, result).subscribe();
  }

  async deleteProfile(profile: Profile): Promise<void> {
    const confirmed = await this.confirmDialog.confirm(`Delete profile "${profile.name}"?`);
    if (!confirmed) return;
    this.state.delete(profile.id).subscribe();
  }
}
