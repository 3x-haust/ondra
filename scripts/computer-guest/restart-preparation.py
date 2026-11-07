"""One approved guest restart; no host activation, forced stop or TCC modification."""
import fcntl, hashlib, ipaddress, json, os, pathlib, plistlib, secrets, shlex, subprocess, sys, time, uuid

VM = 'ondra-guest'
# Headless by default. A viewer window on the host is opt-in, only while a person approves guest permissions.
DISPLAY = 'native' if sys.argv[1:] == ['--viewer'] else 'none'

def require(condition, message):
    if not condition:
        raise RuntimeError(message)

root = pathlib.Path(os.environ['APP_ARTIFACTS_DIR']) / 'runtime'
private = root / 'setup-private'
os.umask(0o077)
binary = root / 'isolated-bin/lume-local'
env = {**os.environ, 'LUME_TELEMETRY_ENABLED': 'false', 'LUME_HOME': str(root / 'home')}
ssh = json.loads((private / 'ssh-command.json').read_text())
provision = json.loads((private / 'guest-provision.json').read_text())
old_boot = json.loads((private / 'guest-boot.json').read_text())
check = json.loads((root / 'isolated-preparer-check.json').read_text())
require(hashlib.sha256(binary.read_bytes()).hexdigest() == check['sha256'], 'Prepared binary changed')
subprocess.run(['/usr/bin/codesign', '--verify', '--strict', str(binary)], check=True)
old_pid = int((root / 'account-run.pid').read_text())
expected_command = str(root / 'bin/lume-local') + ' run ' + VM + ' --storage ' + str(root / 'vms') + ' --display none --vnc disabled --network nat'
actual_command = subprocess.check_output(['/bin/ps', '-p', str(old_pid), '-o', 'command='], text=True).strip()
require(actual_command == expected_command, 'Runner no longer matches the prepared guest')

def remote(command, data=b'', timeout=30, connection=None):
    return subprocess.run((connection or ssh) + [command], input=data, capture_output=True, timeout=timeout)

def hardware(data):
    for item in plistlib.loads(data):
        if 'IOPlatformUUID' in item:
            return str(uuid.UUID(item['IOPlatformUUID'])).lower()
    raise ValueError('Missing hardware identity')

host = hardware(subprocess.check_output(['/usr/sbin/ioreg', '-rd1', '-c', 'IOPlatformExpertDevice', '-a']))
result = remote('/usr/sbin/ioreg -rd1 -c IOPlatformExpertDevice -a')
require(result.returncode == 0, 'Guest hardware query failed')
require(hardware(result.stdout) == provision['vmUuid'] != host == provision['hostUuid'], 'Guest hardware identity mismatch')
request = {'version': 1, 'op': 'identity', 'requestId': str(uuid.uuid4())}
result = remote('/usr/local/libexec/ondra-computer-endpoint', json.dumps(request).encode())
identity = json.loads(result.stdout)
require(result.returncode == 0, 'Original endpoint identity query failed')
require(all(identity[k] == v for k, v in {'taskId': provision['taskId'], 'vmUuid': provision['vmUuid'], 'bootNonce': old_boot['bootNonce']}.items()), 'Original endpoint identity mismatch')
password = json.loads((private / 'credentials.json').read_text())['password']
with (root / 'approved-restart-once.lock').open('x') as marker:
    marker.write(json.dumps({'oldPid': old_pid, 'started': time.time()}))
print('Validated original runner, pinned SSH and independent guest identity.', flush=True)
observer_output = (root / 'host-isolated-restart.jsonl').open('wb')
observer_error = (root / 'host-isolated-restart.stderr.log').open('wb')
observer = subprocess.Popen([str(root / 'host-observer'), '120', '0.1'], stdin=subprocess.DEVNULL, stdout=observer_output, stderr=observer_error)
# This is a guest OS shutdown, not the hypervisor's immediate power-off path.
result = remote('/usr/bin/sudo -k -S -p "" /sbin/shutdown -h now', (password + '\n').encode())
require(result.returncode in [0, 255], 'Guest shutdown request failed')
end = time.monotonic() + 120
while time.monotonic() < end:
    alive = subprocess.run(['/bin/ps', '-p', str(old_pid), '-o', 'pid='], capture_output=True).returncode == 0
    if not alive:
        with (root / 'vms' / VM / 'config.json').open('rb') as config:
            fcntl.flock(config, fcntl.LOCK_EX | fcntl.LOCK_NB)
            fcntl.flock(config, fcntl.LOCK_UN)
        break
    time.sleep(2)
else:
    raise SystemExit('Old guest did not stop; no force or second restart attempted.')
print('Original guest OS shut down and runner released its config lock.', flush=True)
with (root / 'isolated-run.log').open('xb') as output:
    runner = subprocess.Popen([str(binary), 'run', VM, '--storage', str(root / 'vms'), '--display', DISPLAY, '--vnc', 'disabled', '--network', 'nat'], env=env, stdin=subprocess.DEVNULL, stdout=output, stderr=subprocess.STDOUT, start_new_session=True)
(root / 'isolated-run.pid').write_text(str(runner.pid))
end = time.monotonic() + 480
while time.monotonic() < end:
    require(runner.poll() is None, 'New runner exited; do not relaunch automatically')
    status = subprocess.run([str(binary), 'get', VM, '--storage', str(root / 'vms'), '--format', 'json'], env=env, capture_output=True, text=True)
    if status.returncode == 0:
        details = json.loads(status.stdout)[0]
        address = details.get('ipAddress')
        if details['status'] == 'running' and address and ipaddress.ip_address(address).is_private and not ipaddress.ip_address(address).is_loopback:
            candidate = ssh[:-1] + [address]
            result = remote('/usr/sbin/ioreg -rd1 -c IOPlatformExpertDevice -a', connection=candidate)
            if result.returncode == 0:
                require(hardware(result.stdout) == provision['vmUuid'] != host, 'Restarted guest hardware identity mismatch')
                ssh = candidate
                break
    time.sleep(5)
else:
    raise SystemExit('Pinned guest SSH not ready; running guest retained.')
result = remote('/usr/sbin/sysctl -n kern.bootsessionuuid')
require(result.returncode == 0, 'Guest boot identity query failed')
boot_id = str(uuid.UUID(result.stdout.decode().strip())).lower()
require(boot_id != old_boot['bootSessionUuid'], 'Guest boot did not change')
# Confirm the installed endpoint rejects the previous boot before renewing it.
result = remote('/usr/local/libexec/ondra-computer-endpoint', json.dumps(request).encode())
stale = json.loads(result.stderr)
require(result.returncode == 64 and stale.get('error', {}).get('code') == 'STALE_BOOT_IDENTITY', 'Previous boot was not refused')
boot = {'version': 1, 'vmUuid': provision['vmUuid'], 'bootNonce': secrets.token_hex(32), 'bootSessionUuid': boot_id}
script = 'set -eu; umask 077; p=/private/var/db/ondra-computer/boot.json.next; test ! -e "$p"; /bin/cat > "$p"; /usr/sbin/chown root:wheel "$p"; /bin/chmod 644 "$p"; /bin/mv "$p" /private/var/db/ondra-computer/boot.json'
result = remote('/usr/bin/sudo -k -S -p "" /bin/sh -c ' + shlex.quote(script), (password + '\n' + json.dumps(boot)).encode())
require(result.returncode == 0, 'Boot identity renewal failed')
(private / 'guest-boot.json').write_text(json.dumps(boot))
(private / 'ssh-command.json').write_text(json.dumps(ssh))
result = remote('/usr/local/libexec/ondra-computer-endpoint', json.dumps(request).encode())
identity = json.loads(result.stdout)
require(result.returncode == 0, 'Renewed endpoint identity query failed')
require(all(identity[k] == v for k, v in {'taskId': provision['taskId'], 'vmUuid': provision['vmUuid'], 'bootNonce': boot['bootNonce']}.items()), 'Renewed endpoint identity mismatch')
session = json.loads((root / 'vms' / VM / 'sessions.json').read_text())
require(session.get('vncEnabled') is False and session.get('pid') == runner.pid, 'Runner session mismatch')
require(not session.get('sharedDirectories'), 'Explicit directory sharing found')
require('Directory sharing configuration deviceCount=0 enabled=false' in (root / 'isolated-run.log').read_text() or 'Directory sharing configuration enabled=false deviceCount=0' in (root / 'isolated-run.log').read_text(), 'Actual directory sharing configuration not confirmed')
(root / 'isolated-ready.json').write_text(json.dumps({'pid': runner.pid, 'host': address, 'pinned': True, 'bootChanged': True, 'staleBootRefused': True, 'identityRenewed': True, 'nativePreparationOnly': True, 'status': details, 'session': session}, indent=2))
print('New guest boot verified; previous boot refused; endpoint identity renewed.', flush=True)
result = remote('AGENT_DESKTOP_MACOS_HELPER_PATH=/usr/local/libexec/ondra-computer/1.1.0/agent-desktop-macos-helper /usr/local/libexec/ondra-computer/1.1.0/agent-desktop permissions --guide')
(root / 'isolated-permissions-guide.json').write_bytes(result.stdout)
(root / 'isolated-permissions-guide.stderr').write_bytes(result.stderr)
require(result.returncode == 0, 'Guest permission guide failed')
observer.wait()
observer_output.close(); observer_error.close()
require(observer.returncode == 0, 'Host observer failed')
rows = [json.loads(line) for line in (root / 'host-isolated-restart.jsonl').read_text().splitlines()]
print('Observer finished; guest permission guide requested. No host input sent.', flush=True)
