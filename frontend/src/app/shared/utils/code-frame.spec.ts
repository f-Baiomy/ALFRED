import { intellijUrl, parseCodeFrame, shortFrame, vscodeUrl } from './code-frame';

describe('code frames', () => {
  it('reads a frame with its package - the file\'s path under a source folder - and shortens it for reading', () => {
    const f = parseCodeFrame('com.tt.nc.core.dao.GenericDAOImpl.fetchWithHQL(GenericDAOImpl.java:468)')!;
    expect(f.path).toBe('com/tt/nc/core/dao/GenericDAOImpl.java');
    expect(f.line).toBe(468);
    expect(f.short).toBe('GenericDAOImpl.fetchWithHQL(GenericDAOImpl.java:468)');
    expect(intellijUrl(f)).toBe('http://localhost:63342/api/file?file=com%2Ftt%2Fnc%2Fcore%2Fdao%2FGenericDAOImpl.java&line=468');
    expect(vscodeUrl('C:\\projects\\odeysys\\src\\main\\java\\', f)).toBe('vscode://file/C:/projects/odeysys/src/main/java/com/tt/nc/core/dao/GenericDAOImpl.java:468');
    expect(vscodeUrl('/home/me/odeysys/src/main/java', f)).toBe('vscode://file/home/me/odeysys/src/main/java/com/tt/nc/core/dao/GenericDAOImpl.java:468');
  });

  it('an old frame without a package opens by file name in IntelliJ and has no VS Code path', () => {
    const f = parseCodeFrame('GenericDAOImpl.fetchWithHQL(GenericDAOImpl.java:468)')!;
    expect(f.path).toBeNull();
    expect(intellijUrl(f)).toBe('http://localhost:63342/api/file?file=GenericDAOImpl.java&line=468');
    expect(vscodeUrl('C:/x', f)).toBeNull();
    expect(parseCodeFrame('CallerChainIT$GenericDao.select(CallerChainIT.java:12)')!.path).toBeNull();
    expect(parseCodeFrame('com.x.Outer$Inner.run(Outer.java:5)')!.path).toBe('com/x/Outer.java');
  });

  it('leaves anything that is not a frame as it is', () => {
    expect(parseCodeFrame('not known')).toBeNull();
    expect(shortFrame('not known')).toBe('not known');
  });
});
