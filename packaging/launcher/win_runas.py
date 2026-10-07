"""
win_runas.py - Windows: who owns a process, and running a command AS that owner (the counterpart of Linux's
"runuser -u OWNER --" in attach_cli.as_user).

Alfred's Windows service runs as LocalSystem; the app it attaches to runs as whoever started it (a developer's
WildFly from the IDE). A JVM only lists, and only accepts an attach from, its own user (spike S2), so attach-cli has to
run as the app's owner. A privileged caller (LocalSystem, or an elevated administrator) borrows the app process's own
token - nothing is logged on, no password is needed - and starts attach-cli with it, in the owner's own environment
(their TEMP holds the hsperfdata the JVM list reads) plus the ALFRED_AGENT_* values the caller passes.

ctypes only: the bundled Python has no pywin32. Every function answers None/False instead of raising when Windows says
no, so a caller falls back to running as itself and reports what attach-cli says.
"""

import ctypes
import os
import subprocess
import tempfile
from ctypes import wintypes

PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
TOKEN_ASSIGN_PRIMARY, TOKEN_DUPLICATE, TOKEN_QUERY, TOKEN_ADJUST_PRIVILEGES = 0x0001, 0x0002, 0x0008, 0x0020
MAXIMUM_ALLOWED = 0x02000000
TOKEN_USER_CLASS, TOKEN_SESSION_ID_CLASS, TOKEN_ELEVATION_CLASS = 1, 12, 20
SECURITY_IMPERSONATION, TOKEN_PRIMARY = 2, 1
CREATE_UNICODE_ENVIRONMENT, CREATE_NO_WINDOW = 0x00000400, 0x08000000
STARTF_USESTDHANDLES = 0x00000100
SE_PRIVILEGE_ENABLED = 0x00000002
WAIT_TIMEOUT = 0x00000102
ERROR_PRIVILEGE_NOT_HELD = 1314
LOCAL_SYSTEM_SID = "S-1-5-18"
TIMEOUT_SECONDS = 120


class STARTUPINFOW(ctypes.Structure):
    _fields_ = [("cb", wintypes.DWORD), ("lpReserved", wintypes.LPWSTR), ("lpDesktop", wintypes.LPWSTR),
                ("lpTitle", wintypes.LPWSTR), ("dwX", wintypes.DWORD), ("dwY", wintypes.DWORD),
                ("dwXSize", wintypes.DWORD), ("dwYSize", wintypes.DWORD), ("dwXCountChars", wintypes.DWORD),
                ("dwYCountChars", wintypes.DWORD), ("dwFillAttribute", wintypes.DWORD), ("dwFlags", wintypes.DWORD),
                ("wShowWindow", wintypes.WORD), ("cbReserved2", wintypes.WORD), ("lpReserved2", ctypes.c_void_p),
                ("hStdInput", wintypes.HANDLE), ("hStdOutput", wintypes.HANDLE), ("hStdError", wintypes.HANDLE)]


class PROCESS_INFORMATION(ctypes.Structure):
    _fields_ = [("hProcess", wintypes.HANDLE), ("hThread", wintypes.HANDLE),
                ("dwProcessId", wintypes.DWORD), ("dwThreadId", wintypes.DWORD)]


class LUID(ctypes.Structure):
    _fields_ = [("LowPart", wintypes.DWORD), ("HighPart", wintypes.LONG)]


class LUID_AND_ATTRIBUTES(ctypes.Structure):
    _fields_ = [("Luid", LUID), ("Attributes", wintypes.DWORD)]


class TOKEN_PRIVILEGES(ctypes.Structure):
    _fields_ = [("PrivilegeCount", wintypes.DWORD), ("Privileges", LUID_AND_ATTRIBUTES * 1)]


def _dlls():
    k = ctypes.WinDLL("kernel32", use_last_error=True)
    a = ctypes.WinDLL("advapi32", use_last_error=True)
    u = ctypes.WinDLL("userenv", use_last_error=True)
    k.OpenProcess.restype = wintypes.HANDLE
    k.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    k.GetCurrentProcess.restype = wintypes.HANDLE
    k.CloseHandle.argtypes = [wintypes.HANDLE]
    k.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
    k.WaitForSingleObject.restype = wintypes.DWORD
    k.GetExitCodeProcess.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
    k.TerminateProcess.argtypes = [wintypes.HANDLE, wintypes.UINT]
    k.LocalFree.argtypes = [ctypes.c_void_p]
    a.OpenProcessToken.argtypes = [wintypes.HANDLE, wintypes.DWORD, ctypes.POINTER(wintypes.HANDLE)]
    a.GetTokenInformation.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD,
                                      ctypes.POINTER(wintypes.DWORD)]
    a.LookupAccountSidW.argtypes = [wintypes.LPCWSTR, ctypes.c_void_p, wintypes.LPWSTR, ctypes.POINTER(wintypes.DWORD),
                                    wintypes.LPWSTR, ctypes.POINTER(wintypes.DWORD), ctypes.POINTER(wintypes.DWORD)]
    a.ConvertSidToStringSidW.argtypes = [ctypes.c_void_p, ctypes.POINTER(wintypes.LPWSTR)]
    a.DuplicateTokenEx.argtypes = [wintypes.HANDLE, wintypes.DWORD, ctypes.c_void_p, ctypes.c_int, ctypes.c_int,
                                   ctypes.POINTER(wintypes.HANDLE)]
    a.LookupPrivilegeValueW.argtypes = [wintypes.LPCWSTR, wintypes.LPCWSTR, ctypes.POINTER(LUID)]
    a.AdjustTokenPrivileges.argtypes = [wintypes.HANDLE, wintypes.BOOL, ctypes.POINTER(TOKEN_PRIVILEGES), wintypes.DWORD,
                                        ctypes.c_void_p, ctypes.c_void_p]
    a.CreateProcessAsUserW.argtypes = [wintypes.HANDLE, wintypes.LPCWSTR, wintypes.LPWSTR, ctypes.c_void_p,
                                       ctypes.c_void_p, wintypes.BOOL, wintypes.DWORD, ctypes.c_void_p, wintypes.LPCWSTR,
                                       ctypes.POINTER(STARTUPINFOW), ctypes.POINTER(PROCESS_INFORMATION)]
    a.CreateProcessWithTokenW.argtypes = [wintypes.HANDLE, wintypes.DWORD, wintypes.LPCWSTR, wintypes.LPWSTR,
                                          wintypes.DWORD, ctypes.c_void_p, wintypes.LPCWSTR,
                                          ctypes.POINTER(STARTUPINFOW), ctypes.POINTER(PROCESS_INFORMATION)]
    u.CreateEnvironmentBlock.argtypes = [ctypes.POINTER(ctypes.c_void_p), wintypes.HANDLE, wintypes.BOOL]
    u.DestroyEnvironmentBlock.argtypes = [ctypes.c_void_p]
    return k, a, u


_LIBS = None


def _libs():
    global _LIBS
    if _LIBS is None:
        _LIBS = _dlls()
    return _LIBS


def _process_token(pid, access):
    """The token of {pid} (None = this process) opened for {access}, or None."""
    k, a, _ = _libs()
    if pid is None:
        process, own = k.GetCurrentProcess(), False
    else:
        process, own = k.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, int(pid)), True
        if not process:
            return None
    try:
        token = wintypes.HANDLE()
        return token if a.OpenProcessToken(process, access, ctypes.byref(token)) else None
    finally:
        if own:
            k.CloseHandle(process)


def _token_info(token, info_class):
    _, a, _ = _libs()
    size = wintypes.DWORD()
    a.GetTokenInformation(token, info_class, None, 0, ctypes.byref(size))
    if not size.value:
        return None
    buf = ctypes.create_string_buffer(size.value)
    return buf if a.GetTokenInformation(token, info_class, buf, size, ctypes.byref(size)) else None


def _token_sid(token):
    buf = _token_info(token, TOKEN_USER_CLASS)
    return None if buf is None else (buf, ctypes.c_void_p.from_buffer(buf).value)  # TOKEN_USER starts with its PSID


def _account(token):
    sid = _token_sid(token)
    if sid is None:
        return None
    _, a, _ = _libs()
    name, domain = ctypes.create_unicode_buffer(256), ctypes.create_unicode_buffer(256)
    nlen, dlen, use = wintypes.DWORD(256), wintypes.DWORD(256), wintypes.DWORD()
    if not a.LookupAccountSidW(None, sid[1], name, ctypes.byref(nlen), domain, ctypes.byref(dlen), ctypes.byref(use)):
        return None
    return f"{domain.value}\\{name.value}" if domain.value else name.value


def _sid_string(token):
    sid = _token_sid(token)
    if sid is None:
        return None
    k, a, _ = _libs()
    text = wintypes.LPWSTR()
    if not a.ConvertSidToStringSidW(sid[1], ctypes.byref(text)):
        return None
    try:
        return text.value
    finally:
        k.LocalFree(text)


def _with_token(pid, access, fn):
    token = _process_token(pid, access)
    if token is None:
        return None
    try:
        return fn(token)
    finally:
        _libs()[0].CloseHandle(token)


def process_user(pid):
    """DOMAIN\\name {pid} runs as, or None when Windows will not say (another user's process, unprivileged)."""
    try:
        return _with_token(pid, TOKEN_QUERY, _account)
    except OSError:
        return None


def current_user():
    try:
        return _with_token(None, TOKEN_QUERY, _account)
    except OSError:
        return None


def is_privileged():
    """LocalSystem (the service) or an elevated administrator: may borrow another user's token."""
    def check(token):
        if _sid_string(token) == LOCAL_SYSTEM_SID:
            return True
        buf = _token_info(token, TOKEN_ELEVATION_CLASS)
        return buf is not None and wintypes.DWORD.from_buffer(buf).value != 0
    try:
        return bool(_with_token(None, TOKEN_QUERY, check))
    except OSError:
        return False


def _enable_privileges(*names):
    """Best effort: CreateProcessAsUserW wants these enabled, and LocalSystem holds them disabled."""
    _, a, _ = _libs()
    token = _process_token(None, TOKEN_ADJUST_PRIVILEGES | TOKEN_QUERY)
    if token is None:
        return
    try:
        for name in names:
            tp = TOKEN_PRIVILEGES(1)
            if a.LookupPrivilegeValueW(None, name, ctypes.byref(tp.Privileges[0].Luid)):
                tp.Privileges[0].Attributes = SE_PRIVILEGE_ENABLED
                a.AdjustTokenPrivileges(token, False, ctypes.byref(tp), 0, None, None)
    finally:
        _libs()[0].CloseHandle(token)


def _environment(token, extra):
    """The owner's own environment (their TEMP, USERPROFILE...) with {extra} on top, as a CreateProcess block."""
    k, _, u = _libs()
    env = {}
    block = ctypes.c_void_p()
    if u.CreateEnvironmentBlock(ctypes.byref(block), token, False):
        try:
            offset = 0
            while True:
                entry = ctypes.wstring_at(block.value + offset)
                if not entry:
                    break
                offset += (len(entry) + 1) * ctypes.sizeof(ctypes.c_wchar)
                key, sep, value = entry.partition("=")
                if sep and key:
                    env[key] = value
        finally:
            u.DestroyEnvironmentBlock(block)
    env.update(extra)
    text = "\0".join(f"{k}={v}" for k, v in sorted(env.items(), key=lambda kv: kv[0].upper())) + "\0\0"
    return ctypes.create_unicode_buffer(text, len(text))


def run_as_owner(pid, argv, extra_env=None, cwd=None):
    """Runs {argv} as the user {pid} runs as and waits for it: a CompletedProcess with the output decoded, or None
    when the owner's token cannot be borrowed (the caller is not privileged, or {pid} is gone)."""
    k, a, _ = _libs()
    source = _process_token(pid, TOKEN_DUPLICATE | TOKEN_QUERY | TOKEN_ASSIGN_PRIMARY)
    if source is None:
        return None
    primary = wintypes.HANDLE()
    try:
        if not a.DuplicateTokenEx(source, MAXIMUM_ALLOWED, None, SECURITY_IMPERSONATION, TOKEN_PRIMARY, ctypes.byref(primary)):
            return None
    finally:
        k.CloseHandle(source)
    import msvcrt
    out = tempfile.TemporaryFile()
    err = tempfile.TemporaryFile()
    nul = open(os.devnull, "rb")
    try:
        handles = [msvcrt.get_osfhandle(f.fileno()) for f in (nul, out, err)]
        for h in handles:
            os.set_handle_inheritable(h, True)
        si = STARTUPINFOW()
        si.cb = ctypes.sizeof(si)
        si.dwFlags = STARTF_USESTDHANDLES
        si.hStdInput, si.hStdOutput, si.hStdError = handles
        session = _token_info(primary, TOKEN_SESSION_ID_CLASS)
        if session is not None and wintypes.DWORD.from_buffer(session).value != 0:
            desktop = ctypes.create_unicode_buffer("winsta0\\default")
            si.lpDesktop = ctypes.cast(desktop, wintypes.LPWSTR)  # the owner's desktop, not the service's
        env = _environment(primary, extra_env or {})
        command = ctypes.create_unicode_buffer(subprocess.list2cmdline(argv))
        pi = PROCESS_INFORMATION()
        flags = CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW
        _enable_privileges("SeAssignPrimaryTokenPrivilege", "SeIncreaseQuotaPrivilege")
        ok = a.CreateProcessAsUserW(primary, None, command, None, None, True, flags, env, cwd, ctypes.byref(si), ctypes.byref(pi))
        if not ok and ctypes.get_last_error() == ERROR_PRIVILEGE_NOT_HELD:
            # An elevated administrator lacks SeAssignPrimaryToken but holds SeImpersonate, which this one needs.
            ok = a.CreateProcessWithTokenW(primary, 0, None, command, flags, env, cwd, ctypes.byref(si), ctypes.byref(pi))
        if not ok:
            raise ctypes.WinError(ctypes.get_last_error())
        try:
            code = wintypes.DWORD(1)
            if k.WaitForSingleObject(pi.hProcess, TIMEOUT_SECONDS * 1000) == WAIT_TIMEOUT:
                k.TerminateProcess(pi.hProcess, 1)
                k.WaitForSingleObject(pi.hProcess, 5000)
            k.GetExitCodeProcess(pi.hProcess, ctypes.byref(code))
        finally:
            k.CloseHandle(pi.hThread)
            k.CloseHandle(pi.hProcess)
        out.seek(0)
        err.seek(0)
        return subprocess.CompletedProcess(argv, code.value, out.read().decode("utf-8", "replace"),
                                           err.read().decode("utf-8", "replace"))
    finally:
        k.CloseHandle(primary)
        for f in (nul, out, err):
            f.close()
