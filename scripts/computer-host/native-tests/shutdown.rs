use super::*;

struct Fixture {
    root: PathBuf,
    setup: Option<ComputerSetup>,
    borrowed: Arc<OwnedVm>,
}

impl Fixture {
    fn new() -> Self {
        Self::with_setup(false)
    }

    fn with_setup(pending: bool) -> Self {
        let root = directory();
        let runner = root.join("runner");
        let launch = HostLaunch {
            version: 1,
            vm_directory: root.clone(),
            state_directory: root.clone(),
            cpu_count: 2,
            memory_bytes: 1024,
            hardware_model: "fixture".into(),
            machine_identifier: "fixture".into(),
            mac_address: "02:11:22:33:44:55".into(),
            width: 100,
            height: 100,
            setup_directory: pending.then(|| root.join("setup")),
            restore_image: None,
            disk_bytes: None,
        };
        let ready = json!({
            "version": 1, "id": "ready", "state": "running",
            "hostUuid": "11111111-1111-4111-8111-111111111111",
            "machineIdentifierSha256": "a".repeat(64),
            "configurationSha256": "b".repeat(64),
            "sharingDevices": if pending { 1 } else { 0 }, "macAddress": launch.mac_address,
            "launch": launch,
        });
        // Only a disposable stdio child; no VM, credentials or guest connection.
        // It echoes inspections (which fail validation) and exits on a graceful stop request.
        let script = format!(
            "#!/bin/sh\nread -r configuration\nprintf '%s\\n' '{ready}'\nwhile read -r line; do case \"$line\" in *'\"op\":\"stop\"'*) exit 0;; *) printf '%s\\n' \"$line\";; esac; done\n"
        );
        write_private(&runner, script.as_bytes(), 0o700).unwrap();
        let sha256 = digest(script.as_bytes()).unwrap();
        let vm = OwnedVm::launch(&runner, &sha256, launch).unwrap();
        let asset = || SealedAsset {
            path: runner.clone(),
            sha256: sha256.clone(),
        };
        let setup = ComputerSetup {
            assets: ComputerAssets {
                runner: asset(),
                endpoint: asset(),
                provisioner: asset(),
                installer: asset(),
                desktop: asset(),
                helper: asset(),
            },
            directory: root.clone(),
            server_pin: String::new(),
            secret: String::new(),
            vm: Mutex::new(vm.clone()),
            files: Vec::new(),
            previous_boot: Mutex::new(None),
            resumed: AtomicBool::new(false),
        };
        Self {
            root,
            setup: Some(setup),
            borrowed: vm,
        }
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.borrowed.stop_and_wait().unwrap();
        fs::remove_dir_all(&self.root).unwrap();
    }
}

#[test]
fn shutdown_reaps_runner_even_after_vm_lock_is_poisoned() {
    let fixture = Fixture::new();
    let setup = fixture.setup.as_ref().unwrap();
    assert!(
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _vm = setup.vm.lock().unwrap();
            panic!("interrupted operation");
        }))
        .is_err()
    );
    assert!(setup.vm.is_poisoned());
    assert!(!setup.setup_pending());
    assert_eq!(setup.shutdown(), Ok(()));
    assert!(!fixture.borrowed.is_active());
    assert!(fixture.borrowed.ended.load(Ordering::Acquire));
}

#[test]
fn setup_retry_tracks_owned_configuration_not_runner_liveness() {
    for pending in [true, false] {
        let fixture = Fixture::with_setup(pending);
        let setup = fixture.setup.as_ref().unwrap();
        assert_eq!(setup.setup_pending(), pending);
        assert_eq!(setup.shutdown(), Ok(()));
        assert_eq!(setup.setup_pending(), pending);
        assert!(setup.current_vm().is_none());
    }
}

#[test]
fn shutdown_revokes_borrowed_vm_and_waits_for_runner_reap() {
    let mut fixture = Fixture::new();
    let setup = fixture.setup.take().unwrap();
    assert!(fixture.borrowed.is_active());
    assert!(!fixture.borrowed.ended.load(Ordering::Acquire));
    assert_eq!(setup.shutdown(), Ok(()));
    assert!(setup.current_vm().is_none());
    assert_eq!(setup.open_setup_viewer(), Err("SETUP_VIEWER_UNAVAILABLE"));
    assert_eq!(setup.shutdown(), Ok(()));
    drop(setup);
    assert!(
        !fixture.borrowed.is_active(),
        "setup exit left borrowed VM authorized"
    );
    assert!(
        fixture.borrowed.ended.load(Ordering::Acquire),
        "setup exit returned before runner reap"
    );
    assert_eq!(fixture.borrowed.lease(), Err("GUEST_REVOKED"));
}

/// On-disk layout `prepare` leaves behind, with a fixture runner as every asset.
fn prepared(root: &Path, installed: bool, automation: bool) -> (ComputerAssets, PathBuf) {
    let runner = root.join("runner");
    let script = b"#!/bin/sh\nexit 0\n";
    write_private(&runner, script, 0o700).unwrap();
    let sha256 = digest(script).unwrap();
    let asset = || SealedAsset { path: runner.clone(), sha256: sha256.clone() };
    let directory = root.join("vm");
    for path in [directory.clone(), directory.join("machine"), directory.join("setup")] {
        create_private(&path).unwrap();
    }
    let launch = HostLaunch {
        version: 1,
        vm_directory: directory.join("machine"),
        state_directory: root.to_path_buf(),
        cpu_count: 4,
        memory_bytes: 8 << 30,
        hardware_model: "aGFyZHdhcmU=".into(),
        machine_identifier: "bWFjaGluZQ==".into(),
        mac_address: "02:11:22:33:44:55".into(),
        width: 1440,
        height: 900,
        setup_directory: Some(directory.join("setup")),
        restore_image: Some(root.join("restore.ipsw")),
        disk_bytes: Some(64 << 30),
    };
    write_private(&directory.join("machine/config.json"), &serde_json::to_vec(&launch).unwrap(), 0o600).unwrap();
    for name in ["disk.img", "nvram.bin"] {
        write_private(&directory.join("machine").join(name), b"x", 0o600).unwrap();
    }
    let key = format!("ssh-ed25519 {} \n", "A".repeat(68));
    write_private(&directory.join("setup/server-key.pub"), key.as_bytes(), 0o600).unwrap();
    let enrollment = json!({"version":1,"hostUuid":"11111111-1111-4111-8111-111111111111","secret":"c".repeat(64),"endpointSha256":sha256});
    write_private(&directory.join("setup/enrollment.json"), enrollment.to_string().as_bytes(), 0o600).unwrap();
    for name in ["identity", "provision-identity"] {
        write_private(&directory.join(name), b"private", 0o600).unwrap();
    }
    write_private(&root.join(format!("{}.quarantine", "d".repeat(64))), b"owned-run-requires-explicit-recovery\n", 0o600).unwrap();
    if installed { mark(&directory.join(INSTALLED_MARKER)).unwrap(); }
    if automation { mark(&directory.join(AUTOMATION_MARKER)).unwrap(); }
    let assets = ComputerAssets { runner: asset(), endpoint: asset(), provisioner: asset(), installer: asset(), desktop: asset(), helper: asset() };
    (assets, directory)
}

#[test]
fn resume_loads_a_stopped_guest_from_its_prepared_files() {
    for automation in [false, true] {
        let root = directory();
        let (assets, vm) = prepared(&root, true, automation);
        let setup = ComputerSetup::resume(assets, vm.clone(), root.clone()).unwrap();
        assert!(setup.resumed.load(Ordering::Acquire), "loaded without a runner");
        assert_eq!(setup.setup_pending(), !automation, "setup state comes from the automation marker");
        assert!(setup.current_vm().is_none(), "a resumed guest is not authorized before it boots");
        assert_eq!(setup.server_pin, format!("ssh-ed25519 {}", "A".repeat(68)));
        assert_eq!(setup.secret, "c".repeat(64));
        let current = setup.vm.lock().unwrap().clone();
        let launch = current.launch.as_ref().unwrap();
        assert_eq!(launch.restore_image, None, "a resumed guest never reinstalls");
        assert_eq!(current.machine_digest, "d".repeat(64));
        assert_eq!(setup.shutdown(), Ok(()), "a stopped guest has no runner to wait for");
        drop(setup);
        fs::remove_dir_all(&root).unwrap();
    }
}

#[test]
fn resume_refuses_an_unfinished_install_a_live_runner_and_moved_files() {
    let root = directory();
    let (assets, vm) = prepared(&root, false, false);
    let again = || ComputerAssets {
        runner: SealedAsset { path: assets.runner.path.clone(), sha256: assets.runner.sha256.clone() },
        endpoint: SealedAsset { path: assets.runner.path.clone(), sha256: assets.runner.sha256.clone() },
        provisioner: SealedAsset { path: assets.runner.path.clone(), sha256: assets.runner.sha256.clone() },
        installer: SealedAsset { path: assets.runner.path.clone(), sha256: assets.runner.sha256.clone() },
        desktop: SealedAsset { path: assets.runner.path.clone(), sha256: assets.runner.sha256.clone() },
        helper: SealedAsset { path: assets.runner.path.clone(), sha256: assets.runner.sha256.clone() },
    };
    assert!(matches!(ComputerSetup::resume(again(), vm.clone(), root.clone()), Err("PREPARATION_INCOMPLETE")));
    mark(&vm.join(INSTALLED_MARKER)).unwrap();
    // A live runner holds an exclusive flock on its machine files.
    let held = File::open(vm.join("machine/disk.img")).unwrap();
    assert_eq!(unsafe { libc::flock(held.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) }, 0);
    assert!(matches!(ComputerSetup::resume(again(), vm.clone(), root.clone()), Err("GUEST_STILL_RUNNING")));
    drop(held);
    let other = directory();
    assert!(matches!(ComputerSetup::resume(again(), vm.clone(), other.clone()), Err("UNSAFE_DIRECTORY")));
    fs::remove_file(vm.join("machine/config.json")).unwrap();
    write_private(&vm.join("machine/config.json"), b"{}", 0o600).unwrap();
    assert!(matches!(ComputerSetup::resume(again(), vm.clone(), root.clone()), Err("INVALID_CONFIGURATION")));
    fs::remove_dir_all(&root).unwrap();
    fs::remove_dir_all(&other).unwrap();
}
