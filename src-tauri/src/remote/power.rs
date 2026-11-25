use std::{
    io,
    os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle},
    sync::Mutex,
};
use windows_sys::Win32::{
    Foundation::INVALID_HANDLE_VALUE,
    System::{
        Power::{
            PowerClearRequest, PowerCreateRequest, PowerRequestSystemRequired, PowerSetRequest,
        },
        Threading::{POWER_REQUEST_CONTEXT_SIMPLE_STRING, REASON_CONTEXT, REASON_CONTEXT_0},
    },
};

static REQUEST: Mutex<Option<OwnedHandle>> = Mutex::new(None);

pub(super) fn keep_awake(on: bool) -> io::Result<()> {
    let mut slot = REQUEST
        .lock()
        .map_err(|e| io::Error::other(e.to_string()))?;
    match (on, slot.as_ref()) {
        (true, None) => {
            let mut reason: Vec<u16> = "Ondra remote hosting\0".encode_utf16().collect();
            let context = REASON_CONTEXT {
                Version: 0,
                Flags: POWER_REQUEST_CONTEXT_SIMPLE_STRING,
                Reason: REASON_CONTEXT_0 {
                    SimpleReasonString: reason.as_mut_ptr(),
                },
            };
            // SAFETY: the NUL-terminated reason lives through creation; the returned handle is ours.
            let raw = unsafe { PowerCreateRequest(&context) };
            if raw == INVALID_HANDLE_VALUE {
                return Err(io::Error::last_os_error());
            }
            let handle = unsafe { OwnedHandle::from_raw_handle(raw) };
            if unsafe { PowerSetRequest(handle.as_raw_handle(), PowerRequestSystemRequired) } == 0 {
                return Err(io::Error::last_os_error());
            }
            *slot = Some(handle);
        }
        (false, Some(handle)) => {
            if unsafe { PowerClearRequest(handle.as_raw_handle(), PowerRequestSystemRequired) } == 0
            {
                return Err(io::Error::last_os_error());
            }
            *slot = None;
        }
        _ => {}
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn repeated_settings_hold_and_release_one_system_request() {
        for enabled in [false, true, true, false, false] {
            super::keep_awake(enabled).unwrap();
            assert_eq!(super::REQUEST.lock().unwrap().is_some(), enabled);
        }
    }
}
