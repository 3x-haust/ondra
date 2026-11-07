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
        let script =
            format!("#!/bin/sh\nread -r configuration\nprintf '%s\\n' '{ready}'\nexec /bin/cat\n");
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
