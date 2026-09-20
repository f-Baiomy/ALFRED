import { copyToClipboard } from './clipboard';

describe('copyToClipboard', () => {
  /**
   * These replace a GLOBAL, so they have to put it back.
   *
   * Without this, whichever spec file Karma happened to run next inherited a `navigator.clipboard`
   * that was either undefined or a leftover jasmine spy - and a test that then tried to spy on it
   * itself failed with "writeText has already been spied upon", intermittently, depending only on
   * the random spec order. Found exactly that way.
   */
  const original = Object.getOwnPropertyDescriptor(Navigator.prototype, 'clipboard');

  afterEach(() => {
    if (original) {
      Object.defineProperty(navigator, 'clipboard', { ...original, configurable: true });
    } else {
      delete (navigator as { clipboard?: unknown }).clipboard;
    }
  });

  it('uses navigator.clipboard.writeText when it succeeds', async () => {
    const writeText = jasmine.createSpy('writeText').and.resolveTo(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

    await copyToClipboard('hello');

    expect(writeText).toHaveBeenCalledWith('hello');
  });

  it('falls back to execCommand when navigator.clipboard.writeText rejects (e.g. an insecure context)', async () => {
    const writeText = jasmine.createSpy('writeText').and.rejectWith(new Error('insecure context'));
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const execSpy = spyOn(document, 'execCommand').and.returnValue(true);

    await copyToClipboard('fallback text');

    expect(execSpy).toHaveBeenCalledWith('copy');
  });

  it('falls back to execCommand when navigator.clipboard is unavailable entirely', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    const execSpy = spyOn(document, 'execCommand').and.returnValue(true);

    await copyToClipboard('no clipboard api');

    expect(execSpy).toHaveBeenCalledWith('copy');
  });

  it('rejects when both the Clipboard API and execCommand fail', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    spyOn(document, 'execCommand').and.returnValue(false);

    await expectAsync(copyToClipboard('nothing works')).toBeRejected();
  });
});
