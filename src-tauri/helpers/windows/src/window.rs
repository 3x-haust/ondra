//! Bind to an existing main window, never to whatever happens to be focused later.
use super::*;
use std::mem::size_of;
use windows::core::{BOOL, PWSTR};
use windows::Win32::{
    Foundation::*,
    Graphics::{Dwm::*, Gdi::*},
    Security::*,
    System::SystemInformation::GetTickCount,
    System::{RemoteDesktop::*, StationsAndDesktops::*, Threading::*},
    UI::{
        Input::KeyboardAndMouse::{GetLastInputInfo, IsWindowEnabled, LASTINPUTINFO},
        WindowsAndMessaging::*,
    },
};

pub(super) struct Owned(HANDLE);
impl Drop for Owned {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseHandle(self.0);
        }
    }
}

unsafe fn token<T: Default>(h: HANDLE, class: TOKEN_INFORMATION_CLASS) -> Result<T> {
    let mut value = T::default();
    let mut n = 0;
    GetTokenInformation(
        h,
        class,
        Some((&mut value as *mut T).cast()),
        size_of::<T>() as u32,
        &mut n,
    )
    .checked()?;
    require(n as usize == size_of::<T>())?;
    Ok(value)
}
unsafe fn logon(h: HANDLE) -> Result<LUID> {
    let mut t = HANDLE::default();
    OpenProcessToken(h, TOKEN_QUERY, &mut t).checked()?;
    let t = Owned(t);
    require(token::<u32>(t.0, TokenElevation)? == 0 && token::<u32>(t.0, TokenUIAccess)? == 0)?;
    Ok(token::<TOKEN_STATISTICS>(t.0, TokenStatistics)?.AuthenticationId)
}
unsafe fn desktop_name(h: HANDLE) -> Result<String> {
    let mut buf = [0u16; 128];
    GetUserObjectInformationW(h, UOI_NAME, Some(buf.as_mut_ptr().cast()), 256, None).checked()?;
    Ok(String::from_utf16_lossy(
        &buf[..buf.iter().position(|v| *v == 0).ok_or(UNSAFE)?],
    ))
}
unsafe fn interactive(thread: u32, pid: u32) -> Result<()> {
    let mut session = 0;
    let mut ours = 0;
    ProcessIdToSessionId(pid, &mut session).checked()?;
    ProcessIdToSessionId(GetCurrentProcessId(), &mut ours).checked()?;
    require(session != 0 && session == ours)?;
    let mut ptr = PWSTR::null();
    let mut size = 0;
    WTSQuerySessionInformationW(None, session, WTSConnectState, &mut ptr, &mut size).checked()?;
    let active = size as usize == size_of::<WTS_CONNECTSTATE_CLASS>()
        && !ptr.is_null()
        && *ptr.0.cast::<WTS_CONNECTSTATE_CLASS>() == WTSActive;
    WTSFreeMemory(ptr.0.cast());
    require(
        active
            && desktop_name(HANDLE(GetProcessWindowStation().checked()?.0))?
                .eq_ignore_ascii_case("WinSta0"),
    )?;
    let desktop = HANDLE(GetThreadDesktop(thread).checked()?.0);
    let mut input = BOOL::default();
    GetUserObjectInformationW(
        desktop,
        UOI_IO,
        Some((&mut input as *mut BOOL).cast()),
        4,
        None,
    )
    .checked()?;
    require(input.as_bool() && desktop_name(desktop)?.eq_ignore_ascii_case("Default"))
}

pub(super) struct Window {
    pub hwnd: HWND,
    pub pid: u32,
    process: Owned,
}
unsafe extern "system" fn visible(hwnd: HWND, l: LPARAM) -> BOOL {
    if IsWindowVisible(hwnd).as_bool() {
        (*(l.0 as *mut Vec<HWND>)).push(hwnd);
    }
    true.into()
}
impl Window {
    pub unsafe fn attach(app: &str) -> Result<Self> {
        let host_pid = std::env::var("ONDRA_COMPUTER_HOST_APP_PID")
            .ok()
            .and_then(|v| v.parse::<u32>().ok())
            .filter(|n| *n > 0)
            .ok_or(UNSAFE)?;
        let mut found = None;
        let mut wins: Vec<HWND> = Vec::new();
        EnumWindows(
            Some(visible),
            LPARAM((&mut wins as *mut Vec<HWND>) as isize),
        )
        .checked()?;
        for hwnd in wins {
            let mut pid = 0;
            GetWindowThreadProcessId(hwnd, Some(&mut pid));
            if pid == host_pid
                || pid == GetCurrentProcessId()
                || GetAncestor(hwnd, GA_ROOTOWNER) != hwnd
                || IsIconic(hwnd).as_bool()
            {
                continue;
            }
            let Ok(handle) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else {
                continue;
            };
            let process = Owned(handle);
            let mut path = [0u16; 32768];
            let mut len = path.len() as u32;
            if QueryFullProcessImageNameW(
                handle,
                PROCESS_NAME_WIN32,
                PWSTR(path.as_mut_ptr()),
                &mut len,
            )
            .is_err()
            {
                continue;
            }
            if !String::from_utf16_lossy(&path[..len as usize])
                .rsplit('\\')
                .next()
                .is_some_and(|n| n.eq_ignore_ascii_case(app))
            {
                continue;
            }
            if found.is_some() {
                return Err("AMBIGUOUS_APP");
            }
            found = Some(Self { hwnd, pid, process });
        }
        let w = found.ok_or("APP_NOT_FOUND")?;
        w.check()?;
        Ok(w)
    }
    pub unsafe fn check_user_idle(&self) -> Result<()> {
        let mut pid = 0;
        GetWindowThreadProcessId(GetForegroundWindow(), Some(&mut pid));
        if pid == self.pid {
            let mut input = LASTINPUTINFO {
                cbSize: size_of::<LASTINPUTINFO>() as u32,
                ..Default::default()
            };
            require(GetLastInputInfo(&mut input).as_bool())?;
            if GetTickCount().wrapping_sub(input.dwTime) < 700 {
                return Err("USER_ACTIVE");
            }
        }
        Ok(())
    }
    pub unsafe fn check(&self) -> Result<()> {
        let (h, process) = (self.hwnd, self.process.0);
        let mut pid = 0;
        let thread = GetWindowThreadProcessId(h, Some(&mut pid));
        require(
            thread != 0
                && pid == self.pid
                && IsWindowVisible(h).as_bool()
                && !IsIconic(h).as_bool()
                && IsWindowEnabled(h).as_bool()
                && GetAncestor(h, GA_ROOTOWNER) == h
                && GetLastActivePopup(h) == h
                && !MonitorFromWindow(h, MONITOR_DEFAULTTONULL).is_invalid(),
        )?;
        interactive(thread, pid)?;
        require(logon(GetCurrentProcess())? == logon(process)?)?;
        let mut protection = PROCESS_PROTECTION_LEVEL_INFORMATION::default();
        GetProcessInformation(
            process,
            ProcessProtectionLevelInfo,
            (&mut protection as *mut PROCESS_PROTECTION_LEVEL_INFORMATION).cast(),
            size_of::<PROCESS_PROTECTION_LEVEL_INFORMATION>() as u32,
        )
        .checked()?;
        require(protection.ProtectionLevel == PROTECTION_LEVEL_NONE)?;
        let mut cloak = 0u32;
        DwmGetWindowAttribute(h, DWMWA_CLOAKED, (&mut cloak as *mut u32).cast(), 4).checked()?;
        let mut affinity = 0;
        GetWindowDisplayAffinity(h, &mut affinity).checked()?;
        let mut class = [0u16; 256];
        let n = GetClassNameW(h, &mut class);
        let style = GetWindowLongW(h, GWL_STYLE) as u32;
        let ex = GetWindowLongW(h, GWL_EXSTYLE) as u32;
        require(
            cloak == 0
                && affinity == 0
                && n > 0
                && &class[..n as usize] != "#32770".encode_utf16().collect::<Vec<_>>()
                && style & (WS_CHILD.0 | WS_POPUP.0) == 0
                && style & WS_CAPTION.0 == WS_CAPTION.0
                && ex & (WS_EX_TOOLWINDOW.0 | WS_EX_DLGMODALFRAME.0 | WS_EX_TOPMOST.0) == 0,
        )
    }
}
