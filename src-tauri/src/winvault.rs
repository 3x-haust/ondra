//! Windows user-scoped DPAPI. Only ciphertext reaches either the destination or its temporary file.
use std::{
    fs,
    io::{self, Write},
    path::{Path, PathBuf},
    ptr,
};
use windows_sys::Win32::{
    Foundation::LocalFree,
    Security::Cryptography::{
        CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN, CryptProtectData, CryptUnprotectData,
    },
};

pub const FOLDER: &str = "dev.3xhaust.ondra/vault";

pub fn file(name: &str) -> io::Result<PathBuf> {
    Ok(dirs::data_local_dir()
        .ok_or_else(|| io::Error::other("LocalAppData unavailable"))?
        .join(FOLDER)
        .join(name))
}

fn blob(bytes: &[u8]) -> io::Result<CRYPT_INTEGER_BLOB> {
    Ok(CRYPT_INTEGER_BLOB {
        cbData: bytes
            .len()
            .try_into()
            .map_err(|_| io::Error::other("vault item too large"))?,
        pbData: bytes.as_ptr().cast_mut(),
    })
}

fn dpapi(bytes: &[u8], purpose: &[u8], protect: bool) -> io::Result<Vec<u8>> {
    let input = blob(bytes)?;
    let bound = blob(purpose)?;
    let entropy = if purpose.is_empty() {
        ptr::null()
    } else {
        &bound
    };
    let mut out = CRYPT_INTEGER_BLOB::default();
    // DPAPI borrows the input and owns the output until LocalFree. No machine scope or UI.
    unsafe {
        let ok = if protect {
            CryptProtectData(
                &input,
                ptr::null(),
                entropy,
                ptr::null(),
                ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut out,
            )
        } else {
            CryptUnprotectData(
                &input,
                ptr::null_mut(),
                entropy,
                ptr::null(),
                ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut out,
            )
        };
        if ok == 0 {
            return Err(io::Error::last_os_error());
        }
        let result = if out.cbData == 0 {
            Vec::new()
        } else {
            std::slice::from_raw_parts(out.pbData, out.cbData as usize).to_vec()
        };
        LocalFree(out.pbData.cast());
        Ok(result)
    }
}

pub fn read_bound(path: &Path, purpose: &[u8]) -> io::Result<Vec<u8>> {
    dpapi(&fs::read(path)?, purpose, false)
}
pub fn read_optional(path: &Path) -> io::Result<Option<Vec<u8>>> {
    let encrypted = match fs::read(path) {
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
        other => other?,
    };
    // A missing DPAPI master key is *not* a missing vault. Never overwrite it.
    dpapi(&encrypted, &[], false).map(Some)
}
pub fn write(path: &Path, bytes: &[u8]) -> io::Result<()> {
    write_bound(path, bytes, &[])
}

pub fn write_bound(path: &Path, bytes: &[u8], purpose: &[u8]) -> io::Result<()> {
    let ciphertext = dpapi(bytes, purpose, true)?;
    let dir = path
        .parent()
        .ok_or_else(|| io::Error::other("missing vault directory"))?;
    fs::create_dir_all(dir)?;
    let mut tmp = tempfile::NamedTempFile::new_in(dir)?;
    tmp.write_all(&ciphertext)?;
    tmp.persist(path)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_only_persists_ciphertext_and_rejects_damaged_items() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("vault");
        let value = "시크릿!".repeat(4000);
        write(&path, value.as_bytes()).unwrap();
        let mut bytes = fs::read(&path).unwrap();
        assert!(!bytes.windows(10).any(|w| w == &value.as_bytes()[..10]));
        assert_eq!(read_optional(&path).unwrap().unwrap(), value.as_bytes());
        bytes[0] ^= 1;
        fs::write(&path, bytes).unwrap();
        assert!(read_optional(&path).is_err());
    }
}
