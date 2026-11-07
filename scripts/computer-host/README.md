# 직접 소유 macOS 실행자

Apple Silicon/macOS 13 이상용 VZ 실행자, 최초 설치기와 네이티브 등록 경계다. 기존 실행 VM·PID·준비 manifest를 입양하지 않는다. 네이티브 API는 `src-tauri/src/computer.rs`의 `ComputerSetup`이며 앱 명시 커맨드에서만 호출한다. 엔진 spawn과 `register`/`renew`는 VM을 시작하거나 복구하지 않는다.

## 빌드와 오프라인 검사

```sh
bash scripts/computer-host/check.sh
CARGO_TARGET_DIR=/tmp/ondra-computer-native-tests-target cargo clippy --offline --manifest-path scripts/computer-host/native-tests/Cargo.toml --all-targets -- -D warnings
bash scripts/computer-host/build.sh /절대경로/출력폴더
```

검사는 실제 VZ **구성 객체**, 임시 파일, 소켓, 합성 게스트 신원 및 제한된 로컬 테스트 자식만 사용한다. VM·SSH·게스트 root·GUI·모델은 실행하지 않는다. 빌드는 실행자/endpoint/provisioner를 컴파일·서명하고 수동 설치 스크립트를 복사한다. 출력 `.sha256` 파일을 런타임 신뢰 근거로 읽으면 안 된다. 앱 빌드가 서명된 리소스 경로와 빌드 시 봉인한 digest를 `ComputerAssets`로 제공해야 한다. desktop/helper는 고정 arm64 1.1.0 자산이다.

## 앱 API

- `ComputerSetup::prepare(ComputerAssets, SetupRequest)`: 새 private 디렉터리에 키 3쌍(서버, endpoint client, root provisioning client)을 독립 생성한다. 로컬 IPSW에서 VZ 하드웨어 모델을 읽고 새 machine identifier·MAC·디스크·NVRAM을 생성해 macOS를 설치한다. 다운로드는 하지 않는다. 준비는 긴 blocking 작업이다.
- `open_setup_viewer()`: 준비 부팅에만 viewer를 요청한다. 자동 창 표시·host activate·클립보드 통합은 없다. 사용자가 앱의 명시 커맨드를 누른 뒤 창을 직접 선택한다.
- `start(task_id)`: 직접 소유한 준비 runner의 종료를 기다린 뒤 같은 VM을 공유 장치 없이 새로 부팅하고 인증된 설치 상태를 발급한다.
- `recover(task_id)`: 직접 보유 중인 이전 실행의 종료를 확인한 뒤 새로운 부팅 nonce로 명시 복구한다. 이전 작업의 성공을 추정하지 않는다.
- `current_vm()`: 인증 완료·active인 VM만 반환한다. 앱은 이를 엔진 `EngineChannel::prepare`에 전달한다.

`SetupRequest.directory`는 존재하지 않는 새 경로, 그 부모와 `state_directory`는 canonical 0700 앱 소유 폴더여야 한다. 상태 폴더는 작업 artifacts와 분리해 고정한다. IPSW는 로컬 절대 경로다. CPU/메모리는 해당 IPSW의 최소 요구 이상, 디스크는 64 GiB~1 TiB다. 머신·키 상태는 메모리의 직접 소유 핸들과 결합된다. **앱 재시작 후 디스크 파일만으로 이어 붙이는 API는 없다.** 이 경우 새 전용 VM을 준비한다.

## 나중에 최초 준비할 때

1. 앱에 봉인 자산이 포함된 빌드를 사용해 명시적 준비를 실행한다. 새 VM에 macOS 설치가 끝날 때까지 기다린다.
2. 준비 viewer를 명시적으로 열고 macOS 최초 설정을 완료한다. 개인 Apple 계정·사용자 폴더를 연결할 필요는 없다.
3. 게스트 Terminal에서 자동 마운트된 준비 볼륨의 `install-setup.sh`를 찾는다. 그 **게스트 안에서** `sudo /bin/bash /준비볼륨/경로/install-setup.sh`를 직접 실행한다. 설치기는 첫 쓰기 전에 host UUID와 guest UUID가 다름을 확인한다.
4. 새 `ondra-computer` 계정 암호를 게스트에서 정한다. 설치기는 endpoint/고정 desktop/helper와 제한된 전용 sshd LaunchDaemon을 설치한다. 일반 SSH 설정, 임의 sudo shell 규칙, 호스트 설정은 수정하지 않는다.
5. 게스트 `ondra-computer` 데스크톱에 로그인하고 해당 게스트에서 필요한 접근성·화면 기록 권한을 직접 승인한다. 이후 무인 부팅에 로그인된 데스크톱이 필요하면 게스트의 자동 로그인을 사용자가 직접 설정한다. 이 구현은 로그인 화면이나 TCC를 우회하지 않는다. 준비 viewer가 사라져도 필요한 설정이 유지되도록 완료한 뒤 시작한다.
6. 앱의 명시적 자동화 시작을 누른다. 준비 VM을 종료하고 **공유 장치 0**인 구성으로 다시 부팅한다. 전용 SSH 서비스는 이 부팅에서 시작된다. 네이티브가 준비 때 만든 server pin·두 client key와 일회성 비밀을 이용해 root 부팅 상태를 설치한다.
7. 인증이 끝난 뒤 새 작업 엔진을 시작한다. 도구 `start` 자체는 VM 준비/시작 커맨드가 아니다. 실패·unknown·해제·lease 만료 뒤에는 앱의 명시 복구와 새 작업 엔진이 필요하다.

공유에는 설치기, 봉인 자산, 새 SSH server key, 두 client **공개키**, 일회성 enrollment만 둔다. 두 host private client key는 공유 밖에 남는다. 준비 공유는 전용 폴더 하나이며 읽기 전용이다. 일반 사용자 폴더, clipboard, SPICE, serial, vsock, audio는 연결하지 않는다. 자동화 구성과 실제 VZ 인스턴스 모두 공유 개수가 0인지 검사한다.

## 등록 신뢰 경계

실행자는 적용한 MAC/NAT 구성·머신 데이터·host UUID·공유 개수를 소유 pipe로 관측한다. 네이티브는 실제 Child와 주기적 inspect를 보유한다. MAC과 host bridge의 유일한 private IPv4 ARP 항목을 결합하며, 주소만으로 신뢰하지 않는다. 해당 주소에서 **준비 때 생성한 고정 server key**와 native client key로 SSH 인증해야 한다.

root provisioning key는 고정 `--authenticated-boot` 명령만 실행할 수 있다. 이 명령은 읽기 전용 status 또는 엄격한 부팅 요청만 받는다. 최초 일회성 비밀 소비 여부는 인증된 status에서 직접 확인한다. 임의 shell/sudo 명령을 제공하지 않는다. guest용 key는 root 권한이 없으며 고정 endpoint만 실행한다. root는 guest IOKit UUID, 현재 boot UUID, root 소유 파일 digest를 직접 검증하고 boot.json을 마지막 commit point로 설치한다. 같은 부팅 nonce 교체는 거부한다.

네이티브는 설치 receipt의 fresh challenge·빌드·부팅 신원과 독립 endpoint identity 응답을 대조한 뒤 connectionDir을 생성한다. 외부 receipt/manifest를 받는 API는 없다. 각 register/renew에서 root status의 현재 boot/설치 digest, endpoint nonce/task identity, pin·client key·MAC/NAT·소유 생존을 다시 확인한다. lease는 45초 이내다. `release`, unknown, EOF, 변경된 증거와 만료는 VM을 격리한다.

VM 디렉터리와 고정 상태 디렉터리에는 durable quarantine 표식을 유지한다. 명시 복구만 직접 소유한 runner의 `wait()` 종료와 같은 열린 파일의 inode/device를 확인하고 자기 표식을 교체할 수 있다. 다음 runner는 같은 디스크에 배타 잠금을 잡는다. 파일 복사나 수동 표식 삭제는 신뢰 복구가 아니다. 같은 UID/root 및 로드된 확장 전체를 공격자로 격리하는 OS 샌드박스는 아니다.

## 실행 검증의 한계

오프라인 타입·구성·계약 검사는 실제 macOS 설치, VZ 디스크 잠금 호환, NAT ARP 수집, root SSH/PAM, 게스트 계정 로그인·TCC, register/renew 및 복구의 실제 부팅 성공을 증명하지 않는다. 이 항목들은 사용자 실행 시 검증해야 한다. 실패 시 원시 SSH 오류·키·nonce를 로그나 모델 결과로 보내지 않는다.

공식 근거: [VZMacOSInstaller](https://developer.apple.com/documentation/virtualization/vzmacosinstaller), [macOSGuestAutomountTag](https://developer.apple.com/documentation/virtualization/vzvirtiofilesystemdeviceconfiguration/macosguestautomounttag). 로컬 Xcode Virtualization SDK 선언과 실제 Swift 타입 검사도 함께 사용한다.
