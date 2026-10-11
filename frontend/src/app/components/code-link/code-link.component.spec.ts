import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { IdeFoldersService } from '../../core/services/ide-folders.service';
import { CodeLinkComponent } from './code-link.component';

describe('CodeLinkComponent', () => {
  const FRAME = 'com.tt.dao.GenericDAOImpl.fetchWithHQL(GenericDAOImpl.java:468)';

  function render(text: string, folders: string[]) {
    TestBed.configureTestingModule({ imports: [CodeLinkComponent], providers: [provideRouter([])] });
    TestBed.inject(IdeFoldersService).folders.set(folders.length ? { odeysys: folders } : {});
    const f = TestBed.createComponent(CodeLinkComponent);
    f.componentRef.setInput('text', text);
    f.componentRef.setInput('project', 'odeysys');
    f.detectChanges();
    lastFixture = f;
    return f.nativeElement as HTMLElement;
  }

  let lastFixture: { detectChanges(): void } | null = null;

  async function clickIntellij(folders: string[], answer: (url: string) => Response | null): Promise<{ urls: string[]; message: string }> {
    const el = render(FRAME, folders);
    const urls: string[] = [];
    spyOn(window, 'fetch').and.callFake(((url: string) => {
      urls.push(url);
      const r = answer(url);
      return r ? Promise.resolve(r) : Promise.reject(new TypeError('refused'));
    }) as typeof fetch);
    el.querySelector<HTMLButtonElement>('.code-link-btn.ij')!.click();
    await new Promise((r) => setTimeout(r, 20));
    lastFixture!.detectChanges();
    return { urls, message: el.textContent ?? '' };
  }

  it('says when IntelliJ is not running', async () => {
    expect((await clickIntellij([], () => null)).message).toContain('not running');
  });

  it('says when IntelliJ lacks its open-file plugin (the bare API answers 404 without it)', async () => {
    expect((await clickIntellij([], () => new Response(null, { status: 404 }))).message).toContain('IDE Remote Control');
  });

  it('sends the package path (IntelliJ finds it in the project\'s source folders) and says "sent", never "opened"', async () => {
    const { urls, message } = await clickIntellij([], (url) => new Response(null, { status: url.endsWith('/api/file') ? 400 : 200 }));
    expect(urls).toEqual(['http://localhost:63342/api/file', 'http://localhost:63342/api/file?file=com%2Ftt%2Fdao%2FGenericDAOImpl.java&line=468']);
    expect(message).toContain('sent to IntelliJ');
    expect(message).not.toContain('opened in');
  });

  it('does not send a frame without a package - IntelliJ cannot find a file by name and would still answer 200', () => {
    const el = render('GenericDAOImpl.fetchWithHQL(GenericDAOImpl.java:396)', []);
    const fetchSpy = spyOn(window, 'fetch');
    el.querySelector<HTMLButtonElement>('.code-link-btn.ij')!.click();
    lastFixture!.detectChanges();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(el.textContent).toContain('Ctrl+Shift+N');
  });

  it('VS Code: asks for the folder, links one folder, offers a menu for several', () => {
    expect(render(FRAME, []).querySelector('.code-link-btn.vs.off')?.textContent).toContain('set folder');
    TestBed.resetTestingModule();
    expect(render(FRAME, ['C:\\src\\main\\java']).querySelector<HTMLAnchorElement>('a.code-link-btn.vs')!.getAttribute('href'))
      .toBe('vscode://file/C:/src/main/java/com/tt/dao/GenericDAOImpl.java:468');
    TestBed.resetTestingModule();
    expect(render(FRAME, ['C:\\a', 'C:\\b']).querySelector('app-select-picker.code-link-pick')).not.toBeNull();
  });

  it('an old frame without a package says VS Code cannot open it, and still copies File.java:line', () => {
    const el = render('GenericDAOImpl.fetchWithHQL(GenericDAOImpl.java:468)', ['C:\\a']);
    expect(el.textContent).toContain('VS Code: no package');
    expect(el.textContent).toContain('⧉ GenericDAOImpl.java:468');
  });
});
