# map.json

One JSON object. Ids are lowercase-kebab (`job-runner`, `작업-실행` works too)
and unique across the whole map. Write labels and notes in the user's language.

```json
{
  "version": 1,
  "system": { "label": "Shop" },
  "summary": "주문을 받는 웹앱과 결제·배송을 처리하는 API 서버. 둘은 HTTP로만 이야기해요.",
  "built": { "commit": "set by check --stamp", "at": "2026-11-13" },
  "ignore": ["**/*.test.ts", "fixtures/**", "scripts/**"],

  "actors": [
    { "id": "shopper", "label": "구매자", "note": "브라우저로 주문" }
  ],
  "externals": [
    { "id": "stripe", "label": "Stripe", "note": "카드 결제", "logo": "stripe" },
    { "id": "postgres", "label": "Postgres", "kind": "db", "logo": "postgresql" }
  ],
  "containers": [
    { "id": "web", "label": "웹앱", "kind": "app", "tech": "Next.js", "entry": "web/app/layout.tsx", "note": "화면과 장바구니" },
    { "id": "api", "label": "API 서버", "kind": "service", "tech": "Hono · Node", "entry": "api/src/index.ts", "note": "주문·결제·배송" }
  ],
  "components": [
    { "id": "checkout-ui", "container": "web", "label": "결제 화면", "paths": ["web/app/checkout/**"], "entry": "web/app/checkout/page.tsx", "note": "주소·카드 입력" },
    { "id": "orders", "container": "api", "label": "주문", "paths": ["api/src/orders/**"], "note": "주문 생성과 상태",
      "gotchas": ["상태는 orders/state.ts의 전이표로만 바꿔요"], "files": { "api/src/orders/state.ts": "상태 전이표" } },
    { "id": "payments", "container": "api", "label": "결제", "paths": ["api/src/payments/**", "api/src/webhooks/stripe.ts"], "note": "Stripe 청구와 웹훅" }
  ],
  "relations": [
    { "from": "shopper", "to": "checkout-ui", "label": "주문" },
    { "from": "checkout-ui", "to": "orders", "label": "주문 생성", "tech": "HTTP POST /orders", "ref": "web/app/checkout/actions.ts:31" },
    { "from": "orders", "to": "payments", "label": "청구 요청", "ref": "api/src/orders/create.ts:58" },
    { "from": "payments", "to": "stripe", "label": "카드 청구", "tech": "HTTPS" },
    { "from": "stripe", "to": "payments", "label": "결제 완료 알림", "tech": "webhook", "async": true },
    { "from": "orders", "to": "postgres", "label": "저장", "kind": "data" }
  ],
  "flows": [
    { "id": "place-order", "label": "주문하기", "steps": [
      { "from": "shopper", "to": "checkout-ui", "label": "결제 누르기" },
      { "from": "checkout-ui", "to": "orders", "label": "POST /orders" },
      { "from": "orders", "to": "payments", "label": "청구" },
      { "from": "payments", "to": "stripe", "label": "카드 청구" }
    ] }
  ]
}
```

## Fields

| where | field | meaning |
|---|---|---|
| top | `system.label`, `system.outside` | the system's name; the label of the box around outside systems (`외부` by default) |
| top | `summary` | 2–3 sentences: what the system is and how it is split. Shown under the system picture. |
| top | `built.commit` | the commit the map was last true for; only `check --stamp` writes it |
| top | `ignore` | globs for source files that belong to no part (tests, fixtures, generated, samples) |
| container | `kind` | the box shape in the `arch` block: `app`, `service`, `function`, `db`, `cache`, `queue`, `storage`, `gateway` |
| container | `tech`, `entry` | what it is built with; the file where it starts (opens from the picture) |
| component | `container` | the container id it lives in |
| component | `paths` | globs relative to the repo: `**` any depth, `*` one folder level; a bare folder means all of it. A file belongs to the most specific match. |
| any box | `short` | a name of 10 characters at most, used where space is tight (flow pictures) |
| any box | `logo` | a real product's brand name or slug. Without it, a box shows a logo only when its label or note is all Latin and names a brand (`Postgres`, `Next.js · Vercel`); `파일·git` gets none |
| component | `kind` | its box in the container picture, as for containers (`service` when left out; `app` for UI parts) |
| component | `entry`, `gotchas`, `files` | where to start reading (opens from the picture); traps a changer must know; notes on single files |
| relation | `from`, `to` | any two ids (actor, external, container or component). A component-to-component relation shows as a container-to-container line on the system picture. |
| relation | `label`, `tech`, `ref`, `async` | what happens, in plain words (no function or event names); how (HTTP, IPC, socket, stdin, import); `path:line` of the call; a dashed line |
| relation | `overview` | `true` keeps its line on the system picture, `false` leaves it to the container pictures |
| flow | `steps` | `{from, to, label, note?}` in order; six parts at most, plain-sentence labels |

## What the blocks look like

`codemap blocks` (system):

```json
{"type":"arch","label":"Shop 구조","zones":[{"id":"sys","label":"Shop"},{"id":"outside","label":"외부"}],"nodes":[{"id":"shopper","label":"구매자","kind":"user"},{"id":"web","label":"웹앱","zone":"sys","kind":"app","note":"Next.js"},{"id":"api","label":"API 서버","zone":"sys","kind":"service","note":"Hono · Node"},{"id":"stripe","label":"Stripe","zone":"outside","kind":"external","logo":"stripe"}],"edges":[{"from":"web","to":"api","label":"주문 생성"},{"from":"api","to":"stripe","label":"카드 청구"}],"say":"…"}
```

`codemap blocks --container api` draws the same kind of picture one level down:
the container as the zone with its components inside, and the containers and
outside systems they talk to around it. A line between two parts that several
relations share carries the first one's verb.
