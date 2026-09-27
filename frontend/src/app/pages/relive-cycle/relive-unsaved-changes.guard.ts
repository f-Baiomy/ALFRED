import { CanDeactivateFn } from '@angular/router';

/** Any component the Relive cycle route can deactivate that knows how to ask (FR-008). */
export interface CanDeactivateRelive {
  canDeactivate(): boolean | Promise<boolean>;
}

export const reliveUnsavedChangesGuard: CanDeactivateFn<CanDeactivateRelive> = (component) => component.canDeactivate();
