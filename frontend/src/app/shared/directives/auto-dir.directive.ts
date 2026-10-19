import { Directive, computed, input } from '@angular/core';
import { textDir } from '../utils/text-direction';

/**
 * Sets a block's `dir` from its own words (`textDir`): an Arabic sentence that starts with "Admin" or "POST" still reads
 * right-to-left, an English one left-to-right - the rule the markdown view already follows, for the board's other text
 * (card titles, advice, the peek). No letters at all: the browser's `auto`.
 */
@Directive({
  selector: '[appAutoDir]',
  standalone: true,
  host: { '[attr.dir]': 'dir()' },
})
export class AutoDirDirective {
  /** The words the block shows - code and mentions left out by the caller when it can. */
  readonly appAutoDir = input<string | null | undefined>('');
  readonly dir = computed(() => textDir(this.appAutoDir()) ?? 'auto');
}
