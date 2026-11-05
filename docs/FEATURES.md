# Ondra 기능 목록 · 참고한 화면

에이전트 앱에 있는 기능을 다 모았어요. 기능마다 가장 잘 만든 앱의 화면을 기준으로 했어요.

| 영역 | 기능 | 참고 | 어디에 |
|---|---|---|---|
| 틀 | 캔버스 위 카드 두 장(가운데 · 패널), 8px 틈 | Arc, Codex 앱 | `t3.css` shell v2 |
| 왼쪽 | 한 줄 목록, 상태 점, 최신순, 고정, 보관함, 이전 N개 | T3 Code, ChatGPT 사이드바 | `Sidebar.tsx` |
| 왼쪽 | 행에 올리면 고정 · 보관 버튼, 오른쪽 클릭 메뉴(열기 · 이름 · 고정 · 복제 · 복사 · 보관) | Linear, ChatGPT | `RowMenu` |
| 가운데 | 메인 ↔ 일 대화가 옆으로 넘어가며 바뀜 | Codex 앱 | `App.tsx` `Slide` |
| 대화 | 일하는 동안 전부 보이고, 끝나면 "N분 동안 작업 ›"으로 접힘 + 요약만 남음 | Codex 앱 | `Transcript.tsx` `TurnView` |
| 대화 | 보낸 메시지 고치기(그 지점부터 다시), 다시 하기, 복사, ↑로 마지막 메시지 고치기 | ChatGPT, Claude | `MsgActions.tsx`, `editTurn`, `editMain` |
| 대화 | 답마다 tok/s · 캐시 히트 % · 걸린 시간, 올리면 입력/출력 토큰 | Claude Code, 터미널 에이전트 | `UsageLine` |
| 입력 | `/` 명령 메뉴(compact · stop · rename · 권한 · 패널 도구…) | Claude Code, Cursor | `Composer.tsx` |
| 입력 | `@` 파일 고르기 | Cursor, Claude Code | `Composer.tsx` |
| 입력 | 권한(매번 묻기 · 편집 허용 · 전체 권한), 모델 + 생각 깊이(low~max), 첨부, 멈추기 | Codex 앱 | `ModelPicker.tsx` |
| 입력 아래 | 상태 줄: 계정 · 5h · 7d · 컨텍스트 사용량(눌러서 정리) · 셸 · 브랜치 | Claude Code 상태 줄 | `StatusLine` |
| 패널 | 브라우저처럼 탭(+ 새 탭, ×), 새 탭 = 도구 목록 + 단축키 | Codex 앱 | `Panel.tsx` |
| 패널 | 변경(Pierre diff, 단어 강조), 파일, 터미널, 브라우저, 정보, 흐름 | T3 Code, Conductor | `Review.tsx` |
| Git | 합치기 · 버리기 · 커밋 · 푸시 · PR 만들기 | Conductor, Codex 앱 | `ShipMenu`, `git.rs` |
| 일 | 이름 바꾸기(두 번 클릭), 고정, 복제, 보관, 삭제, 대화 Markdown 복사, 대화 정리 | ChatGPT, Linear | `TaskView.tsx` |
| 알림 | 창이 뒤에 있을 때 끝남 · 답 필요 · 멈춤을 시스템 알림으로 | Codex 앱, Claude 데스크톱 | `App.tsx`, `notify` |
| 캐시 | 메인은 바뀐 것만 보냄(목록 · 기억), 긴 캐시 유지(Anthropic 1시간), 되감기는 fork로 앞부분 그대로 | — | `captain.ts`, `tasks.ts` |
| 메인 대화 | 대화는 앱에 글로만 남고, 엔진 세션은 뒤에서 계속 비움(8분 조용하면 · 24K 토큰 넘으면). 새 세션은 최근 대화 16줄 + 일 목록 + 기억으로 시작. 고정 앞부분은 세션이 바뀌어도 캐시에 남음(재 본 값 96%) | — | `captain.ts` `clearSession`, `sessions_prune` |
| 기억 | 메인/일이 기억할 것을 저장, `/remember`로 바로 저장, 설정에서 보고 고침 | ChatGPT 메모리, Claude Code `#` | `memory.ts` |
| 목록 | 새로 맡기기 버튼, "확인할 일 N"(누르면 다음 일로), 올리면 고정 · 보관(상태는 그대로 보임), 우클릭 메뉴 | Codex 앱, Linear | `Sidebar.tsx` |
| 대화 | 위로 올려 읽을 때 "맨 아래로" | ChatGPT, Claude | `Transcript.tsx` |
| 대기 중인 일 | 몇 번째인지 + 지금 시작 | Conductor | `Transcript.tsx` |
| 팔레트 | 찾은 것 먼저, 보기 명령(패널 · 목록 · 테마), 마지막에 메인에게 보내기 | Linear, Raycast | `Palette.tsx` |
| btw | `/btw 질문`: 지금 보는 대화(메인·일)를 보고 바로 답, 도구 없음, 대화에 안 남음. 입력창 위 카드 → 복사 · 시키기 | 3xhaustPi `/btw`, Claude Code `/btw` | `aside.ts`, `Aside.tsx` |
| 사이드챗 | 공간마다 따로 하는 두 번째 대화(⌘J, 패널 탭). 파일은 읽기만, 글로 저장, 답을 메인에게 보내기 | 3xhaustPi Side Chat, Codex | `aside.ts`, `Aside.tsx` |
| 프로젝트 채팅 | 전체 메인 + 프로젝트(폴더)마다 채팅 하나. 그 채팅에서 맡긴 일은 그 폴더에서 시작. 일했던 레포는 자동으로 프로젝트가 됨 | Codex 앱 프로젝트 | `captain.ts`, `Sidebar.tsx` |
| 캔버스 | 메인 → 프로젝트 → 일 → 서브에이전트를 선으로 잇는 지도. 카드 아이콘이 지금 쓰는 도구로 바뀌고 움직임, 단계 막대·계획·diff로 상태를 그림으로. 끌어 옮기기(위치 저장) · 확대/축소 · 미니맵 · 올리면 그 줄기만 · 누르면 오른쪽 상세 · ⌘⇧B. 목록 보기는 전 보드 | Railway 캔버스, Artiboard 그래프, Maestri | `Canvas.tsx` |
| 답 통계 | 속도 · 캐시 · 시간을 답마다 붙이지 않고 입력창 아래 상태줄에 마지막 답 것만 | Claude Code 상태줄 | `Usage.tsx` |
| 결과물 | 일이 만든 HTML 페이지·사진·영상을 패널 "결과물" 탭에서 바로 봄(페이지는 안에서 실행). 결과물 폴더 + 일이 따로 쓴 .html/.svg/사진도 잡음. 입력창 위 "결과물 N개" | Claude 아티팩트 | `artifacts.ts`, `Panel.tsx` |
| 그림으로 설명 | `/draw` 또는 캔버스 상세의 버튼: 한 일을 구조·흐름 그림 한 장으로, 부분마다 파일:줄 | Whiteboard | `Aside.tsx` |
| 추천 시작 | 빈 화면의 시작 문장을 실제 일(안 합친 브랜치, 멈춘 일, 끝난 일의 다음 단계)을 보고 모델이 고름. 3시간 보관, 다시 고르기 | — | `suggest.ts` |
| + 메뉴 | 파일 및 폴더, 프로젝트에서 시작, 스킬, btw, 사이드챗 | Codex 앱 | `Composer.tsx` |
| 사진 | ⌘V로 붙이기, 입력창·채팅에서 미리보기, 눌러서 크게(← →) | ChatGPT, Codex | `Composer.tsx`, `Lightbox.tsx` |
| 슬래시 | Tab은 자동완성만, Enter로 실행, `/이름 내용`을 다 적어도 실행 | Claude Code | `Composer.tsx` |
| btw 기록 | `/btw` 만 치면 지난 btw, ‹ ›로 앞뒤 이동, 앱을 껐다 켜도 남음 | Claude Code | `aside.ts` |
| 디자인 구현 | 피그마 링크·"디자인 구현" 요청은 메인이 mimikyu 스킬로 맡김 | — | `prompts.ts` |
| 일하는 순서 | 계획 → 그림(구조·흐름, 파일:줄) → 조사(쓸 수 있는 코드 찾기) → 개발(재사용·깔끔) → 리뷰 서브에이전트 → 증거 | gajae-code, Whiteboard | `prompts.ts` |
| 리뷰 | 코드를 바꾼 일은 끝내기 전에 리뷰 서브에이전트(code-review 스킬)가 보고, 결과가 일에게 돌아가 고침 | Matt Pocock code-review | `skills/code-review`, `tasks.ts` |
| 증거 | done의 증거를 앱이 세션 기록과 대조(그 명령을 실제로 돌렸나·통과했나·그 뒤 코드가 바뀌었나·파일이 있나). 안 맞으면 이유와 함께 최대 2번 돌려보내고, 남은 건 "확인 안 됨". 각 증거에 앱이 확인/자가 신고/안 맞음 표시. 리뷰에서 P1·P2가 나왔는데 안 고치면 돌려보냄 | OmO claim-receipt, gajae-code | `proof.ts`, `tasks.ts`, `Blocks.tsx` |
| 그림 블록 | 상자와 화살표로 구조·흐름. 새로/바뀜/없앰, 요청/AI 판단 표시. 일이 끝나도 접히지 않음. 메인 답에도 씀 | Whiteboard | `Diagram.tsx` |
| 기록 | now.md·context·memory 같은 메모 파일 쓰기는 코드 수정이 아니라 "기록했어요" 줄로, 눌러서 내용 보기 | — | `Transcript.tsx` |
| 작업 기록 | 펼치면 중간 설명 글 사이에 "명령 3개를 실행했어요" 같은 한 줄 도구 줄 | Codex 앱 | `Transcript.tsx` |
| 스킬 | + 메뉴·/명령에는 lms·weekly만. 나머지는 일이 알아서 씀(설정에서 메뉴에 넣기/빼기) | — | `Settings.tsx` |
| 그림 종류 | 질문에 맞는 그림: 범위(scope)·얼마나(bars)·어디(tree)·무엇으로(groups, 부분끼리 화살표)·누가 누구에게(sequence)·순서(steps). 짧은 라벨 규칙 | Dan Roam, Mayer, Cleveland & McGill | `Visuals.tsx`, `prompts.ts` |
| 페이지 블록 | 일이 만든 HTML 보고서를 채팅 안에서 바로 보여 줌 | — | `Blocks.tsx` |
| 미리보기 | 파일·링크·칩을 누르면 앱 패널에서 열림(HTML·PDF·이미지·마크다운·코드). 편집기·Finder 버튼. git 아닌 폴더는 변경 탭에 일이 쓴 파일 목록 | Codex | `Review.tsx` |
| 메인 이어가기 | 메인이 맡긴 일이 끝나면 결과를 받아 사용자에게 알리고 다음 일을 바로 맡기거나 물어봄(연속 6번까지) | — | `captain.ts` |
| 대기열 | 일하는 중에 보낸 말은 입력창 위 대기열에 쌓였다가 일이 끝나면 차례로 들어감. "지금 끼어들기"·빼기·눌러서 고치기 | Codex | `tasks.ts`, `TaskView.tsx` |
| 할 일 | 입력창 위에 할 일 전체(끝남·지금·다음), 접기 | OmO | `TaskView.tsx` |
| 디바이스 조작 | 허브에서 기기를 크게 열고 누르기(탭)·끌기(스와이프)·홈·뒤로·글자 입력. iOS는 agent-device, Android는 adb. 화면은 새 사진이 다 받아진 뒤에 바뀜 | agent-device | `devices.rs`, `Devices.tsx` |
| device-use 스킬 | 일이 자기 시뮬레이터를 만들어 쓰고, 증거 사진 남기고, 끝나면 지움 | — | `skills/device-use` |
| 기억 화면 | 전체›공간›프로젝트 트리, 옵시디언 같은 그래프(같은 얘기 하는 기억끼리 연결), 지침·노트 파일까지. 고르면 오른쪽에서 고치기·지우기 | Obsidian | `Memory.tsx` |
| 첫 화면 | 가운데 질문 + 입력창 + 그 아래 시작 제안 몇 개 | Codex | `MainView.tsx` |
