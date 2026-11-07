//! Direct VM process ownership and an engine-child-only admission channel.
//! Preparation is an explicit native operation. Engine admission only observes an
//! already provisioned, directly owned, share-free VM over its pinned SSH channel.
#![cfg(target_os = "macos")]

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    fs::{self, File, OpenOptions},
    io::{self, Read, Seek, Write},
    os::{
        fd::AsRawFd,
        unix::{
            fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
            net::{UnixListener, UnixStream},
        },
    },
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

const FRAME_LIMIT: usize = 16 * 1024;
const IO_TIMEOUT: Duration = Duration::from_secs(5);
const REVOKED: &[u8] = b"{\"version\":1,\"event\":\"revoked\",\"code\":\"GUEST_REVOKED\"}\n";
pub const SOCKET_ENV: &str = "ONDRA_COMPUTER_SOCKET";
type Result<T> = std::result::Result<T, &'static str>;

fn private_directory(path: &Path) -> Result<()> {
    let meta = fs::symlink_metadata(path).map_err(|_| "UNSAFE_DIRECTORY")?;
    if !meta.is_dir()
        || meta.uid() != unsafe { libc::geteuid() }
        || meta.mode() & 0o077 != 0
        || fs::canonicalize(path).map_err(|_| "UNSAFE_DIRECTORY")? != path
    {
        return Err("UNSAFE_DIRECTORY");
    }
    Ok(())
}

fn bounded_frame(reader: &mut impl Read) -> io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    loop {
        let mut byte = [0];
        reader.read_exact(&mut byte)?;
        if byte[0] == b'\n' {
            return Ok(bytes);
        }
        if bytes.len() == FRAME_LIMIT {
            return Err(io::ErrorKind::InvalidData.into());
        }
        bytes.push(byte[0]);
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct ProcessIdentity {
    pid: i32,
    seconds: u64,
    micros: u64,
}
impl ProcessIdentity {
    fn read(pid: i32) -> Result<Self> {
        let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
        let size = std::mem::size_of_val(&info) as i32;
        let got = unsafe {
            libc::proc_pidinfo(
                pid,
                libc::PROC_PIDTBSDINFO,
                0,
                &mut info as *mut _ as *mut libc::c_void,
                size,
            )
        };
        if got != size || info.pbi_uid != unsafe { libc::geteuid() } {
            return Err("ENGINE_IDENTITY_UNAVAILABLE");
        }
        Ok(Self {
            pid,
            seconds: info.pbi_start_tvsec,
            micros: info.pbi_start_tvusec,
        })
    }
    fn matches(&self, socket: &UnixStream) -> bool {
        let mut pid: libc::pid_t = 0;
        let mut size = std::mem::size_of_val(&pid) as libc::socklen_t;
        let got = unsafe {
            libc::getsockopt(
                socket.as_raw_fd(),
                0,
                libc::LOCAL_PEERPID,
                &mut pid as *mut _ as *mut libc::c_void,
                &mut size,
            )
        };
        let mut uid = 0;
        let mut gid = 0;
        got == 0
            && size as usize == std::mem::size_of_val(&pid)
            && pid == self.pid
            && unsafe { libc::getpeereid(socket.as_raw_fd(), &mut uid, &mut gid) } == 0
            && uid == unsafe { libc::geteuid() }
            && Self::read(pid) == Ok(*self)
    }
}

/// Launch parameters are native application input, never socket/tool arguments.
/// Data representations are base64 strings, not a claimed guest hardware UUID.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostLaunch {
    pub version: u8,
    pub vm_directory: PathBuf,
    pub state_directory: PathBuf,
    pub cpu_count: u32,
    pub memory_bytes: u64,
    pub hardware_model: String,
    pub machine_identifier: String,
    pub mac_address: String,
    pub width: u32,
    pub height: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub setup_directory: Option<PathBuf>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub restore_image: Option<PathBuf>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub disk_bytes: Option<u64>,
}

#[link(name = "System")]
unsafe extern "C" {
    fn CC_SHA256(data: *const libc::c_void, len: u32, output: *mut u8) -> *mut u8;
    fn arc4random_buf(buffer: *mut libc::c_void, length: usize);
}
fn digest(data: &[u8]) -> Result<String> {
    let length = u32::try_from(data.len()).map_err(|_| "BINARY_LIMIT")?;
    let mut out = [0u8; 32];
    unsafe {
        CC_SHA256(data.as_ptr().cast(), length, out.as_mut_ptr());
    }
    const HEX: &[u8; 16] = b"0123456789abcdef";
    Ok(out
        .iter()
        .flat_map(|v| {
            [
                HEX[(v >> 4) as usize] as char,
                HEX[(v & 15) as usize] as char,
            ]
        })
        .collect())
}

fn checked_runner(path: &Path, expected_digest: &str) -> Result<File> {
    if fs::canonicalize(path).map_err(|_| "RUNNER_UNAVAILABLE")? != path {
        return Err("UNSAFE_RUNNER");
    }
    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
        .map_err(|_| "RUNNER_UNAVAILABLE")?;
    let meta = file.metadata().map_err(|_| "UNSAFE_RUNNER")?;
    if !meta.is_file()
        || ![0, unsafe { libc::geteuid() }].contains(&meta.uid())
        || meta.mode() & 0o022 != 0
        || meta.nlink() != 1
        || meta.len() > 256 * 1024 * 1024
    {
        return Err("UNSAFE_RUNNER");
    }
    let mut bytes = Vec::new();
    (&mut file)
        .take(256 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "RUNNER_READ_FAILED")?;
    if digest(&bytes)? != expected_digest {
        return Err("RUNNER_BUILD_CHANGED");
    }
    Ok(file)
}

fn random_secret() -> String {
    let mut bytes = [0u8; 32];
    unsafe { arc4random_buf(bytes.as_mut_ptr().cast(), bytes.len()) };
    const HEX: &[u8; 16] = b"0123456789abcdef";
    bytes
        .iter()
        .flat_map(|byte| {
            [
                HEX[(byte >> 4) as usize] as char,
                HEX[(byte & 15) as usize] as char,
            ]
        })
        .collect()
}

/// A one-use installation request, not guest evidence or a lease. Do not log it.
/// Only an authenticated provisioning channel may carry these bytes to the guest.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GuestBootPreparation {
    version: u8,
    task_id: String,
    host_uuid: String,
    boot_nonce: String,
    challenge: String,
    endpoint_sha256: String,
}

/// Owns only the child it spawned. There is intentionally no from_pid/adopt API.
/// Every run leaves a machine-keyed durable fence, even on a normal stop.
pub struct OwnedVm {
    active: Arc<AtomicBool>,
    stop: mpsc::Sender<()>,
    host_uuid: String,
    boot_preparation_started: AtomicBool,
    ended: Arc<AtomicBool>,
    viewer: Arc<AtomicBool>,
    launch: Option<HostLaunch>,
    authority: Mutex<Option<GuestAuthority>>,
    machine_digest: String,
    claimed: AtomicBool,
}
impl OwnedVm {
    /// An explicit, separately approved native operation; never called by register.
    /// expected_digest must come from the signed app's build assets, not a manifest.
    pub fn launch(runner: &Path, expected_digest: &str, launch: HostLaunch) -> Result<Arc<Self>> {
        private_directory(&launch.vm_directory)?;
        private_directory(&launch.state_directory)?;
        let held_binary = checked_runner(runner, expected_digest)?;
        let setup = launch.setup_directory.is_some();
        let input = serde_json::to_vec(&launch).map_err(|_| "INVALID_CONFIGURATION")?;
        if input.len() > FRAME_LIMIT {
            return Err("INVALID_CONFIGURATION");
        }
        let mut child = Command::new(runner)
            .arg("--owned-stdio")
            .env_clear()
            .env("PATH", "/usr/bin:/bin")
            .env("LANG", "C")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|_| "RUNNER_START_FAILED")?;
        let original = held_binary.metadata().map_err(|_| "RUNNER_BUILD_CHANGED");
        let current = fs::symlink_metadata(runner).map_err(|_| "RUNNER_BUILD_CHANGED");
        if !matches!((original, current), (Ok(a), Ok(b)) if a.ino() == b.ino() && a.dev() == b.dev())
        {
            let _ = child.kill();
            let _ = child.wait();
            return Err("RUNNER_BUILD_CHANGED");
        }
        let mut stdin = child.stdin.take().ok_or("RUNNER_PIPE_FAILED")?;
        let mut stdout = child.stdout.take().ok_or("RUNNER_PIPE_FAILED")?;
        let (responses, receive) = mpsc::sync_channel(1);
        thread::spawn(move || {
            while let Ok(frame) = bounded_frame(&mut stdout) {
                if responses.send(frame).is_err() {
                    break;
                }
            }
        });
        if stdin
            .write_all(&input)
            .and_then(|_| stdin.write_all(b"\n"))
            .is_err()
        {
            let _ = child.kill();
            let _ = child.wait();
            return Err("RUNNER_PIPE_FAILED");
        }
        let ready = receive
            .recv_timeout(Duration::from_secs(if setup { 7200 } else { 120 }))
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok());
        let Some(ready) = ready.filter(|v| valid_inspection(v, "ready")) else {
            let _ = child.kill();
            let _ = child.wait();
            return Err("OWNERSHIP_NOT_ESTABLISHED");
        };
        let actual_launch: HostLaunch = match serde_json::from_value(ready["launch"].clone()) {
            Ok(value) => value,
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("OWNERSHIP_NOT_ESTABLISHED");
            }
        };
        if ready["sharingDevices"] != if setup { 1 } else { 0 }
            || ready["macAddress"] != launch.mac_address
            || actual_launch.vm_directory != launch.vm_directory
            || actual_launch.state_directory != launch.state_directory
            || actual_launch.setup_directory != launch.setup_directory
            || (!setup
                && (actual_launch.machine_identifier != launch.machine_identifier
                    || actual_launch.hardware_model != launch.hardware_model))
        {
            let _ = child.kill();
            let _ = child.wait();
            return Err("OWNERSHIP_NOT_ESTABLISHED");
        }
        let host_uuid = ready["hostUuid"]
            .as_str()
            .ok_or("HOST_IDENTITY_UNAVAILABLE")?
            .to_owned();
        let ended = Arc::new(AtomicBool::new(false));
        let worker_ended = ended.clone();
        let viewer = Arc::new(AtomicBool::new(false));
        let worker_viewer = viewer.clone();
        let active = Arc::new(AtomicBool::new(true));
        let worker_active = active.clone();
        let machine_digest = ready["machineIdentifierSha256"]
            .as_str()
            .unwrap()
            .to_owned();
        let (stop, stopping) = mpsc::channel();
        thread::spawn(move || {
            let _held_binary = held_binary;
            let mut sequence = 0u64;
            while matches!(
                stopping.recv_timeout(Duration::from_secs(2)),
                Err(mpsc::RecvTimeoutError::Timeout)
            ) {
                if !matches!(child.try_wait(), Ok(None)) {
                    break;
                }
                sequence += 1;
                let id = sequence.to_string();
                let op = if worker_viewer.swap(false, Ordering::AcqRel) {
                    "viewer"
                } else {
                    "inspect"
                };
                let frame = json!({"version": 1, "id": id, "op": op}).to_string() + "\n";
                if stdin.write_all(frame.as_bytes()).is_err() {
                    break;
                }
                let reply = receive
                    .recv_timeout(IO_TIMEOUT)
                    .ok()
                    .and_then(|b| serde_json::from_slice::<Value>(&b).ok());
                if !reply.is_some_and(|v| {
                    valid_inspection(&v, &id)
                        && [
                            "hostUuid",
                            "machineIdentifierSha256",
                            "configurationSha256",
                            "sharingDevices",
                            "macAddress",
                        ]
                        .iter()
                        .all(|key| v[*key] == ready[*key])
                }) {
                    break;
                }
            }
            worker_active.store(false, Ordering::Release);
            // Killing the owned runner is not proof of an in-flight guest action's outcome.
            // The durable fence remains; no timer or Drop implementation clears it.
            let _ = child.kill();
            if child.wait().is_ok() {
                worker_ended.store(true, Ordering::Release);
            }
        });
        Ok(Arc::new(Self {
            active,
            stop,
            host_uuid,
            boot_preparation_started: AtomicBool::new(false),
            ended,
            viewer,
            launch: Some(actual_launch),
            authority: Mutex::new(None),
            machine_digest,
            claimed: AtomicBool::new(false),
        }))
    }
    /// Explicit preparation only. task_id comes from the native task binding and
    /// endpoint_sha256 from sealed build assets, never model input or a receipt.
    /// This does not authenticate delivery, install anything, or enable register.
    pub fn prepare_guest_boot(
        &self,
        task_id: &str,
        endpoint_sha256: &str,
    ) -> Result<GuestBootPreparation> {
        if task_id.is_empty()
            || task_id.len() > 128
            || !task_id
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"_-".contains(&c))
            || endpoint_sha256.len() != 64
            || !endpoint_sha256
                .bytes()
                .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
        {
            return Err("INVALID_PREPARATION");
        }
        if !self.is_active() {
            return Err("GUEST_REVOKED");
        }
        if self.boot_preparation_started.swap(true, Ordering::AcqRel) {
            return Err("BOOT_PREPARATION_ALREADY_STARTED");
        }
        let request = GuestBootPreparation {
            version: 1,
            task_id: task_id.to_owned(),
            host_uuid: self.host_uuid.clone(),
            boot_nonce: random_secret(),
            challenge: random_secret(),
            endpoint_sha256: endpoint_sha256.to_owned(),
        };
        if !self.is_active() {
            return Err("GUEST_REVOKED");
        }
        Ok(request)
    }
    pub fn quarantine(&self) {
        self.active.store(false, Ordering::Release);
        let _ = self.stop.send(());
    }
    fn is_active(&self) -> bool {
        self.active.load(Ordering::Acquire)
    }
    fn stop_and_wait(&self) -> Result<()> {
        self.quarantine();
        let deadline = Instant::now() + Duration::from_secs(10);
        while !self.ended.load(Ordering::Acquire) {
            if Instant::now() >= deadline {
                return Err("OWNED_PROCESS_NOT_STOPPED");
            }
            thread::sleep(Duration::from_millis(20));
        }
        Ok(())
    }
    fn lease(&self) -> Result<Value> {
        if !self.is_active() {
            return Err("GUEST_REVOKED");
        }
        let lock = self.authority.lock().map_err(|_| "GUEST_REVOKED")?;
        let authority = lock.as_ref().ok_or("GUEST_SETUP_REQUIRED")?;
        if let Err(code) = authority.verify(self) {
            self.quarantine();
            return Err(code);
        }
        let mut metadata = authority.metadata.clone();
        metadata["expiresAt"] = json!(
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_err(|_| "CLOCK_UNAVAILABLE")?
                .as_millis() as u64
                + 45_000
        );
        Ok(metadata)
    }
    fn connection_directory(&self) -> Result<PathBuf> {
        self.lease()?;
        self.authority
            .lock()
            .map_err(|_| "GUEST_REVOKED")?
            .as_ref()
            .map(|a| a.directory.clone())
            .ok_or("GUEST_SETUP_REQUIRED")
    }
}
impl Drop for OwnedVm {
    fn drop(&mut self) {
        self.quarantine();
    }
}
fn valid_inspection(value: &Value, id: &str) -> bool {
    value["version"] == 1
        && value["id"] == id
        && value["state"] == "running"
        && value["hostUuid"].as_str().is_some_and(valid_uuid)
        && ["machineIdentifierSha256", "configurationSha256"]
            .iter()
            .all(|k| {
                value[*k]
                    .as_str()
                    .is_some_and(|s| s.len() == 64 && s.bytes().all(|c| c.is_ascii_hexdigit()))
            })
}

/// Digests are compiled into the signed application, never loaded from a sidecar.
pub struct SealedAsset {
    pub path: PathBuf,
    pub sha256: String,
}
pub struct ComputerAssets {
    pub runner: SealedAsset,
    pub endpoint: SealedAsset,
    pub provisioner: SealedAsset,
    pub installer: SealedAsset,
    pub desktop: SealedAsset,
    pub helper: SealedAsset,
}
pub struct SetupRequest {
    pub directory: PathBuf,
    pub state_directory: PathBuf,
    pub restore_image: PathBuf,
    pub cpu_count: u32,
    pub memory_bytes: u64,
    pub disk_bytes: u64,
    pub width: u32,
    pub height: u32,
}

fn create_private(path: &Path) -> Result<()> {
    use std::os::unix::fs::DirBuilderExt;
    fs::DirBuilder::new()
        .mode(0o700)
        .create(path)
        .map_err(|_| "DIRECTORY_ALREADY_EXISTS")?;
    private_directory(path)
}
fn write_private(path: &Path, bytes: &[u8], mode: u32) -> Result<()> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(mode)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
        .map_err(|_| "PRIVATE_FILE_EXISTS")?;
    file.write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|_| "PRIVATE_WRITE_FAILED")
}
fn read_private(path: &Path, limit: u64) -> Result<Vec<u8>> {
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
        .map_err(|_| "PRIVATE_FILE_UNAVAILABLE")?;
    let meta = file.metadata().map_err(|_| "PRIVATE_FILE_UNAVAILABLE")?;
    if !meta.is_file()
        || meta.uid() != unsafe { libc::geteuid() }
        || meta.mode() & 0o077 != 0
        || meta.nlink() != 1
        || meta.len() > limit
    {
        return Err("UNSAFE_PRIVATE_FILE");
    }
    let mut data = Vec::new();
    file.take(limit + 1)
        .read_to_end(&mut data)
        .map_err(|_| "PRIVATE_READ_FAILED")?;
    if data.len() as u64 > limit {
        return Err("PRIVATE_FILE_LIMIT");
    }
    Ok(data)
}
fn safe_ssh_path(path: &Path) -> Result<String> {
    let value = path.to_str().ok_or("UNSAFE_SSH_PATH")?;
    if !path.is_absolute()
        || value
            .chars()
            .any(|c| c.is_control() || "%$\"'\\".contains(c))
    {
        return Err("UNSAFE_SSH_PATH");
    }
    Ok(value.to_owned())
}

/// No shell, inherited agent, stderr payload or unbounded child/output lifetime.
fn run_bounded(
    mut command: Command,
    input: &[u8],
    timeout: Duration,
    limit: usize,
) -> Result<Vec<u8>> {
    let mut child = command
        .env_clear()
        .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
        .env("LANG", "C")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| "NATIVE_COMMAND_FAILED")?;
    let mut stdin = child.stdin.take().ok_or("NATIVE_PIPE_FAILED")?;
    let stdout = child.stdout.take().ok_or("NATIVE_PIPE_FAILED")?;
    let (send, receive) = mpsc::sync_channel(1);
    thread::spawn(move || {
        let mut data = Vec::new();
        let result = stdout.take(limit as u64 + 1).read_to_end(&mut data);
        let _ = send.send(if result.is_ok() && data.len() <= limit {
            Ok(data)
        } else {
            Err("NATIVE_OUTPUT_LIMIT")
        });
    });
    if stdin.write_all(input).is_err() {
        let _ = child.kill();
        let _ = child.wait();
        return Err("NATIVE_INPUT_FAILED");
    }
    drop(stdin);
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                if !status.success() {
                    return Err("NATIVE_COMMAND_FAILED");
                }
                return receive
                    .recv_timeout(deadline.saturating_duration_since(Instant::now()))
                    .map_err(|_| "NATIVE_COMMAND_TIMEOUT")?;
            }
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(10)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("NATIVE_COMMAND_TIMEOUT");
            }
        }
    }
}
fn keypair(path: &Path) -> Result<String> {
    let mut command = Command::new("/usr/bin/ssh-keygen");
    command
        .args(["-q", "-t", "ed25519", "-N", "", "-C", "", "-f"])
        .arg(path);
    run_bounded(command, &[], Duration::from_secs(5), 4096)?;
    let public =
        fs::read_to_string(path.with_extension("pub")).map_err(|_| "KEY_GENERATION_FAILED")?;
    let fields: Vec<_> = public.split_whitespace().collect();
    if fields.len() != 2 || fields[0] != "ssh-ed25519" || fields[1].len() != 68 {
        return Err("KEY_GENERATION_FAILED");
    }
    Ok(format!("{} {}", fields[0], fields[1]))
}
fn normalize_mac(value: &str) -> Option<String> {
    let parts: Vec<_> = value.split(':').collect();
    if parts.len() != 6 {
        return None;
    }
    parts
        .iter()
        .map(|p| u8::from_str_radix(p, 16).ok().map(|b| format!("{b:02x}")))
        .collect::<Option<Vec<_>>>()
        .map(|v| v.join(":"))
}
fn nat_address(bytes: &[u8], mac: &str) -> Result<String> {
    let mac = normalize_mac(mac).ok_or("INVALID_MAC")?;
    let text = std::str::from_utf8(bytes).map_err(|_| "NAT_ADDRESS_UNAVAILABLE")?;
    let mut matches = Vec::new();
    for line in text.lines() {
        let parts: Vec<_> = line.split_whitespace().collect();
        if parts.len() < 6
            || parts[2] != "at"
            || parts[4] != "on"
            || !parts[5]
                .strip_prefix("bridge")
                .is_some_and(|s| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()))
            || normalize_mac(parts[3]).as_deref() != Some(&mac)
        {
            continue;
        }
        if let Ok(ip) = parts[1]
            .trim_matches(['(', ')'])
            .parse::<std::net::Ipv4Addr>()
        {
            if ip.is_private() {
                matches.push(ip.to_string());
            }
        }
    }
    matches.sort();
    matches.dedup();
    if matches.len() != 1 {
        return Err("NAT_ADDRESS_UNAVAILABLE");
    }
    Ok(matches.remove(0))
}
fn owned_address(mac: &str) -> Result<String> {
    let mut command = Command::new("/usr/sbin/arp");
    command.arg("-an");
    nat_address(
        &run_bounded(command, &[], Duration::from_millis(500), 1024 * 1024)?,
        mac,
    )
}
fn ssh_exchange(
    directory: &Path,
    identity: &Path,
    alias: &str,
    host: &str,
    root: bool,
    request: &Value,
    timeout: Duration,
) -> Result<Value> {
    let mut command = Command::new("/usr/bin/ssh");
    command.args(["-F", "/dev/null", "-T", "-a", "-x"]);
    for option in [
        "BatchMode=yes",
        "StrictHostKeyChecking=yes",
        "GlobalKnownHostsFile=/dev/null",
        "KnownHostsCommand=none",
        "HostKeyAlgorithms=ssh-ed25519",
        "UpdateHostKeys=no",
        "VerifyHostKeyDNS=no",
        "CheckHostIP=no",
        "IdentitiesOnly=yes",
        "IdentityAgent=none",
        "CertificateFile=none",
        "PreferredAuthentications=publickey",
        "PasswordAuthentication=no",
        "KbdInteractiveAuthentication=no",
        "ForwardAgent=no",
        "ForwardX11=no",
        "ClearAllForwardings=yes",
        "Tunnel=no",
        "ProxyCommand=none",
        "ProxyJump=none",
        "PermitLocalCommand=no",
        "ControlMaster=no",
        "ControlPath=none",
        "ControlPersist=no",
        "RequestTTY=no",
        "EscapeChar=none",
        "ConnectionAttempts=1",
        "ConnectTimeout=2",
        "LogLevel=ERROR",
    ] {
        command.args(["-o", option]);
    }
    command
        .arg("-o")
        .arg(format!(
            "UserKnownHostsFile=\"{}\"",
            safe_ssh_path(&directory.join("known_hosts"))?
        ))
        .arg("-o")
        .arg(format!("HostKeyAlias={alias}"))
        .arg("-i")
        .arg(identity)
        .args([
            "-p",
            "2222",
            "-l",
            if root { "root" } else { "ondra-computer" },
            "--",
            host,
        ])
        .arg(if root {
            "/usr/local/libexec/ondra-computer-provision --authenticated-boot"
        } else {
            "/usr/local/libexec/ondra-computer-endpoint"
        });
    let input = serde_json::to_vec(request).map_err(|_| "INVALID_BOOT_REQUEST")?;
    let output = run_bounded(command, &input, timeout, FRAME_LIMIT)?;
    serde_json::from_slice(&output).map_err(|_| "INVALID_GUEST_RESPONSE")
}
fn valid_uuid(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(i, b)| {
            if [8, 13, 18, 23].contains(&i) {
                b == b'-'
            } else {
                b.is_ascii_digit() || (b'a'..=b'f').contains(&b)
            }
        })
}
fn valid_boot_receipt(
    receipt: &Value,
    request: &GuestBootPreparation,
    desktop: &str,
    helper: &str,
) -> bool {
    receipt.as_object().is_some_and(|v| v.len() == 7)
        && receipt["version"] == 1
        && receipt["challenge"] == request.challenge
        && receipt["vmUuid"]
            .as_str()
            .is_some_and(|s| valid_uuid(s) && s != request.host_uuid)
        && receipt["bootSessionUuid"].as_str().is_some_and(valid_uuid)
        && receipt["endpointSha256"] == request.endpoint_sha256
        && receipt["desktopSha256"] == desktop
        && receipt["helperSha256"] == helper
}
fn valid_status(status: &Value, challenge: &str, host: &str, hashes: [&str; 3]) -> bool {
    status.as_object().is_some_and(|v| v.len() == 9)
        && status["version"] == 1
        && status["challenge"] == challenge
        && status["hostUuid"] == host
        && status["vmUuid"]
            .as_str()
            .is_some_and(|s| valid_uuid(s) && s != host)
        && status["bootSessionUuid"].as_str().is_some_and(valid_uuid)
        && status["endpointSha256"] == hashes[0]
        && status["desktopSha256"] == hashes[1]
        && status["helperSha256"] == hashes[2]
        && status["secretConsumed"].is_boolean()
}
fn valid_identity(reply: &Value, metadata: &Value, challenge: &str) -> bool {
    reply.as_object().is_some_and(|v| v.len() == 5)
        && reply["requestId"] == challenge
        && ["version", "taskId", "vmUuid", "bootNonce"]
            .iter()
            .all(|k| reply[*k] == metadata[*k])
}
struct GuestAuthority {
    directory: PathBuf,
    metadata: Value,
    mac: String,
    provision_directory: PathBuf,
    provision_identity: PathBuf,
    provision_identity_digest: String,
    endpoint_digest: String,
    desktop_digest: String,
    helper_digest: String,
    boot_uuid: String,
}
impl GuestAuthority {
    fn verify(&self, vm: &OwnedVm) -> Result<()> {
        if !vm.is_active()
            || vm
                .launch
                .as_ref()
                .is_none_or(|l| l.setup_directory.is_some() || l.mac_address != self.mac)
        {
            return Err("GUEST_REVOKED");
        }
        private_directory(&self.directory)?;
        let host = owned_address(&self.mac)?;
        if self.metadata["host"] != host
            || self.metadata["hostUuid"] != vm.host_uuid
            || self.metadata["identitySha256"]
                != digest(&read_private(&self.directory.join("identity"), 32768)?)?
        {
            return Err("GUEST_IDENTITY_CHANGED");
        }
        let alias = format!(
            "ondra-guest-{}",
            self.metadata["vmUuid"]
                .as_str()
                .ok_or("GUEST_IDENTITY_CHANGED")?
        );
        let pin = format!(
            "{alias} {}\n",
            self.metadata["sshHostKey"]
                .as_str()
                .ok_or("GUEST_IDENTITY_CHANGED")?
        );
        if read_private(&self.directory.join("known_hosts"), 4096)? != pin.as_bytes() {
            return Err("HOST_KEY_CHANGED");
        }
        private_directory(&self.provision_directory)?;
        let root_pin = format!(
            "ondra-enrollment {}\n",
            self.metadata["sshHostKey"]
                .as_str()
                .ok_or("HOST_KEY_CHANGED")?
        );
        if read_private(&self.provision_directory.join("known_hosts"), 4096)? != root_pin.as_bytes()
            || digest(&read_private(&self.provision_identity, 32768)?)?
                != self.provision_identity_digest
        {
            return Err("PROVISION_IDENTITY_CHANGED");
        }
        let status_challenge = random_secret();
        let status = ssh_exchange(
            &self.provision_directory,
            &self.provision_identity,
            "ondra-enrollment",
            &host,
            true,
            &json!({"op":"status","challenge":status_challenge}),
            Duration::from_millis(1500),
        )?;
        if !valid_status(
            &status,
            &status_challenge,
            &vm.host_uuid,
            [
                &self.endpoint_digest,
                &self.desktop_digest,
                &self.helper_digest,
            ],
        ) || status["vmUuid"] != self.metadata["vmUuid"]
            || status["bootSessionUuid"] != self.boot_uuid
            || status["secretConsumed"] != true
        {
            return Err("GUEST_INSTALL_CHANGED");
        }
        let challenge = random_secret();
        let reply = ssh_exchange(
            &self.directory,
            &self.directory.join("identity"),
            &alias,
            &host,
            false,
            &json!({"version":1,"op":"identity","requestId":challenge}),
            Duration::from_millis(1500),
        )?;
        if !valid_identity(&reply, &self.metadata, &challenge)
            || !vm.is_active()
            || owned_address(&self.mac)? != host
        {
            return Err("GUEST_IDENTITY_CHANGED");
        }
        Ok(())
    }
}

/// In-memory enrollment owns the process and generated credentials. It cannot be
/// reconstructed from manifests, receipts, PIDs, directories or a previous app run.
pub struct ComputerSetup {
    assets: ComputerAssets,
    directory: PathBuf,
    server_pin: String,
    secret: String,
    vm: Mutex<Arc<OwnedVm>>,
    files: Vec<(PathBuf, File)>,
    previous_boot: Mutex<Option<(String, String)>>,
}
impl ComputerSetup {
    pub fn prepare(assets: ComputerAssets, request: SetupRequest) -> Result<Self> {
        // Validate all assets and paths before generating credentials or launching anything.
        for asset in [
            &assets.runner,
            &assets.endpoint,
            &assets.provisioner,
            &assets.installer,
            &assets.desktop,
            &assets.helper,
        ] {
            checked_runner(&asset.path, &asset.sha256)?;
        }
        if assets.desktop.sha256
            != "a89c781a3b2cf29bc0467c30a4e1063b6f564858540f2dc58a75c79ce2c9d9f3"
            || assets.helper.sha256
                != "d81e5aa7ad8edb0e3eda72f010b1947ce7d6ad6d6d4ae95a69f4cce39bbbfe63"
        {
            return Err("DESKTOP_BUILD_CHANGED");
        }
        safe_ssh_path(&request.directory)?;
        private_directory(request.directory.parent().ok_or("UNSAFE_DIRECTORY")?)?;
        private_directory(&request.state_directory)?;
        if fs::canonicalize(&request.restore_image).map_err(|_| "RESTORE_IMAGE_UNAVAILABLE")?
            != request.restore_image
        {
            return Err("UNSAFE_RESTORE_IMAGE");
        }
        create_private(&request.directory)?;
        let share = request.directory.join("setup");
        create_private(&share)?;
        let machine = request.directory.join("machine");
        create_private(&machine)?;
        let mut checksums = String::new();
        for (asset, name) in [
            (&assets.endpoint, "ondra-computer-endpoint"),
            (&assets.provisioner, "ondra-computer-provision"),
            (&assets.installer, "install-setup.sh"),
            (&assets.desktop, "agent-desktop"),
            (&assets.helper, "agent-desktop-macos-helper"),
        ] {
            let mut source = checked_runner(&asset.path, &asset.sha256)?;
            source.rewind().map_err(|_| "ASSET_READ_FAILED")?;
            let mut data = Vec::new();
            source
                .read_to_end(&mut data)
                .map_err(|_| "ASSET_READ_FAILED")?;
            if digest(&data)? != asset.sha256 {
                return Err("ASSET_BUILD_CHANGED");
            }
            write_private(&share.join(name), &data, 0o755)?;
            checksums.push_str(&format!("{}  {name}\n", asset.sha256));
        }
        write_private(&share.join("assets.sha256"), checksums.as_bytes(), 0o600)?;
        let client = keypair(&request.directory.join("identity"))?;
        let provision_client = keypair(&request.directory.join("provision-identity"))?;
        write_private(&share.join("client.pub"), client.as_bytes(), 0o600)?;
        write_private(
            &share.join("provision-client.pub"),
            provision_client.as_bytes(),
            0o600,
        )?;
        let server_pin = keypair(&share.join("server-key"))?;
        let entropy = random_secret();
        let mac = format!(
            "02:{}:{}:{}:{}:{}",
            &entropy[0..2],
            &entropy[2..4],
            &entropy[4..6],
            &entropy[6..8],
            &entropy[8..10]
        );
        let vm = OwnedVm::launch(
            &assets.runner.path,
            &assets.runner.sha256,
            HostLaunch {
                version: 1,
                vm_directory: machine.clone(),
                state_directory: request.state_directory,
                cpu_count: request.cpu_count,
                memory_bytes: request.memory_bytes,
                hardware_model: String::new(),
                machine_identifier: String::new(),
                mac_address: mac,
                width: request.width,
                height: request.height,
                setup_directory: Some(share.clone()),
                restore_image: Some(request.restore_image),
                disk_bytes: Some(request.disk_bytes),
            },
        )?;
        let secret = random_secret();
        write_private(
            &share.join("enrollment.json"),
            &serde_json::to_vec(&json!({"version":1,"hostUuid":vm.host_uuid,
            "secret":secret,"endpointSha256":assets.endpoint.sha256}))
            .map_err(|_| "INVALID_ENROLLMENT")?,
            0o600,
        )?;
        let mut files = Vec::new();
        for name in ["config.json", "disk.img", "nvram.bin"] {
            let path = machine.join(name);
            let file = OpenOptions::new()
                .read(true)
                .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
                .open(&path)
                .map_err(|_| "OWNED_FILE_UNAVAILABLE")?;
            files.push((path, file));
        }
        Ok(Self {
            assets,
            directory: request.directory,
            server_pin,
            secret,
            vm: Mutex::new(vm),
            files,
            previous_boot: Mutex::new(None),
        })
    }
    /// Revoke the current VM and wait for its owned runner to be reaped.
    /// Callers must prevent new start/recover operations after shutdown.
    pub fn shutdown(&self) -> Result<()> {
        // A failed operation must not prevent cleanup of the child it owned.
        let vm = self.vm.lock().unwrap_or_else(|error| error.into_inner());
        vm.stop_and_wait()
    }
    /// The owned runner has not yet been replaced by a no-share automation run.
    /// This describes the retry path, not liveness or authorization.
    pub fn setup_pending(&self) -> bool {
        self.vm.lock().ok().is_some_and(|vm| {
            vm.launch.as_ref().is_some_and(|launch| launch.setup_directory.is_some())
        })
    }
    pub fn open_setup_viewer(&self) -> Result<()> {
        let vm = self.vm.lock().map_err(|_| "GUEST_REVOKED")?;
        if !vm.is_active()
            || vm
                .launch
                .as_ref()
                .is_none_or(|l| l.setup_directory.is_none())
        {
            return Err("SETUP_VIEWER_UNAVAILABLE");
        }
        vm.viewer.store(true, Ordering::Release);
        Ok(())
    }
    pub fn current_vm(&self) -> Option<Arc<OwnedVm>> {
        let vm = self.vm.lock().ok()?;
        if vm.is_active() && vm.authority.lock().ok()?.is_some() {
            Some(vm.clone())
        } else {
            None
        }
    }
    pub fn start(&self, task_id: &str) -> Result<Arc<OwnedVm>> {
        self.restart(task_id, false)
    }
    pub fn recover(&self, task_id: &str) -> Result<Arc<OwnedVm>> {
        self.restart(task_id, true)
    }
    fn restart(&self, task_id: &str, recovery: bool) -> Result<Arc<OwnedVm>> {
        if task_id.is_empty()
            || task_id.len() > 128
            || !task_id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
        {
            return Err("INVALID_TASK_ID");
        }
        let mut current = self.vm.lock().map_err(|_| "GUEST_REVOKED")?;
        let mut launch = current.launch.clone().ok_or("OWNERSHIP_NOT_ESTABLISHED")?;
        if recovery == launch.setup_directory.is_some() {
            return Err("EXPLICIT_RECOVERY_REQUIRED");
        }
        current.stop_and_wait()?;
        for (path, held) in &self.files {
            let old = held.metadata().map_err(|_| "OWNED_FILE_CHANGED")?;
            let now = fs::symlink_metadata(path).map_err(|_| "OWNED_FILE_CHANGED")?;
            if !now.is_file()
                || now.ino() != old.ino()
                || now.dev() != old.dev()
                || now.uid() != unsafe { libc::geteuid() }
                || now.nlink() != 1
                || now.mode() & 0o022 != 0
            {
                return Err("OWNED_FILE_CHANGED");
            }
        }
        // Only this live enrollment can retire its own fences, after wait() proved
        // its old runner exited. The next runner locks the same disk before boot.
        for path in [
            launch.vm_directory.join(".ondra-computer.quarantine"),
            launch
                .state_directory
                .join(format!("{}.quarantine", current.machine_digest)),
        ] {
            if read_private(&path, 4096)? != b"owned-run-requires-explicit-recovery\n" {
                return Err("QUARANTINE_CHANGED");
            }
            fs::remove_file(&path).map_err(|_| "QUARANTINE_CHANGED")?;
            File::open(path.parent().ok_or("UNSAFE_DIRECTORY")?)
                .and_then(|f| f.sync_all())
                .map_err(|_| "QUARANTINE_CHANGED")?;
        }
        launch.setup_directory = None;
        launch.restore_image = None;
        let vm = OwnedVm::launch(&self.assets.runner.path, &self.assets.runner.sha256, launch)?;
        *current = vm.clone();
        if let Err(code) = self.authenticate(&vm, task_id) {
            vm.quarantine();
            return Err(code);
        }
        Ok(vm)
    }
    fn authenticate(&self, vm: &OwnedVm, task_id: &str) -> Result<()> {
        let launch = vm.launch.as_ref().ok_or("OWNERSHIP_NOT_ESTABLISHED")?;
        if launch.setup_directory.is_some() {
            return Err("AUTOMATION_SHARE_FORBIDDEN");
        }
        let boot = vm.prepare_guest_boot(task_id, &self.assets.endpoint.sha256)?;
        let directory = self
            .directory
            .join(format!("connection-{}", random_secret()));
        create_private(&directory)?;
        write_private(
            &directory.join("identity"),
            &read_private(&self.directory.join("identity"), 32768)?,
            0o600,
        )?;
        let enrollment_dir = self.directory.join(format!("boot-{}", random_secret()));
        create_private(&enrollment_dir)?;
        write_private(
            &enrollment_dir.join("known_hosts"),
            format!("ondra-enrollment {}\n", self.server_pin).as_bytes(),
            0o600,
        )?;
        let deadline = Instant::now() + Duration::from_secs(120);
        // Waiting for the new VM's network is limited to this explicit start, never admission/renew.
        let host = loop {
            if !vm.is_active() {
                return Err("GUEST_REVOKED");
            }
            if let Ok(host) = owned_address(&launch.mac_address) {
                let address = format!("{host}:2222")
                    .parse()
                    .map_err(|_| "NAT_ADDRESS_UNAVAILABLE")?;
                if std::net::TcpStream::connect_timeout(&address, Duration::from_millis(500))
                    .is_ok()
                {
                    break host;
                }
            }
            if Instant::now() >= deadline {
                return Err("NAT_ADDRESS_UNAVAILABLE");
            }
            thread::sleep(Duration::from_millis(250));
        };
        let challenge = random_secret();
        let status = ssh_exchange(
            &enrollment_dir,
            &self.directory.join("provision-identity"),
            "ondra-enrollment",
            &host,
            true,
            &json!({"op":"status","challenge":challenge}),
            Duration::from_secs(5),
        )?;
        if !valid_status(
            &status,
            &challenge,
            &vm.host_uuid,
            [
                &self.assets.endpoint.sha256,
                &self.assets.desktop.sha256,
                &self.assets.helper.sha256,
            ],
        ) {
            return Err("ENROLLMENT_STATUS_REJECTED");
        }
        let secret = match status["secretConsumed"].as_bool() {
            Some(true) => None,
            Some(false) => Some(self.secret.as_str()),
            None => return Err("ENROLLMENT_STATUS_REJECTED"),
        };
        let receipt = ssh_exchange(
            &enrollment_dir,
            &self.directory.join("provision-identity"),
            "ondra-enrollment",
            &host,
            true,
            &json!({"secret":secret,"request":boot}),
            Duration::from_secs(5),
        )?;
        if !valid_boot_receipt(
            &receipt,
            &boot,
            &self.assets.desktop.sha256,
            &self.assets.helper.sha256,
        ) || receipt["vmUuid"] != status["vmUuid"]
            || receipt["bootSessionUuid"] != status["bootSessionUuid"]
            || !vm.is_active()
            || owned_address(&launch.mac_address)? != host
        {
            return Err("BOOT_PROVENANCE_REJECTED");
        }
        let vm_uuid = receipt["vmUuid"]
            .as_str()
            .ok_or("BOOT_PROVENANCE_REJECTED")?;
        let boot_uuid = receipt["bootSessionUuid"]
            .as_str()
            .ok_or("BOOT_PROVENANCE_REJECTED")?;
        let mut previous = self.previous_boot.lock().map_err(|_| "GUEST_REVOKED")?;
        if previous
            .as_ref()
            .is_some_and(|(old_vm, old_boot)| old_vm != vm_uuid || old_boot == boot_uuid)
        {
            return Err("BOOT_IDENTITY_CHANGED");
        }
        write_private(
            &directory.join("known_hosts"),
            format!("ondra-guest-{vm_uuid} {}\n", self.server_pin).as_bytes(),
            0o600,
        )?;
        let manifest = json!({"version":1,"taskId":task_id,"vmUuid":vm_uuid,"bootNonce":boot.boot_nonce,
            "host":host,"port":2222,"username":"ondra-computer"});
        write_private(
            &directory.join("manifest.json"),
            &serde_json::to_vec(&manifest).map_err(|_| "INVALID_MANIFEST")?,
            0o600,
        )?;
        let mut metadata = manifest;
        metadata["hostUuid"] = json!(vm.host_uuid);
        metadata["sshHostKey"] = json!(self.server_pin);
        metadata["identitySha256"] =
            json!(digest(&read_private(&directory.join("identity"), 32768)?)?);
        let provision_identity = self.directory.join("provision-identity");
        let authority = GuestAuthority {
            directory,
            metadata,
            mac: launch.mac_address.clone(),
            provision_directory: enrollment_dir,
            provision_identity_digest: digest(&read_private(&provision_identity, 32768)?)?,
            provision_identity,
            endpoint_digest: self.assets.endpoint.sha256.clone(),
            desktop_digest: self.assets.desktop.sha256.clone(),
            helper_digest: self.assets.helper.sha256.clone(),
            boot_uuid: boot_uuid.to_owned(),
        };
        authority.verify(vm)?;
        *vm.authority.lock().map_err(|_| "GUEST_REVOKED")? = Some(authority);
        *previous = Some((vm_uuid.to_owned(), boot_uuid.to_owned()));
        Ok(())
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Request {
    version: u8,
    id: String,
    op: String,
    session_id: String,
}
impl Request {
    fn valid(&self) -> bool {
        self.version == 1
            && [&self.id, &self.session_id].iter().all(|s| {
                !s.is_empty()
                    && s.len() <= 128
                    && s.bytes()
                        .all(|c| c.is_ascii_alphanumeric() || b"-_.:".contains(&c))
            })
            && ["register", "renew", "release", "unknown"].contains(&self.op.as_str())
    }
}

struct ChannelState {
    bound: Option<ProcessIdentity>,
    connected: bool,
    revoked: bool,
    socket: Option<UnixStream>,
}
/// Retain in the engine Proc; dropping or revoking it closes the authority channel.
pub struct EngineChannel {
    path: PathBuf,
    generation: u64,
    state: Arc<Mutex<ChannelState>>,
    vm: Option<Arc<OwnedVm>>,
}
impl EngineChannel {
    /// socket_directory must be a short, canonical, private directory, not artifacts.
    pub fn prepare(
        socket_directory: &Path,
        generation: u64,
        vm: Option<Arc<OwnedVm>>,
    ) -> Result<Self> {
        private_directory(socket_directory)?;
        let path =
            socket_directory.join(format!("computer-{}-{generation}.sock", std::process::id()));
        if path.as_os_str().len() > 100 {
            return Err("SOCKET_PATH_LIMIT");
        }
        // Never unlink another process's listener or reuse a previous generation's name.
        let listener = UnixListener::bind(&path).map_err(|_| "SOCKET_UNAVAILABLE")?;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600))
            .map_err(|_| "SOCKET_UNAVAILABLE")?;
        listener
            .set_nonblocking(true)
            .map_err(|_| "SOCKET_UNAVAILABLE")?;
        let state = Arc::new(Mutex::new(ChannelState {
            bound: None,
            connected: false,
            revoked: false,
            socket: None,
        }));
        let shared = state.clone();
        let owned = vm.clone();
        thread::spawn(move || {
            loop {
                let binding = {
                    let state = shared.lock().unwrap();
                    if state.revoked {
                        break;
                    }
                    state.bound
                };
                let Some(binding) = binding else {
                    thread::sleep(Duration::from_millis(10));
                    continue;
                };
                match listener.accept() {
                    Ok((socket, _)) => {
                        if !binding.matches(&socket) {
                            continue;
                        }
                        let _ = socket.set_read_timeout(Some(Duration::from_millis(100)));
                        let _ = socket.set_write_timeout(Some(IO_TIMEOUT));
                        {
                            let mut state = shared.lock().unwrap();
                            if state.revoked || state.connected {
                                continue;
                            }
                            state.connected = true;
                            state.socket = socket.try_clone().ok();
                        }
                        serve(socket, binding, &shared, owned.as_deref());
                        revoke_state(&shared, owned.as_deref());
                        break;
                    }
                    Err(e) if e.kind() == io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(10))
                    }
                    Err(_) => {
                        revoke_state(&shared, owned.as_deref());
                        break;
                    }
                }
            }
        });
        Ok(Self {
            path,
            generation,
            state,
            vm,
        })
    }
    pub fn socket_path(&self) -> &Path {
        &self.path
    }
    /// Call with the actual newly spawned child, before moving it into Proc.
    pub fn bind_child(&self, child: &mut Child, generation: u64) -> Result<()> {
        if generation != self.generation || !matches!(child.try_wait(), Ok(None)) {
            return Err("ENGINE_GENERATION_MISMATCH");
        }
        let identity = ProcessIdentity::read(child.id() as i32)?;
        let mut state = self.state.lock().map_err(|_| "GUEST_REVOKED")?;
        if state.revoked || state.bound.is_some() {
            return Err("ENGINE_ALREADY_BOUND");
        }
        state.bound = Some(identity);
        Ok(())
    }
    pub fn revoke(&self) {
        revoke_state(&self.state, self.vm.as_deref());
    }
}
impl Drop for EngineChannel {
    fn drop(&mut self) {
        self.revoke();
        let _ = fs::remove_file(&self.path);
    }
}
fn revoke_state(state: &Mutex<ChannelState>, vm: Option<&OwnedVm>) {
    if let Ok(mut state) = state.lock() {
        state.revoked = true;
        if let Some(mut socket) = state.socket.take() {
            let _ = socket.write_all(REVOKED);
            let _ = socket.shutdown(std::net::Shutdown::Both);
        }
    }
    if let Some(vm) = vm {
        vm.quarantine();
    }
}
fn serve(
    mut socket: UnixStream,
    binding: ProcessIdentity,
    state: &Mutex<ChannelState>,
    vm: Option<&OwnedVm>,
) {
    let mut bytes = Vec::new();
    let mut frame_start = None;
    let mut session: Option<String> = None;
    let mut last_renewal: Option<Instant> = None;
    loop {
        if state.lock().map_or(true, |s| s.revoked)
            || !binding.matches(&socket)
            || vm.is_some_and(|v| !v.is_active())
            || last_renewal.is_some_and(|at| at.elapsed() >= Duration::from_secs(45))
        {
            return;
        }
        if frame_start.is_some_and(|start: Instant| start.elapsed() >= IO_TIMEOUT) {
            return;
        }
        let mut byte = [0];
        match socket.read(&mut byte) {
            Ok(0) => return,
            Ok(_) if byte[0] != b'\n' => {
                frame_start.get_or_insert_with(Instant::now);
                if bytes.len() >= FRAME_LIMIT {
                    return;
                }
                bytes.push(byte[0]);
                continue;
            }
            Ok(_) => {}
            Err(e)
                if matches!(
                    e.kind(),
                    io::ErrorKind::WouldBlock
                        | io::ErrorKind::TimedOut
                        | io::ErrorKind::Interrupted
                ) =>
            {
                continue;
            }
            Err(_) => return,
        }
        let request = serde_json::from_slice::<Request>(&bytes)
            .ok()
            .filter(Request::valid);
        bytes.clear();
        frame_start = None;
        let Some(request) = request else {
            return;
        };
        if matches!(request.op.as_str(), "release" | "unknown") {
            revoke_state(state, vm);
            return;
        }
        let result = if session.as_ref().is_some_and(|s| s != &request.session_id) {
            Err("SESSION_ALREADY_CLAIMED")
        } else {
            match request.op.as_str() {
                "register" if session.is_some() => Err("SESSION_ALREADY_CLAIMED"),
                "register" => {
                    session = Some(request.session_id);
                    vm.ok_or("GUEST_SETUP_REQUIRED").and_then(|vm| {
                        if vm.claimed.swap(true, Ordering::AcqRel) {
                            return Err("SESSION_ALREADY_CLAIMED");
                        }
                        vm.connection_directory()
                            .map(|directory| json!({"connectionDir": directory}))
                    })
                }
                "renew" if last_renewal.is_some() => {
                    vm.ok_or("GUEST_SETUP_REQUIRED").and_then(OwnedVm::lease)
                }
                "renew" => Err("GUEST_SETUP_REQUIRED"),
                _ => return,
            }
        };
        let reply = match result {
            Ok(value) => {
                if state.lock().map_or(true, |s| s.revoked) || vm.is_none_or(|v| !v.is_active()) {
                    return;
                }
                last_renewal = Some(Instant::now());
                json!({"version":1,"id":request.id,"ok":true,"result":value})
            }
            Err(code) => {
                if last_renewal.is_some() {
                    revoke_state(state, vm);
                    return;
                }
                json!({"version":1,"id":request.id,"ok":false,"error":{"code":code}})
            }
        }
        .to_string()
            + "\n";
        if socket.write_all(reply.as_bytes()).is_err() {
            return;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicU64;
    mod shutdown {
        include!("../../scripts/computer-host/native-tests/shutdown.rs");
    }
    static NEXT: AtomicU64 = AtomicU64::new(0);
    fn directory() -> PathBuf {
        let path = fs::canonicalize(std::env::temp_dir())
            .unwrap()
            .join(format!(
                "oc-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
        fs::create_dir(&path).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
        path
    }
    #[test]
    fn boot_preparation_is_fresh_one_shot_and_never_admission() {
        fn owned() -> OwnedVm {
            let (stop, _) = mpsc::channel();
            OwnedVm {
                active: Arc::new(AtomicBool::new(true)),
                stop,
                host_uuid: "11111111-1111-4111-8111-111111111111".into(),
                boot_preparation_started: AtomicBool::new(false),
                ended: Arc::new(AtomicBool::new(true)),
                viewer: Arc::new(AtomicBool::new(false)),
                launch: None,
                authority: Mutex::new(None),
                machine_digest: String::new(),
                claimed: AtomicBool::new(false),
            }
        }
        let first = owned();
        assert!(matches!(
            first.prepare_guest_boot("../task", &"a".repeat(64)),
            Err("INVALID_PREPARATION")
        ));
        let request = first.prepare_guest_boot("task_1", &"a".repeat(64)).unwrap();
        assert_eq!(request.boot_nonce.len(), 64);
        assert_ne!(request.boot_nonce, request.challenge);
        assert!(matches!(
            first.prepare_guest_boot("task_1", &"a".repeat(64)),
            Err("BOOT_PREPARATION_ALREADY_STARTED")
        ));
        let second = owned();
        let next = second
            .prepare_guest_boot("task_1", &"a".repeat(64))
            .unwrap();
        assert_ne!(request.boot_nonce, next.boot_nonce);
        assert_ne!(request.challenge, next.challenge);
        second.quarantine();
        assert!(matches!(
            second.prepare_guest_boot("task_1", &"a".repeat(64)),
            Err("GUEST_REVOKED")
        ));
        let value = serde_json::to_value(request).unwrap();
        assert_eq!(value["hostUuid"], first.host_uuid);
        for field in ["vmUuid", "sshHostKey", "host", "expiresAt", "verified"] {
            assert!(value.get(field).is_none());
        }
    }
    #[test]
    fn frames_are_bounded_and_lf_only() {
        assert_eq!(
            bounded_frame(&mut &b"a\xe2\x80\xa8b\n"[..]).unwrap(),
            b"a\xe2\x80\xa8b"
        );
        assert!(bounded_frame(&mut &vec![b'x'; FRAME_LIMIT + 1][..]).is_err());
    }
    #[test]
    fn request_cannot_supply_evidence() {
        let request = json!({"version":1,"id":"a","op":"register","sessionId":"s","verified":true});
        assert!(serde_json::from_value::<Request>(request).is_err());
        assert!(
            !serde_json::from_value::<Request>(
                json!({"version":1,"id":"a","op":"adopt","sessionId":"s"})
            )
            .unwrap()
            .valid()
        );
    }
    #[test]
    fn actual_peer_identity_and_start_time_are_required() {
        let (a, _peer) = UnixStream::pair().unwrap();
        let own = ProcessIdentity::read(std::process::id() as i32).unwrap();
        assert!(own.matches(&a));
        assert!(
            !ProcessIdentity {
                micros: own.micros + 1,
                ..own
            }
            .matches(&a)
        );
        assert!(
            !ProcessIdentity {
                pid: own.pid + 1,
                ..own
            }
            .matches(&a)
        );
    }
    #[test]
    fn health_is_not_guest_provenance_and_claim_is_single_use() {
        let (server, mut client) = UnixStream::pair().unwrap();
        server
            .set_read_timeout(Some(Duration::from_millis(100)))
            .unwrap();
        client
            .set_read_timeout(Some(Duration::from_secs(1)))
            .unwrap();
        let identity = ProcessIdentity::read(std::process::id() as i32).unwrap();
        let state = Arc::new(Mutex::new(ChannelState {
            bound: Some(identity),
            connected: true,
            revoked: false,
            socket: None,
        }));
        let shared = state.clone();
        let worker = thread::spawn(move || {
            let (stop, _) = mpsc::channel();
            let vm = OwnedVm {
                active: Arc::new(AtomicBool::new(true)),
                stop,
                host_uuid: "11111111-1111-4111-8111-111111111111".into(),
                boot_preparation_started: AtomicBool::new(false),
                ended: Arc::new(AtomicBool::new(true)),
                viewer: Arc::new(AtomicBool::new(false)),
                launch: None,
                authority: Mutex::new(None),
                machine_digest: String::new(),
                claimed: AtomicBool::new(false),
            };
            let _request = vm.prepare_guest_boot("task_1", &"a".repeat(64)).unwrap();
            // Even a prepared active owner cannot turn its request into provenance.
            serve(server, identity, &shared, Some(&vm));
            revoke_state(&shared, Some(&vm));
        });
        for (session, expected) in [
            ("s", "GUEST_SETUP_REQUIRED"),
            ("s", "SESSION_ALREADY_CLAIMED"),
            ("other", "SESSION_ALREADY_CLAIMED"),
        ] {
            writeln!(
                client,
                "{}",
                json!({"version":1,"id":"r","op":"register","sessionId":session})
            )
            .unwrap();
            let reply: Value =
                serde_json::from_slice(&bounded_frame(&mut client).unwrap()).unwrap();
            assert_eq!(reply["error"]["code"], expected);
            assert_eq!(reply["ok"], false);
            assert!(reply.get("result").is_none());
        }
        drop(client);
        worker.join().unwrap();
        assert!(state.lock().unwrap().revoked);
    }
    #[test]
    fn unbound_channel_never_admits_a_peer_and_drop_unlinks() {
        let dir = directory();
        let channel = EngineChannel::prepare(&dir, 1, None).unwrap();
        let path = channel.socket_path().to_owned();
        assert!(EngineChannel::prepare(&dir, 1, None).is_err());
        let mut client = UnixStream::connect(&path).unwrap();
        client
            .set_read_timeout(Some(Duration::from_millis(100)))
            .unwrap();
        writeln!(
            client,
            "{}",
            json!({"version":1,"id":"r","op":"register","sessionId":"s"})
        )
        .unwrap();
        assert!(bounded_frame(&mut client).is_err());
        drop(channel);
        assert!(!path.exists());
        fs::remove_dir(dir).unwrap();
    }
    #[test]
    fn engine_child_probe() {
        let Some(path) = std::env::var_os("ONDRA_COMPUTER_TEST_SOCKET") else {
            return;
        };
        let mut socket = UnixStream::connect(path).unwrap();
        socket
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        writeln!(
            socket,
            "{}",
            json!({"version":1,"id":"r","op":"register","sessionId":"s"})
        )
        .unwrap();
        let reply: Value = serde_json::from_slice(&bounded_frame(&mut socket).unwrap()).unwrap();
        assert_eq!(reply["error"]["code"], "GUEST_SETUP_REQUIRED");
        // Even an unknown outcome from another session must fence the VM.
        writeln!(
            socket,
            "{}",
            json!({"version":1,"id":"u","op":"unknown","sessionId":"different"})
        )
        .unwrap();
        let reply: Value = serde_json::from_slice(&bounded_frame(&mut socket).unwrap()).unwrap();
        assert_eq!(reply["event"], "revoked");
    }
    #[test]
    fn actual_child_binding_rejects_parent_and_wrong_generation() {
        let dir = directory();
        let channel = EngineChannel::prepare(&dir, 42, None).unwrap();
        let mut intruder = UnixStream::connect(channel.socket_path()).unwrap();
        intruder
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        let mut child = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "computer::tests::engine_child_probe"])
            .env("ONDRA_COMPUTER_TEST_SOCKET", channel.socket_path())
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        assert_eq!(
            channel.bind_child(&mut child, 41),
            Err("ENGINE_GENERATION_MISMATCH")
        );
        channel.bind_child(&mut child, 42).unwrap();
        assert_eq!(
            channel.bind_child(&mut child, 42),
            Err("ENGINE_ALREADY_BOUND")
        );
        let mut byte = [0];
        assert_eq!(intruder.read(&mut byte).unwrap(), 0);
        let output = child.wait_with_output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stdout)
        );
        assert!(channel.state.lock().unwrap().revoked);
        drop(channel);
        fs::remove_dir(dir).unwrap();
    }
    #[test]
    fn nat_requires_the_owned_mac_one_private_address_and_a_bridge() {
        let line = b"? (192.168.64.2) at 2:11:22:33:44:55 on bridge100 ifscope [ethernet]\n";
        assert_eq!(
            nat_address(line, "02:11:22:33:44:55"),
            Ok("192.168.64.2".into())
        );
        assert!(nat_address(line, "02:11:22:33:44:56").is_err());
        assert!(
            nat_address(
                b"? (192.168.64.2) at 2:11:22:33:44:55 on en0",
                "02:11:22:33:44:55"
            )
            .is_err()
        );
        assert!(
            nat_address(
                b"? (8.8.8.8) at 2:11:22:33:44:55 on bridge100",
                "02:11:22:33:44:55"
            )
            .is_err()
        );
        let duplicate = [
            line.as_slice(),
            b"? (192.168.64.3) at 2:11:22:33:44:55 on bridge100\n",
        ]
        .concat();
        assert!(nat_address(&duplicate, "02:11:22:33:44:55").is_err());
    }
    #[test]
    fn authenticated_receipt_and_endpoint_identity_bind_the_fresh_boot() {
        let request = GuestBootPreparation {
            version: 1,
            task_id: "task_1".into(),
            host_uuid: "10000000-0000-4000-8000-000000000001".into(),
            boot_nonce: "b".repeat(64),
            challenge: "c".repeat(64),
            endpoint_sha256: "a".repeat(64),
        };
        let receipt = json!({"version":1,"challenge":request.challenge,
            "vmUuid":"20000000-0000-4000-8000-000000000002",
            "bootSessionUuid":"30000000-0000-4000-8000-000000000003",
            "endpointSha256":request.endpoint_sha256,"desktopSha256":"desktop","helperSha256":"helper"});
        assert!(valid_boot_receipt(&receipt, &request, "desktop", "helper"));
        let mut status = receipt.clone();
        status["hostUuid"] = json!(request.host_uuid);
        status["secretConsumed"] = json!(false);
        assert!(valid_status(
            &status,
            &request.challenge,
            &request.host_uuid,
            [&request.endpoint_sha256, "desktop", "helper"]
        ));
        status["secretConsumed"] = json!(true);
        assert!(valid_status(
            &status,
            &request.challenge,
            &request.host_uuid,
            [&request.endpoint_sha256, "desktop", "helper"]
        ));
        status["helperSha256"] = json!("changed");
        assert!(!valid_status(
            &status,
            &request.challenge,
            &request.host_uuid,
            [&request.endpoint_sha256, "desktop", "helper"]
        ));
        for (key, value) in [
            ("challenge", json!("replayed")),
            ("vmUuid", json!(request.host_uuid)),
            ("bootSessionUuid", json!("invalid")),
            ("endpointSha256", json!("changed")),
            ("verified", json!(true)),
        ] {
            let mut changed = receipt.clone();
            changed[key] = value;
            assert!(
                !valid_boot_receipt(&changed, &request, "desktop", "helper"),
                "{key}"
            );
        }
        let metadata = json!({"version":1,"taskId":request.task_id,"vmUuid":receipt["vmUuid"],"bootNonce":request.boot_nonce});
        let mut response = metadata.clone();
        response["requestId"] = json!("probe");
        assert!(valid_identity(&response, &metadata, "probe"));
        assert!(!valid_identity(&response, &metadata, "another-probe"));
        response["bootNonce"] = json!("old");
        assert!(!valid_identity(&response, &metadata, "probe"));
    }
    #[test]
    fn private_connection_files_and_command_limits_are_enforced() {
        let root = directory();
        let path = root.join("identity");
        write_private(&path, b"private", 0o600).unwrap();
        assert_eq!(read_private(&path, 7).unwrap(), b"private");
        assert!(read_private(&path, 3).is_err());
        assert!(write_private(&path, b"replace", 0o600).is_err());
        std::os::unix::fs::symlink(&path, root.join("link")).unwrap();
        assert!(read_private(&root.join("link"), 10).is_err());
        assert!(safe_ssh_path(Path::new("/tmp/%h")).is_err());
        assert!(safe_ssh_path(Path::new("/tmp/\"injection")).is_err());
        let mut command = Command::new("/usr/bin/printf");
        command.arg("bounded");
        assert_eq!(
            run_bounded(command, &[], Duration::from_secs(1), 10).unwrap(),
            b"bounded"
        );
        let mut command = Command::new("/usr/bin/printf");
        command.arg("oversized");
        assert!(run_bounded(command, &[], Duration::from_secs(1), 3).is_err());
        let mut command = Command::new("/bin/sleep");
        command.arg("1");
        assert!(run_bounded(command, &[], Duration::from_millis(50), 10).is_err());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn runner_digest_is_not_taken_from_its_path_or_pid() {
        assert_eq!(
            digest(b"abc").unwrap(),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        let dir = directory();
        let path = dir.join("runner");
        fs::write(&path, b"not a runner").unwrap();
        assert!(checked_runner(&path, &"0".repeat(64)).is_err());
        fs::remove_dir_all(dir).unwrap();
    }
}
