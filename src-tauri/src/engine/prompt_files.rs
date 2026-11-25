use std::{fs, io::{self, Write}, path::Path};
use tempfile::NamedTempFile;

/// Pi accepts a filename for each --append-system-prompt (including on resource reload).
/// Keep each section separate, in order; no prompt text goes in the Windows command line.
pub(super) fn prepare(args: &mut [String], local_app_data: &Path) -> io::Result<Vec<NamedTempFile>> {
    let mut files = Vec::new();
    let dir = local_app_data.join("engine-prompts"); // inherits the user's LocalAppData ACL, never the job's cwd or %TEMP%
    let mut it = args.iter_mut();
    while let Some(arg) = it.next() {
        if arg != "--append-system-prompt" { continue; }
        let text = it.next().ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "missing prompt"))?;
        fs::create_dir_all(&dir)?;
        let mut file = tempfile::Builder::new().prefix("prompt-").make_in(&dir, |path| {
            let mut opts = fs::OpenOptions::new();
            opts.write(true).create_new(true);
            #[cfg(windows)]
            {
                use std::os::windows::fs::OpenOptionsExt;
                // Read sharing for the engine; delete on the last handle close even if Ondra crashes.
                opts.share_mode(0x1 | 0x4).custom_flags(0x04000000); // FILE_SHARE_READ | DELETE, FILE_FLAG_DELETE_ON_CLOSE
            }
            #[cfg(unix)]
            { use std::os::unix::fs::OpenOptionsExt; opts.mode(0o600); }
            opts.open(path)
        })?;
        file.write_all(text.as_bytes())?;
        *text = file.path().to_str().ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "invalid prompt path"))?.to_owned();
        files.push(file);
    }
    Ok(files)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn long_prompts_round_trip_in_order_outside_argv_and_disappear_on_drop() {
        let app = tempfile::tempdir().unwrap();
        let long = "긴 지침🪟\r\n".repeat(8000);
        let mut args = vec!["--append-system-prompt".into(), long.clone(), "--no-skills".into(), "--append-system-prompt".into(), "두 번째\n".into()];
        assert!(args.join(" ").encode_utf16().count() > 32767);
        let files = prepare(&mut args, app.path()).unwrap();
        assert!(args.join(" ").encode_utf16().count() < 32767);
        assert_eq!(args[2], "--no-skills");
        assert_eq!(fs::read_to_string(&args[1]).unwrap(), long);
        assert_eq!(fs::read_to_string(&args[4]).unwrap(), "두 번째\n");
        assert!(Path::new(&args[1]).starts_with(app.path()));
        drop(files);
        assert!(!Path::new(&args[1]).exists() && !Path::new(&args[4]).exists());
    }

    #[test]
    fn failure_cleanly_releases_files_already_written() {
        let app = tempfile::tempdir().unwrap();
        let mut args = ["--append-system-prompt".into(), "first".into(), "--append-system-prompt".into()];
        assert!(prepare(&mut args, app.path()).is_err());
        assert!(!Path::new(&args[1]).exists());
    }
}
