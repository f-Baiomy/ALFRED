import { copyToClipboard } from './clipboard';

describe('copyToClipboard', () => {
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
