<p align="center">
  <img src="docs/assets/logo.svg" width="88" alt="">
</p>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/wordmark-dark.svg">
    <img src="docs/assets/wordmark-light.svg" height="40" alt="Ondra">
  </picture>
</p>

<p align="center"><b>AI의 말을, 보이게.</b></p>

<p align="center"><a href="README.md">English</a> · <b>한국어</b></p>

<p align="center">
  <a href="https://github.com/3x-haust/ondra/releases"><img src="https://img.shields.io/github/v/release/3x-haust/ondra?include_prereleases&label=release&color=1f6fd8" alt="release"></a>
  <img src="https://img.shields.io/badge/platform-macOS%2013%2B%20·%20Apple%20silicon-18181b" alt="platform">
  <img src="https://img.shields.io/badge/status-beta-f59e0b" alt="beta">
</p>

<p align="center">
  <img src="docs/assets/main.png" width="880" alt="Ondra 메인 화면">
</p>

Ondra는 macOS용 에이전트 작업 공간이에요. 메인에게 한 번 말하면, 메인이 일을 나눠 여러 에이전트에게 맡기고, 각자 끝까지 해요. 나는 메인만 보고 있으면 돼요. 길고 어려운 LLM의 말은 진행 막대, 바뀐 파일, 화면, 선택지로 바뀌어서 보여요.

## 무엇을 하나요

**메인이 일을 나눠요.** "포트폴리오 사이트 만들어 줘" 같은 요청을 자료 확인, 레퍼런스 찾기, 계획, 만들기, 확인으로 나누고, 앞 단계가 끝나야 다음 단계가 시작돼요. 일은 프로젝트 폴더의 워크트리에서 따로 돌아요.

**읽지 않고 봐요.** 일은 글 대신 블록으로 보고해요. 계획과 진행, 바뀐 파일과 줄 수, 전후 스크린샷, 표, 체크리스트로요. 도구 호출 수십 개는 "파일 5개 수정함", "명령 3개 실행함"처럼 묶여요.

**판단할 것만 물어요.** 의도나 취향이 필요한 것만 선택지와 맥락을 붙여 메인으로 올라와요. 하나를 고르고 엔터를 누르거나, 직접 적으면 돼요.

<p align="center">
  <img src="docs/assets/job.png" width="880" alt="일 화면과 질문 카드">
</p>

**손과 눈이 있어요.**
- 공유 브라우저: 앱 안의 헤드리스 Chrome 하나를 모든 일이 각자 탭으로 써요. 로그인은 한 번이면 되고, macOS 키체인에서 바로 가져와요. 비밀번호는 모델에 닿지 않아요.
- 컴퓨터 유즈: 접근성 API로 맥 앱을 다뤄요. 마우스와 포커스를 가져가지 않아요.
- 디바이스 유즈: 일마다 자기 iOS 시뮬레이터나 Android 에뮬레이터를 만들어 쓰고, 끝나면 지워요. 디바이스 화면에서 같이 보고 만질 수 있어요.

**캔버스와 기억.** 프로젝트와 일이 어떻게 이어지는지 캔버스에서 한눈에 봐요. 규칙, 취향, 배운 점은 기억에 남고, 필요할 때만 관련된 것을 꺼내 써요.

<p align="center">
  <img src="docs/assets/canvas.png" width="880" alt="캔버스">
</p>

## 설치

1. [Releases](https://github.com/3x-haust/ondra/releases)에서 `Ondra_<version>_aarch64.dmg`를 받아 Applications로 옮겨요.
2. 베타 빌드는 공증(notarization) 전이에요. 처음 열 때 Finder에서 앱을 오른쪽 클릭하고 **열기**를 누르거나, 아래 명령을 한 번 실행해요.

   ```sh
   xattr -dr com.apple.quarantine /Applications/Ondra.app
   ```
3. 설정에서 모델 계정(Codex/ChatGPT 등)을 연결하면 바로 쓸 수 있어요. 컴퓨터 유즈는 손쉬운 사용 권한, 화면 기록 권한을 한 번 물어요.

요구 사항: macOS 13 이상, Apple silicon. 디바이스 유즈에는 Xcode(iOS 시뮬레이터)나 Android SDK(에뮬레이터)가 필요해요.

## 소스에서 빌드

```sh
pnpm install
cp .env.example .env        # 필요하면 값 채우기
pnpm bundle                 # agent-browser, agent-desktop, 엔진, 헤드리스 Chrome을 앱 안으로
pnpm tauri dev              # 개발 실행
pnpm tauri build && pnpm dmg   # .app, 그다음 설치용 .dmg (pip install ds_store mac_alias)
```

- 에이전트 엔진은 [3xhaustpi](https://github.com/3x-haust/3xhaustpi)의 coding-agent를 한 파일로 빌드해 써요. 옆 폴더에 두거나 `ONDRA_ENGINE_DIST`로 위치를 알려 줘요.
- agent-desktop 1.1.0은 macOS 27에서 pid가 -1인 앱(Xcode Device Hub)이 있으면 모든 명령이 멈춰요. `scripts/patches/`의 패치를 적용해 빌드한 바이너리를 `~/.cache/ondra/agent-desktop-patched`에 두면 번들이 그걸 써요.

### 로컬 설정 (`.env`)

| 키 | 뜻 |
|---|---|
| `ONDRA_PROTECTED_DEVICES` | 어떤 일도 켜거나 다루면 안 되는 기기 이름(정규식). 예: 팀이 같이 쓰는 시뮬레이터 |
| `ONDRA_DEVICES_ALLOWED` | 일이 직접 만든 것 말고도 써도 되는 기기 |

개발 빌드는 저장소의 `.env`를, 설치한 앱은 `~/Library/Application Support/dev.3xhaust.ondra/.env`를 읽어요.

## 구조

```
src/                 SolidJS 화면
  engine/            메인(captain)과 일(tasks), 프롬프트, 엔진 RPC
  views/ ui/         화면과 부품 · styles/ 디자인 토큰
src-tauri/src/       Rust: 엔진 프로세스, 공유 브라우저, 키체인, 기기, 알림
skills/              모든 일이 받는 스킬 (visual-report, browser-use, computer-use, device-use, web-design …)
extensions/          엔진 확장 (device 도구, 권한, 훅, 기억)
evals/               하네스 평가와 개선 루프
brand/ docs/         브랜드, 디자인 시스템
```

## 평가와 개선 루프

Ondra를 고치는 기준은 "다음 요청을 혼자 잘하나"예요. `evals/cases/`의 사례를 실제로 메인에게 보내고 채점해요.

```sh
node evals/run.mjs                  # 전체
node evals/run.mjs cu-calculator    # 하나만
```

완료 여부, 답, 증거 스크린샷, 걸린 시간, 도구 수, 실패한 도구, 포커스를 가져갔는지, 기기를 정리했는지를 봐요. 결과는 `evals/results/`에, 무엇을 배웠는지는 `evals/LEARNINGS.md`에 쌓여요. Claude Code에서는 `/ondra-eval`(또는 `/loop /ondra-eval`)이 돌리기 → 원인 찾기 → 스킬·프롬프트·도구 고치기 → 다시 돌리기를 반복해요.
