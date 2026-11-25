//! The speech model: SenseVoiceSmall (FunAudioLLM, Alibaba Group; FunASR Model License 1.1) as
//! sherpa-onnx exports it, int8. It is fetched once into `<models>/sense-voice-2024-07-17` the
//! first time someone dictates: resumed when cut, checked against its sha256, then renamed into
//! place, the way the app fetches its components (src-tauri/src/components.rs).
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    time::Duration,
};

const REPO: &str =
    "https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/2365baeacb507f821a0c8120fcee3d484dba7a07";
const FOLDER: &str = "sense-voice-2024-07-17";

struct Part {
    name: &'static str,
    size: u64,
    sha256: &'static str,
}

const PARTS: [Part; 2] = [
    Part { name: "tokens.txt", size: 315_894, sha256: "f449eb28dc567533d7fa59be34e2abca8784f771850c78a47fb731a31429a1dc" },
    Part { name: "model.int8.onnx", size: 239_233_841, sha256: "c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51" },
];

/// The model's folder, fetched first when it isn't all there. `progress` gets 0…1 while it
/// downloads (not called when nothing is missing).
pub fn ensure(models: &Path, progress: &mut dyn FnMut(f64)) -> Result<PathBuf, String> {
    let dir = models.join(FOLDER);
    let missing: Vec<&Part> = PARTS.iter().filter(|p| fs::metadata(dir.join(p.name)).map(|m| m.len()).ok() != Some(p.size)).collect();
    if missing.is_empty() {
        return Ok(dir);
    }
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .user_agent(concat!("ondra-dictate/", env!("CARGO_PKG_VERSION")))
        .timeout_connect(Some(Duration::from_secs(20)))
        .timeout_recv_response(Some(Duration::from_secs(60)))
        .build()
        .into();
    let total: u64 = missing.iter().map(|p| p.size).sum();
    let mut before = 0;
    for p in missing {
        let file = dir.join(p.name);
        let part = dir.join(format!("{}.part", p.name));
        let mut report = |have: u64| progress((before + have) as f64 / total as f64);
        download(&agent, p, &part, &mut report)?;
        fs::rename(&part, &file).map_err(|e| e.to_string())?;
        before += p.size;
    }
    Ok(dir)
}

/// Into `part`, carrying on from what an earlier try left. A part that turns out wrong is thrown
/// away and fetched once more from the start.
fn download(agent: &ureq::Agent, p: &Part, part: &Path, progress: &mut dyn FnMut(u64)) -> Result<(), String> {
    let mut fresh = false;
    loop {
        fetch(agent, p, part, progress)?;
        match verify(part, p.sha256) {
            Ok(()) => return Ok(()),
            Err(e) => {
                let _ = fs::remove_file(part);
                if fresh {
                    return Err(e);
                }
                fresh = true;
            }
        }
    }
}

fn fetch(agent: &ureq::Agent, p: &Part, part: &Path, progress: &mut dyn FnMut(u64)) -> Result<(), String> {
    let mut have = fs::metadata(part).map(|m| m.len()).unwrap_or(0);
    if have > p.size {
        let _ = fs::remove_file(part);
        have = 0;
    }
    if have == p.size {
        return Ok(());
    }
    let mut req = agent.get(format!("{REPO}/{}", p.name));
    if have > 0 {
        req = req.header("Range", format!("bytes={have}-"));
    }
    let res = match req.call() {
        Ok(res) => res,
        // what we have can't be carried on: start over next time
        Err(ureq::Error::StatusCode(416)) => {
            let _ = fs::remove_file(part);
            return Err("range not satisfiable".into());
        }
        Err(e) => return Err(e.to_string()),
    };
    let append = match res.status().as_u16() {
        206 if have > 0 => true,
        200 => false,
        s => return Err(format!("HTTP {s}")),
    };
    if !append {
        have = 0;
    }
    let mut file = OpenOptions::new().create(true).write(true).append(append).truncate(!append).open(part).map_err(|e| e.to_string())?;
    let mut body = res.into_body().into_reader();
    let mut buf = vec![0u8; 1 << 16];
    loop {
        let n = body.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        file.write_all(&buf[..n]).map_err(|e| e.to_string())?;
        have += n as u64;
        if have > p.size {
            drop(file);
            let _ = fs::remove_file(part);
            return Err("more bytes than expected".into());
        }
        progress(have);
    }
    file.flush().map_err(|e| e.to_string())
}

fn verify(path: &Path, sha256: &str) -> Result<(), String> {
    let mut file = File::open(path).map_err(|e| e.to_string())?;
    let mut hash = Sha256::new();
    let mut buf = vec![0u8; 1 << 16];
    loop {
        let n = file.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        hash.update(&buf[..n]);
    }
    let got: String = hash.finalize().iter().map(|b| format!("{b:02x}")).collect();
    if got == sha256 {
        Ok(())
    } else {
        Err(format!("checksum mismatch for {}", path.display()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_part_is_checked_against_its_sha256() {
        let dir = std::env::temp_dir().join(format!("ondra-dictate-test-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join("abc");
        fs::write(&file, b"abc").unwrap();
        assert!(verify(&file, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad").is_ok());
        assert!(verify(&file, &"0".repeat(64)).is_err());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn a_model_already_there_downloads_nothing() {
        let dir = std::env::temp_dir().join(format!("ondra-dictate-here-{}", std::process::id()));
        let folder = dir.join(FOLDER);
        fs::create_dir_all(&folder).unwrap();
        for p in &PARTS {
            File::create(folder.join(p.name)).unwrap().set_len(p.size).unwrap();
        }
        let mut called = false;
        assert_eq!(ensure(&dir, &mut |_| called = true).unwrap(), folder);
        assert!(!called);
        let _ = fs::remove_dir_all(dir);
    }
}
