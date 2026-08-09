import { Component, effect, inject, signal } from '@angular/core';
import { EmojiPickerComponent } from '../emoji-picker/emoji-picker.component';
import { randomAvatarEmoji } from '../../core/models/avatar-emojis';
import { EditProfileDialogService } from '../../core/services/edit-profile-dialog.service';

/** Styled name + avatar edit form, mirroring EditCycleDialogComponent's shape. */
@Component({
  selector: 'app-edit-profile-dialog',
  standalone: true,
  imports: [EmojiPickerComponent],
  templateUrl: './edit-profile-dialog.component.html',
})
export class EditProfileDialogComponent {
  private readonly service = inject(EditProfileDialogService);
  readonly state = this.service.state;

  readonly name = signal('');
  readonly avatar = signal(randomAvatarEmoji().char);

  constructor() {
    effect(
      () => {
        const profile = this.state();
        if (!profile) return;
        this.name.set(profile.name);
        this.avatar.set(profile.avatar ?? randomAvatarEmoji().char);
      },
      { allowSignalWrites: true }
    );
  }

  cancel(): void {
    this.service.cancel();
  }

  save(): void {
    const name = this.name().trim();
    if (!name) return;
    this.service.submit({ name, avatar: this.avatar() });
  }
}
