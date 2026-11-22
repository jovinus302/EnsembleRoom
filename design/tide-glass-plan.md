# Tide Glass 적용 계획
기준 목업: design/mockups/02-tide-glass.html

## 확정된 결정 (사용자 선택)
- 9-1 작업 위치: A — 별도 worktree(`../EnsembleRoom-tide`, 브랜치 `feat/tide-glass`), 겹치는 4개 파일 단계는 Gate G 뒤로
- 9-2 폰트: A — npm self-host(`pretendard`, `@fontsource-variable/dm-sans`, `@fontsource/jetbrains-mono`)
- 9-3 하늘: A — 절차적 하늘 셰이더(HDRI 다운로드 없음)
- 9-4 캔버스 전체 화면화(Step 16): A — 이번 범위에 포함, 맨 마지막 별도 커밋

STATUS: SUCCESS
- 결정/계획: 순서는 **토큰 → 공용 프리미티브(CSS 클래스) → 화면별 적용**으로 간다. 토큰은 **새 Tide 토큰을 기준으로 두고, 기존 변수 이름은 호환 별칭으로 남긴다**. 이렇게 하면 Step 2 하나만으로 앱 전체가 새 팔레트로 바뀌고, 이후 화면 단계에서 별칭을 하나씩 걷어낸다. 3D 하늘은 **HDRI를 쓰지 않고 절차적 하늘 셰이더로 바꾼다**(에셋 다운로드 없음, `--scene-*` 색을 그대로 따른다). 작업은 **별도 worktree와 브랜치**에서 하고, 다른 사람이 수정 중인 파일을 건드리는 단계는 맨 뒤로 미룬다.
- 실행 계획: 아래 0~17단계
- 트레이드오프: 섹션 1, 3, 6, 7에 정리

---

## 0. 직접 확인한 사실 (계획의 근거)

추정과 구분하려고 직접 확인한 것만 모았다. 추정은 본문에 "(추정)"으로 표시했다.

**작업 트리 상태**
- 미커밋 변경 11개: README, server 3개(`runTurn.ts`, `seed.ts`, 테스트), `web/api/ws.ts`, `avatar/portrait.ts`, `messenger/Avatar.tsx`, `messenger/MessageList.tsx`, `room/AgentStatusList.tsx`, `room/RoomStage.tsx`.
- untracked: `apps/web/vite.s50.config.ts`(포트 5197/8795), `design/`, `.claude/`.
- **`vite.s50.config.ts`가 있다는 것은 다른 세션이 이 작업 트리에서 다른 포트로 dev 서버를 돌리고 있다는 뜻이다.**
- **목업이 있는 `design/`이 untracked라서, HEAD에서 만든 worktree에는 목업이 없다.**

**3D 캔버스 배치 (구조상 가장 중요한 사실)**
- `stage/WorldHost.tsx` 123–126, 170–172행:
  - Room 화면: 캔버스가 화면 전체가 아니라 **RoomStage 슬롯 사각형 크기로만** 그려진다.
  - 메신저: 화면 폭 전체이지만 **세로는 band 슬롯 아래끝까지만** 그려진다.
- 그래서 목업처럼 "장면이 화면 전체에 깔리고 패널이 그 위에 떠 있는" 모습을 만들려면, 캔버스를 화면 전체로 넓히고 카메라 투영을 슬롯 중심으로 옮겨야 한다(Step 16).

**토큰·클래스**
- `themes.css`: 단일 남색 테마. `--card-base: transparent` 때문에 말풍선 바탕이 투명하다.
- `theme.ts`의 `tint()`는 `color-mix(color pct, var(--card-base))` 형태다. `--card-base`를 불투명 `#0e2838`로 바꾸면, 목업 말풍선(색 20%를 `--bubble-base` 위에 얹은 것)과 **결과 색이 같다**.
- `interactions.test.tsx:132`가 `'#5ab0ff var(--ink-pct)'` 문자열을 검사한다. 그래서 `ink()`의 출력 형식은 바꾸면 안 된다.
- `surface-card`는 6곳, `chat-surface`는 1곳에서 쓰이는데 CSS 정의가 없다. `surface-sheet`만 정의돼 있다.
- `backdrop-blur`는 10개 파일, 17곳에서 쓰인다.

**승인 색이 4가지로 흩어져 있음**
- `#ffc88c`: `PALETTE.approvalOrange`(shared, 3D의 `Actor`/`CapsuleShell`/`InteriorLights`도 사용)
- `#ff9f43`: `RoomView.tsx:126`, `ApprovalPanel.tsx:30`, `eventLabel.ts:79`
- `#ff9a3c`: `INTERACTION_COLORS.a2h`, `Actor.tsx:818,820`
- `--approval-ink`
- `APPROVAL_ORANGE`는 `` `${APPROVAL_ORANGE}88` ``처럼 **hex 뒤에 알파를 이어 붙여** 쓰인다. 따라서 CSS 변수로 바꿀 수 없고, hex 문자열로 남아야 한다.
- `packages/shared/test/colors.test.ts:71`이 `#FFC88C`를 예약색으로 검사한다.

**사람·Agent 색은 목업과 이미 같다**
- `USER_COLORS.coral #ff7f6e`, `sky #5db8f0`, `agentMintLight #64e4bd`, `roomAgentLime #b8e86a`가 목업의 `--alice/--bob/--agent/--room`과 같다.
- 보드 도구 종류 색(`--bt-c-*`)도 목업의 `--k-*`와 같다.

**3D 장면**
- `Beach.tsx`:
  - `sunset_1k.hdr`(Poly Haven venice_sunset, CC0)로 하늘 돔, 환경 캡처, 바다 반사를 만든다. 셋 다 같은 `SKY_GLSL`의 `skyColor(vec3 d)` 함수를 쓴다.
  - 조명: 태양 `#ffa95a` 7.2, 보조광 `#ffcfc4` 0.95, 반구광 `#ffd9b8`/`#c98a68` 0.55.
  - 모래 `#f6e6d2`, 포말 크림색.
- `sky.ts`: `FOG_COLOR #e9a67c`, 태양 고도 15°, HDR 태양 방위가 상수로 박혀 있다.
- `Postfx.tsx`: N8AO, Bloom(threshold 2.0), TiltShift, Vignette(0.55), AGX, HueSat, BrightnessContrast.
- `WorldCanvas.tsx:75`: postfx가 꺼진 low 단계에서는 렌더러가 AgX를 쓴다.
- `CapsuleShell.tsx:124`: 접지 그림자 `#1a0d06`, 0.62.
- `InteriorLights.tsx`: 실내 조명 `#ffb066`.

**라벨·말풍선**
- `world/agents/labels.tsx`:
  - 말풍선: 384×168 캔버스, 크림 `#fffdf8`, 5px 사람색 테두리, 가운데 삼각 꼬리, 글자 `#2b2118`, 폰트 Malgun.
  - 이름표: 사람은 알약, Agent는 모서리를 깎은 태그.
- `LabelLayer.tsx`: DOM 칩을 inline style로 그리고 `--label-*` 토큰을 쓴다. 겹침 회피에 `offsetWidth`를 쓴다.

**품질·폰트·테스트**
- `quality.ts`: `usePerf().tier`가 실제 품질 단계다. `stageStore`의 `QualitySetting`은 `auto|high|mid|low|off`이고, `?q=` 파라미터로 강제할 수 있다.
- `public/assets/fonts`에는 `NotoSansKR-Bold-subset.ttf`(3D 간판용 troika 폰트)뿐이다. 웹폰트는 없다.
- 테스트: web vitest 7개 파일(`interactions`, `InteractionChip`, `boardTools`, `derive`, `plan`, `boardToolScene`, `routing`), `packages/shared/test`. e2e(playwright) 설정은 없다.

**목업**
- `?only=<섹션id>` 파라미터를 지원한다(`hero`, `messenger`, `tokens`, `panel`, `chat`, `approval`, `board`, `agents`, `over3d`, `sheets`, `motion`). 해당 섹션만 단독으로 보여 주므로 시각 비교 기준으로 쓰기 좋다.

---

## 1. 전략 결정과 근거

### 1-1. 순서: 토큰 → 공용 프리미티브 → 화면 (채택)
- 지금 TSX에는 `bg-panel`, `border-line`, `text-muted`, `bg-raised` 같은 의미 토큰 클래스가 105곳 넘게 쓰인다.
- 그래서 토큰 값만 바꿔도 화면의 70% 정도가 새 색으로 바뀐다(추정).
- 그 다음 프리미티브를 만들고, 화면 단계에서 모양(radius, 떠 있는 배치, 버튼 variant)을 맞춘다.
- 3D(Step 12–13)는 CSS 토큰에 의존하지 않는다. Step 2 이후 2D 작업과 **병렬로** 진행할 수 있다.

### 1-2. 토큰 구조: 새 토큰 + 호환 별칭 (추천)

| 안 | 장점 | 단점 |
|---|---|---|
| A. 기존 이름 유지, 값만 교체 | 수정량이 가장 적다 | 목업에 있는 primary/amber/card/popover/concave/solid 등은 기존 이름에 대응하는 것이 없다. 결국 새 이름이 생기고 체계가 섞인다 |
| B. 새 토큰만 쓰고 기존 이름 삭제 | 깔끔하다 | 한 번에 수십 개 파일을 고쳐야 해서 단계로 나눌 수 없다 |
| **C. 새 Tide 토큰을 기준으로 두고 기존 이름은 별칭으로 둔 뒤 점진적으로 제거** | 앱이 매 단계 돌아가는 상태를 유지하고, 목업 토큰과 1:1로 대응한다 | 정리하는 동안 이름이 두 벌 있다 → Step 17에서 정리 |

### 1-3. 프리미티브를 둘 곳: 새 파일 `apps/web/src/styles/tide.css`
- `@layer components` 안에 **`tg-` 접두사 CSS 클래스**로 둔다.
- 목업 클래스와 1:1로 대응한다(`.btn-primary` → `.tg-btn.tg-btn-primary`).
- 접두사를 붙이는 이유: Tailwind 유틸리티(`.card`, `.chip` 류), 그리고 기존 `.anim-*`와 이름이 충돌하지 않게 하기 위해서다.
- Tailwind v4에서는 utilities 레이어가 components 레이어보다 우선한다. 그래서 TSX에서 유틸리티로 미세 조정할 수 있다.
- 사람 색은 `style={{'--c': color}}`로 넘긴다.
- 타입 도우미로 `apps/web/src/ui/tg.ts` 하나를 만든다:
  - `btn(variant, opts)` → 클래스 문자열
  - `cvar(color)` → `{'--c': color} as React.CSSProperties`
- **React 컴포넌트 라이브러리는 만들지 않는다.**
  - 얻는 것: 기존 JSX 구조를 거의 그대로 두고 className만 바꾸면 된다. Sonnet이 단계별로 다루기 쉽다.
  - 포기하는 것: variant 조합을 컴파일 시점에 강제할 수 없다. 이 부분은 `tg.ts` 도우미로 일부 보완한다.

---

## 2. 단계별 작업 목록

### 공통 규칙 (모든 단계)
- **검증 명령**
  - 매 단계: `npm run typecheck -w apps/web`, `npm test -w apps/web`
  - shared를 건드린 단계: 위 명령에 더해 `npm test -w packages/shared`
  - Phase가 끝날 때: `npm run build -w apps/web`
- **시각 확인 방법**: 1440×860 창에서 앱을 캡처하고, 같은 크기로 목업의 해당 섹션(`design/mockups/02-tide-glass.html?only=<id>`)과 나란히 비교한다.
- **목업은 정답지이지 복붙 대상이 아니다.** CSS 값은 목업 `<style>`(11–461행)에서 가져온다.
- **`data-testid`, `aria-*`, `role` 속성은 절대 지우거나 바꾸지 않는다.** 테스트와 투어가 이것에 의존한다.
- **pointer-events 규칙을 유지한다.** 컨테이너는 `pointer-events-none`, 패널만 `pointer-events-auto`여야 패널 사이 틈으로 3D 캡슐을 클릭·호버할 수 있다.
- **패널의 조상 요소에는 opacity/filter/transform 애니메이션을 걸지 않는다.** 조상이 backdrop root가 되면 패널의 blur가 장면을 못 보고 꺼진다. 애니메이션은 패널 자신에게만 건다.
- **"보류 파일" 4개**(`messenger/Avatar.tsx`, `messenger/MessageList.tsx`, `room/AgentStatusList.tsx`, `room/RoomStage.tsx`)는 Gate G를 통과한 뒤에만 수정한다.

---

### Step 0 — 작업 환경 준비 (S, 선행 없음, 사용자 결정 9-1이 필요)
1. 사용자 결정에 따라 미커밋 변경을 처리한다(9-1 참고).
2. 추천 경로(worktree)라면 다음을 실행한다:
   - `git worktree add ../EnsembleRoom-tide -b feat/tide-glass`
   - 원 트리의 `design/` 폴더를 새 worktree로 복사하고, 이 브랜치에 커밋한다(목업이 정답지이므로 저장소에 둔다).
   - 새 worktree에서 `npm install`을 실행한다(npm 캐시/네트워크 필요).
3. 포트 충돌을 피하기 위해 다른 포트로 dev 서버를 띄운다.
   - `apps/web/vite.tide.config.ts`를 만든다. `vite.s50.config.ts`와 같은 형식으로 port 5199, proxy target 8797로 한다. 이 파일은 커밋하지 않는다.
   - 서버: `PORT=8797 npm run dev -w apps/server`
   - 웹: `cd apps/web && npx vite --config vite.tide.config.ts`
4. 기준 상태를 기록한다.
   - typecheck와 test를 돌려 통과하는지 기록한다.
   - 현재 메신저 화면, Room 화면, 승인 카드, 시트를 캡처해 둔다. 회귀 비교용이며, 캡처는 스크래치패드에 저장한다.
- **완료 기준**: 새 worktree에서 dev 서버가 뜨고, typecheck와 테스트가 통과한다.

---

### Step 1 — 폰트 self-host (S, 선행 Step 0, 사용자 결정 9-2가 필요)
**수정 파일**: `apps/web/package.json`, `apps/web/src/main.tsx`, `CREDITS.md`

**할 일**
1. 의존성을 추가한다: `pretendard`, `@fontsource-variable/dm-sans`, `@fontsource/jetbrains-mono`(모두 OFL).
2. `main.tsx` 맨 위에 import를 추가한다:
   - `pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css`
   - `@fontsource-variable/dm-sans`
   - `@fontsource/jetbrains-mono/500.css`
   - `@fontsource/jetbrains-mono/600.css`
   - 이 경로들은 추정이다. 설치 후 `node_modules`에서 실제 경로를 확인한다.
3. `CREDITS.md`에 세 폰트를 OFL 1.1로 추가한다.

**완료 기준**
- 개발자도구 Network 탭에 woff2 파일이 로컬(5199)에서 로드된다. 외부 CDN 요청이 0건이어야 한다.
- Step 2 이후, 한글 본문의 computed font가 Pretendard Variable로 나온다.

---

### Step 2 — 토큰 교체 + 호환 별칭 (M, 선행 Step 0; Step 1과 병렬 가능)
**기준**: 목업 16–52행 `:root`, 섹션 03(`?only=tokens`)
**수정 파일**: `apps/web/src/themes.css`, `apps/web/src/index.css`

**`themes.css`**
1. 파일 상단에 목업 16–52행의 `:root` 토큰과 `prefers-reduced-motion`의 `--motion:0`을 **그대로** 옮긴다.
   - 포함: surface, action, actors(`--agent`, `--room`, `--bubble-base`만), scene, tool keys, radius, type, motion.
   - 제외: `--alice`, `--bob`. 목업 시연용 색이고 실제 앱은 데이터의 사용자 색을 쓴다.
   - `--mono`에서 `"Google Sans Code"`는 뺀다.
2. 패널 투명도 변수를 새로 둔다: `--panel-alpha: .86`.
   - `--panel-top: rgb(10 34 46 / var(--panel-alpha))`
   - `--panel-bottom: rgb(6 19 28 / var(--panel-alpha))`
3. 기존 이름은 아래 표대로 **별칭으로 다시 정의**한다. 기존 `:root` 블록의 해당 줄을 교체한다.

| 기존 | 새 값 |
|---|---|
| `--scheme` | `dark` |
| `--bg` | `var(--concave)` |
| `--panel` | `rgb(10 34 46 / var(--panel-alpha))` |
| `--panel-raised` | `color-mix(in srgb, var(--fg) 7%, var(--card))` (값은 추정, 시각 확인) |
| `--surface` | `var(--popover)` |
| `--line` | `var(--border)` |
| `--muted` | 목업 값 `#8dbed2` (상단 Tide 블록에서 정의) |
| `--focus` | `var(--primary)` |
| `--accent` | `var(--primary)` |
| `--accent-fg` | `var(--primary-fg)` |
| `--on-accent` | `var(--primary-fg)` |
| `--hover` | `color-mix(in srgb, var(--fg) 8%, transparent)` |
| `--scrim` | `rgba(4,24,34,.62)` |
| `--scrim-tour` | `rgba(3,12,18,.64)` |
| `--glass` | `var(--solid-bg)` |
| `--shadow` | `var(--solid-shadow)` |
| `--radius` | `var(--r-panel)` |
| `--font-title` | `var(--font)` |
| `--danger` | `var(--destructive-ink)` |
| `--warn` | `var(--amber)` |
| `--ok` | `#72efdd` |
| `--card-base` | `var(--bubble-base)` |
| `--card-base-dim` | `var(--card)` |
| `--tint-me` / `--tint-other` / `--tint-agent-room` | `20%` |
| `--tint-agent-dm` | `16%` |
| `--tint-approval-pending` | `13%` |
| `--tint-approval` | `6%` |
| `--tint-mandate` | `10%` |
| `--ink-pct` | `80%` |
| `--ink-base` | `#d9f3f7` (목업 글자 규칙 `color-mix(c 80%, fg)`) |
| `--approval-ink` | `var(--amber-ink)` |
| `--label-bg` | `var(--solid-bg)` |
| `--label-border` | `rgba(217,243,247,.16)` |
| `--label-fg` | `var(--fg)` |
| `--label-fg-dim` | `var(--muted)` |
| `--label-shadow` | `var(--solid-shadow)` |
| `--label-attn-border` | `var(--amber)` |
| `--label-attn-shadow` | `var(--solid-shadow), 0 0 0 3px color-mix(in srgb,var(--amber) 22%,transparent)` |
| `--label-chip-bg` | `color-mix(in srgb,var(--fg) 8%,transparent)` |
| `--label-dot-border` | `rgba(217,243,247,.5)` |
| `--stage-a` | `var(--scene-sky-mid)` |
| `--stage-b` | `var(--scene-sand)` |
| `--stage-idle` | `#2a4a5c` |
| `--thumb-bg` | `var(--popover)` |
| `--tour-dot` | `color-mix(in srgb,var(--fg) 20%,transparent)` |

   - `--sea`, `--sky`, `--plant`, `--sand-gold`, `--star`, `--info`, `--avatar-paper`는 값을 그대로 둔다.
4. `[data-world="on"][data-screen=...]` 두 블록은 `--panel-alpha: .86`만 다시 선언하고, `--panel`/`--panel-top`/`--panel-bottom`을 다시 계산하는 형태로 바꾼다.
   - 이유: 기존과 같다. `:root`에서 한 번 계산된 값은 하위 선택자에서 변수를 바꿔도 다시 계산되지 않는다.
5. `[data-world="off"]` 블록을 추가한다: `--panel-alpha: .96; --panel-filter: none;`. 뒤에 장면이 없으면 blur는 의미가 없다.
6. `body { background: var(--page-bg) }`로 바꾼다.
7. `.surface-sheet`는 `background: var(--panel-bg); border-radius: var(--r-panel);`로 바꾼다.

**`index.css`의 `@theme inline`**
- 기존 매핑은 유지하고 다음을 추가한다:
  - 색: `--color-primary`, `--color-primary-fg`, `--color-amber`, `--color-amber-tonal`, `--color-card`, `--color-popover`, `--color-concave`, `--color-border`, `--color-solid`(→ `--solid-bg`), `--color-destructive`, `--color-destructive-ink`, `--color-agent`, `--color-room-agent`(→ `--room`), `--color-page`(→ `--page-bg`)
  - radius: `--radius-panel: var(--r-panel)`, `--radius-card: var(--r-card)`, `--radius-input: var(--r-input)`
  - 글자 크기: `--text-label: 11px`, `--text-aux: 13px`, `--text-body: 15px`, `--text-title: 20px`, `--text-display: 28px`, 각각 `--text-*--line-height`도 지정(1.2 / 1.4 / 1.5 / 1.25 / 1.2)
  - 폰트: `--font-sans: var(--font)`, `--font-mono: var(--mono)`
  - easing: `--ease-standard: cubic-bezier(.4,0,.2,1)`
- `body`의 `letter-spacing`은 `var(--tracking, 0)`으로, 기본 글자 크기는 `font-size: var(--fs-body)`로 한다.

**완료 기준**
- 앱 전체 바탕이 남색에서 청록 잉크색으로 바뀐다.
- 메신저 말풍선이 투명하지 않고 사람색 tonal 바탕으로 나온다.
- 주요 버튼이 아쿠아로 바뀐다.
- typecheck와 test가 통과한다. 특히 `interactions.test`의 ink 문자열 검사가 통과해야 한다.
- 레이아웃은 아직 바뀌지 않는 것이 정상이다.

---

### Step 3 — 공용 프리미티브 + 모션 코어 (M, 선행 Step 2)
**기준**: 목업 섹션 04 `panel`, 05 `chat`, 06 `approval`, 09 `over3d`, 11 `motion`(CSS 65–183행, 223–247행, 344–457행)
**수정 파일**: `apps/web/src/styles/tide.css`(신규), `apps/web/src/index.css`(import 추가 + 기존 모션 클래스 본문 교체), `apps/web/src/ui/tg.ts`(신규)

**`tide.css` — `@layer components` 안에 `tg-` 접두사로 옮길 것**
- **표면**: `tg-panel`(목업 `.panel`), `tg-card`, `tg-solid`
- **글자**: `tg-mono`, `tg-aux`, `tg-title`
- **버튼**: `tg-btn` 및 `tg-btn-cta`, `-primary`, `-soft`, `-ghost`, `-danger`, `-dghost`, `-round`, `-block`, `-person`
- **칩·배지**: `tg-chip` 및 `.tonal`, `.tag`, `.warn`, `.err`, `.badge-ok`; `tg-pill-amber`, `tg-badge`(목업 `.badge-u`), `tg-switch`
- **입력·선택**: `tg-field`, `tg-input`(목업 `.input`), `tg-tog`, `tg-opt`
- **말풍선**: `tg-bubble` 및 `.other`, `.me`, `.agent`, `.room`, `.warn`, `.paused`, `.err`, `.fail`, `.in3d`; `tg-btag`, `tg-cursor`, `tg-dots`, `tg-notice`(+`.amber`), `tg-a2a`
- **승인 카드**: `tg-appr` 및 `.pending`, `.live`, `.approved`, `.rejected`, `.compact` 와 하위 `.hd`, `.route`, `.sum`, `.prop`, `.acts`; 체크 아이콘 `.chk` 그리기
- **3D 위 요소**: `tg-nametag`(+`.attn`, `.pulse1`), `tg-legend`, `tg-tip`, `tg-seg`, `tg-flow`
- **보드·타임라인**: `tg-kdot`, `tg-toolwin`(`.th`, `.tb`, `.tf`), `tg-track`(`.fill`, `.th`, `.ev`)
- **시트**: `tg-scrim`, `tg-sheet`
- **초상**: `tg-frame` + `.octa` / `.hexa`

**`tide.css` — 그 밖에 들어갈 것**
- `@property --c` 등록(15행). 승인 카드의 색 전환 애니메이션에 필요하다.
- 키프레임을 `tg-` 접두사로 옮긴다: `tg-panel-in`, `tg-pop`, `tg-tool-in`, `tg-fade-in`, `tg-fade-out`, `tg-pop-badge`, `tg-draw`, `tg-glow`, `tg-ring`, `tg-blink`, `tg-bounce`, `tg-dash`, `tg-pulse`, `tg-slide-t`/`-l`/`-r`/`-b`, `tg-tickd`
- 유틸 클래스: `.tg-enter`(panelIn), `.tg-enter-t`/`-l`/`-r`/`-b`
- 목업 453–457행의 reduced-motion 블록을 포함한다.
- 목업의 `.btn:hover`처럼 transform을 쓰는 규칙은 그대로 옮기되, `--motion`을 곱해 감소 모션을 존중하게 한다.
- 임시 호환 클래스: `.surface-card{}`, `.chat-surface{}`를 빈 정의로 둔다(Step 17에서 삭제).

**`index.css` — 기존 모션 클래스는 이름을 유지하고 본문만 교체** (TSX 수정 없음)
- `.anim-in` → `animation: tg-pop var(--dur-pop) var(--ease-out) both`
- `.anim-card` → `tg-panel-in var(--dur-base) var(--ease-out) both`
- `.stream-cursor::after` → 7×15px, radius 2px, `background: var(--agent)`, `tg-blink 1s steps(2) infinite`
- `.work-dots > i` → 6px, `tg-bounce 1.2s infinite`
- `.approval-pending` → 앰버 글로우 `tg-glow 2.4s`(목업 `.appr.pending` + `.live`와 같은 box-shadow)
- `bubble-in`, `card-in`, `approval-pulse`, `live-glow`, `cursor-blink`, `dot-bounce`는 Step 17에서 삭제한다.
- `fx-*` 키프레임은 그대로 둔다(섹션 5 참고).

**`ui/tg.ts`**
```ts
export type BtnVariant = 'cta'|'primary'|'soft'|'ghost'|'danger'|'dghost'|'person';
export function btn(v: BtnVariant, o?: { round?: boolean; block?: boolean }): string
// → 'tg-btn tg-btn-<v>' + ' tg-btn-round' / ' tg-btn-block'
export function cvar(color: string | undefined, name = '--c'): React.CSSProperties
```

**완료 기준**
- 임시 확인 페이지 없이 다음으로 확인한다: 개발자도구에서 임의 요소에 `tg-btn tg-btn-primary`, `tg-panel`을 붙여 보고, 목업 섹션 04와 같은 모양인지 본다.
- 승인 대기 카드가 앰버 글로우로 바뀌었는지 본다.
- OS의 감소 모션 설정을 켜면 루프 애니메이션이 멈추는지 본다.

---

### Step 4 — 품질 단계와 blur 연동 (S, 선행 Step 3)
**수정 파일**: `apps/web/src/App.tsx`, `apps/web/src/styles/tide.css`

**`App.tsx`**
- `useEffect`로 `document.documentElement.dataset.quality`를 설정한다.
  - 값: 월드가 켜져 있으면 `usePerf(s=>s.tier)`, 아니면 `'off'`.
- `<html>`에 거는 이유: `Sheet`가 body로 portal되므로, App의 div에 걸면 시트에 적용되지 않는다.

**`tide.css`**
```css
html[data-quality="mid"]  { --panel-filter: blur(12px) saturate(1.1) brightness(.85); }
html[data-quality="low"], html[data-quality="off"] { --panel-filter: none; --panel-alpha: .95; }
@media (prefers-reduced-transparency: reduce) { :root { --panel-filter: none; --panel-alpha: .96; } }
```
- `--panel-top`/`--panel-bottom` 재계산 문제는 Step 2와 같다. 같은 블록 안에서 다시 선언한다.

**완료 기준**
- `?q=low`에서는 패널에 blur가 없고 거의 불투명하다.
- `?q=high`에서는 blur 24px가 적용된다.
- QualityToggle의 FPS 표시로 `?q=high`에서 blur를 켰을 때와 끈 경우(devtools에서 `--panel-filter:none`)의 fps를 비교해 기록한다(섹션 7).

---

### Step 5 — 메신저 셸: 떠 있는 3단 (M, 선행 Step 3)
**기준**: 섹션 02 `?only=messenger`(CSS 287–306행)
**수정 파일**: `messenger/MessengerHome.tsx`, `messenger/Sidebar.tsx`, `messenger/ApprovalInbox.tsx`, `messenger/RoomPreviewPanel.tsx`

**레이아웃**
- 루트 컨테이너를 `relative h-full p-4 gap-4`로 하고 세 패널을 떠 있게 한다.
  - 사이드바: `tg-panel` w-[320px], 위아래 16px
  - 대화: 가운데 아래, 높이 364px(목업). 현재 `h-[46%] min-h-[320px]`를 `h-[364px]` 근처로 조정한다.
  - 미리보기: `tg-panel` w-[360px]
- 배치는 flex를 유지하고 `gap-4`와 `p-4`로 16px 간격을 만든다. absolute로 바꾸지 않는다.
- **`data-world-slot="band"` div는 반드시 남긴다.** WorldHost가 이 사각형으로 캔버스 높이를 정한다.

**Sidebar**
- 내 정보 행
- `tg-mono` 섹션 라벨
- 방 행: `.roomrow` 스타일. 선택 시 `color-mix(primary 14%)` + 테두리.
- 승인함 접이식 버튼: 목업 `.fold` — 앰버 tonal pill + 카운트 배지 `#2a1700` 글자

**RoomPreviewPanel**
- 썸네일: 목업 `.thumb`의 scene 그라디언트(`--scene-sky-mid` → `--scene-sand`)
- 정보 리스트: `.infol`
- 버튼: `btn('cta')` 들어가기, 나머지는 `soft`/`ghost`
- `APPROVAL_ORANGE`와 `#ffd9a0` glow는 Step 7에서 정리하므로 여기서는 손대지 않는다.

**`backdrop-blur*` 클래스 제거**
- 이 파일들에서 `backdrop-blur*` Tailwind 클래스를 지운다. `tg-panel`의 `--panel-filter`가 대신한다.

**완료 기준**
- 메신저가 목업 messenger처럼 화면 가장자리에서 16px 떠 있는 세 패널로 보인다.
- 패널 사이 틈과 band 영역에서 3D 캡슐을 클릭해 방을 선택할 수 있다.
- 사이드바 승인 접이식 버튼이 앰버 pill이다.

---

### Step 6 — 대화 영역 (M, 선행 Step 3, Step 5와 병렬 가능; 단 `MessageList`는 Step 6b에서)
**기준**: 섹션 05 `?only=chat`(CSS 135–159행, 265–266행)

**Step 6a** — 수정 파일: `messenger/ConversationView.tsx`, `messenger/Composer.tsx`, `messenger/AgentActivity.tsx`, `messenger/InteractionChip.tsx`, `messenger/InteractionChips.tsx`
- 대화 패널: `tg-panel`
- 헤더: `tg-title` + `tg-mono`
- Composer: `tg-input` 컨테이너(concave, r-input), 전송은 `btn('primary',{round:true})`, 자리표시는 `--muted`
- InteractionChip(s): `tg-chip`
  - `.tonal`, `--c`는 INTERACTION 색
  - A2A 흐름은 `.tg-a2a`
  - **`ink()` 호출은 그대로 둔다(테스트).**

**Step 6b (Gate G 뒤)** — 수정 파일: `messenger/MessageList.tsx`, `messenger/MandateBlock.tsx`
- 말풍선을 `tg-bubble`로 바꾼다.
  - 상대: `.other` — 아래-왼쪽 4px 모서리. 현재의 `rounded-tl-sm`은 **아래 모서리로 옮긴다**.
  - 나: `.me` — 아래-오른쪽 4px 모서리
  - Agent: `.agent` — 왼쪽 3px 띠
  - Room Agent: `.room`, 일시정지 `.paused`, 오류 `.err`, 전송 실패 `.fail`
- 바탕은 기존 `tint()` 그대로 둔다. Step 2 이후 목업과 같은 색이 나온다.
- 화자 라벨은 `.tg-btag`(mono 대문자, `color-mix(c 80%, fg)`)
- 시스템 공지는 `.tg-notice`
- `chat-surface`, `surface-card` 클래스는 지운다.
- **완료 기준**: Alice/Bob/Agent 말풍선이 목업 05와 모양·색이 같다. 스트리밍 커서가 민트색 블록으로 깜박인다.

---

### Step 7 — 승인 앰버 단일화 (S, 선행 Step 2, 다른 단계와 병렬 가능)
**수정 파일**: `packages/shared/src/colors.ts`, `packages/shared/src/interactions.ts`, `packages/shared/test/colors.test.ts`, `apps/web/src/room/eventLabel.ts`, `apps/web/src/world/agents/Actor.tsx`(818, 820행만)

**할 일**
- `PALETTE.approvalOrange`를 `'#ffb45a'`로 바꾼다.
- `INTERACTION_COLORS.a2h`를 `'#ffb45a'`로 바꾼다.
- `colors.test.ts:71`의 `'#FFC88C'`를 `'#FFB45A'`로 바꾼다.
- `eventLabel.ts:79`의 `'#ff9f43'`을 `PALETTE.approvalOrange`로 바꾼다.
- `Actor.tsx`의 `'#ff9a3c'` 두 곳을 `INTERACTION_COLORS.a2h`로 바꾼다.
- `RoomView.tsx`/`ApprovalPanel.tsx`의 `bg-[#ff9f43]`는 각각 Step 8과 Step 9에서 `tg-pill-amber`로 바꾼다. 여기서는 손대지 않는다.

**함께 처리할 영향**
- `isReservedColor` 기준이 바뀐다. `#ffc88c`는 더 이상 예약색이 아니고 `#ffb45a`가 예약색이 된다.
- server가 `isReservedColor`를 사용자 색 검증에 쓰는지 grep해서 확인한다. 시드 사용자 색은 둘 다 아니므로 영향이 없을 것으로 추정한다.
- `npm test -w packages/shared`와 `npm test -w apps/server`를 실행한다.
  - **server 테스트 파일(`seed.test.ts`, `memoryIsolation.test.ts`)은 다른 사람의 미커밋 변경이 있으니 수정하지 않는다.** 실패하면 보고만 한다.

**완료 기준**: 앱 전체에서 승인 표시(배지, 3D 캡슐 글로우, 3D 말풍선 ask)가 같은 `#ffb45a` 계열이다.

---

### Step 8 — Room 셸: 떠 있는 배치 (L, 선행 Step 3)
**기준**: 섹션 01 `?only=hero`(CSS 248–285행)
**수정 파일**: `room/RoomView.tsx`, `room/InteractionStrip.tsx`, `room/TimelineScrubber.tsx`

**`RoomView` 레이아웃**: `relative h-full min-w-[1100px]` 컨테이너 안에 absolute 배치를 쓰고, 목업 좌표를 그대로 따른다.

| 요소 | 위치·크기 | 스타일 |
|---|---|---|
| header | `left-4 right-4 top-4 h-16` | `tg-panel rounded-full`, flex gap-3, px-3 |
| 왼쪽 aside | `left-4 top-24 bottom-4 w-[320px]` | `tg-panel p-4 flex-col gap-3.5 overflow-y-auto` |
| 오른쪽 aside | `right-4 top-24 bottom-4 w-[400px]` | `tg-panel p-4` |
| 보드 strip | `left-[352px] right-[432px] bottom-[72px] h-[184px]` | `tg-panel` |
| 타임라인 | `left-[352px] right-[432px] bottom-4 h-11` | `tg-panel rounded-full` |
| RoomStage 슬롯 | `left-[352px] right-[432px] top-24 bottom-[268px]` | — |

- RoomStage를 슬롯 위치에 두는 이유: 그래야 3D 포커스 캡슐이 가운데 빈 영역에 나온다.

**헤더 구성**
- `← 메신저`: `btn('ghost')`
- 세로 구분선
- 제목 `tg-title` + `KIND·THEME` `tg-mono`
- `ambience-chip`: `tg-chip`(주의 상태면 `.warn`)
- `room-pending-count`: `tg-pill-amber`(맥동하는 점 포함)
- `presence`: `tg-aux`
- `replay-badge`: `tg-chip warn`
- 오른쪽 버튼: 가이드 `ghost`, Agent 보내기 `soft`, Leave `cta`, Rejoin `primary`, 방문 종료 `ghost`

**배너**
- digest, left, error 배너를 가운데 영역 위쪽(`top-24`, 슬롯 위)에 떠 있는 `tg-notice`로 바꾼다. digest와 left는 `.amber`.
- `bg-[#1b2640]`를 제거한다.

**입장 모션**: header `tg-enter-t`, 왼쪽 `-l`, 오른쪽 `-r`, 보드·타임라인 `-b`. delay는 0 / 120 / 240 / 360ms.

**InteractionStrip**
- 가운데 영역 위쪽에 `tg-flow tg-solid` pill들로 띄운다.
- 3D 위에 직접 뜨는 요소이므로 blur 없이 불투명으로 한다.

**TimelineScrubber**
- `tg-track`(fill = primary, thumb = cta + popover 테두리, 이벤트 점은 `--c`)
- 재생 버튼: `btn('primary',{round:true})`
- 과거 재생 중이면 `.past`(앰버 테두리)

**완료 기준**
- 같은 방을 열었을 때 목업 hero와 패널 위치·모양이 일치한다.
- 3D 포커스 캡슐이 가운데 빈 영역에 보인다.
- **슬롯 밖(패널 뒤)은 Step 16 전까지 page-bg로 보이는 것이 정상이다.**
- 패널 사이 틈으로 캔버스 클릭과 호버가 동작한다.

---

### Step 9 — Room 패널 내용 (M, 선행 Step 8, 일부는 Gate G 뒤)
**Step 9a** — 수정 파일: `room/ApprovalPanel.tsx`, `room/ActivityFeed.tsx`, `messenger/MemoryPanel.tsx`, `room/RejoinDigest.tsx`
- ApprovalPanel 카운트: `tg-pill-amber`(`#ff9f43` 제거)
- ActivityFeed: 섹션 05의 말풍선/공지 규칙을 따른다.
- MemoryPanel: `.memrow`(concave, r-card). 하드코딩 hex 4개는 토큰으로 바꾼다.
- RejoinDigest: `tg-panel` 시트 + `.dg` 리스트(목업 섹션 10)

**Step 9b (Gate G 뒤)** — 수정 파일: `room/AgentStatusList.tsx`
- 참여자 행: `.prow`(아바타 + 온라인 점 `.pdot`)
- Agent 카드: `tg-card .agcard` + `tg-frame octa/hexa` + 상태 `tg-mono`(작성 중이면 `--agent` 색)
- **기준**: 섹션 08 `?only=agents`

---

### Step 10 — 승인/방문 카드 (M, 선행 Step 3, Step 7 권장)
**기준**: 섹션 06 `?only=approval`(CSS 161–182행), 모션 m5
**수정 파일**: `messenger/ApprovalCards.tsx`, `messenger/VisitCards.tsx`, `messenger/MandateBlock.tsx`(Step 6b와 겹치면 둘 중 먼저 하는 쪽에서 처리)

**ApprovalCards 루트**
- `tg-card tg-appr` + 상태 클래스(`pending live` / `approved` / `rejected`), compact면 `.compact`
- 다음 inline style을 제거한다: `--glow`, `borderColor`, `backgroundColor: tint(...)`. tonal 바탕은 `::after`가 담당한다.

**ApprovalCards 내부**
- 헤더: `.hd`(`tg-mono` "A2H · 승인 대기" + 시각)
- 경로: `.route`(보낸 쪽 이름 `ink(color)`)
- 요약: `.sum`
- 제안 내용: `.prop`
- 버튼: `.acts` — 승인 `primary`, 수정 `soft`, 거절 `dghost`
- `` `${APPROVAL_ORANGE}88` `` 테두리 칩은 `tg-chip warn`으로 바꾼다.

**승인 완료 연출**
- 체크 SVG `.chk`를 추가한다(목업 1166행). approved로 바뀌면 draw 애니메이션 400ms가 돌고, `--c`가 앰버에서 아쿠아로 400ms 동안 바뀐다.
- 카드가 상태 변화 중에도 같은 키로 다시 렌더되는지 확인한다. 언마운트·재마운트되면 전환 애니메이션이 보이지 않는다. 이 경우 정적인 approved 모양만 나와도 완료로 본다.

**VisitCards**: requested 상태 강조색은 앰버 tonal로, 나머지는 `tg-card`로 한다.

**완료 기준**
- 대기 카드에 왼쪽 4px 앰버 띠, tonal 바탕, 2.4s 글로우가 있다.
- 승인 후에는 아쿠아 띠가 된다.
- 감소 모션 설정에서는 글로우가 멈춘다.

---

### Step 11 — 보드와 도구 창 (L → 두 개로 분할, 선행 Step 3)
**기준**: 섹션 07 `?only=board`(CSS 344–372행), 모션 m8

**Step 11a** — 수정 파일: `room/BoardPanel.tsx`, `room/boardTools/boardTools.css`, `room/boardTools/common.tsx`, `room/boardTools/ToolWindow.tsx`, `room/boardTools/BoardToolStrip.tsx`
- `boardTools.css`
  - `--bt-*` 변수 이름은 유지하고 값을 Tide 토큰으로 다시 매핑한다:
    - `--bt-bg` → `var(--popover)`, `--bt-fg` → `var(--fg)`, `--bt-muted` → `var(--muted)`, `--bt-line` → `var(--border)`
    - `--bt-card-bg` → `var(--card)`, `--bt-card-bd` → `var(--border)`, `--bt-inset` → `var(--concave)`
    - `--bt-track` → `color-mix(in srgb,var(--fg) 12%,transparent)`
    - `--bt-hint-*` / `--bt-pill*` / `--bt-out*` → popover, border, fg 계열
    - `--bt-win-*`(당첨 강조) → primary 계열
  - **나무/종이 질감 변수(`--bt-wood-*`, `--bt-paper*`)와 이를 쓰는 규칙은 평면 tonal로 바꾼다.** 도구 창 헤더에는 `.th::before`의 3px 종류 색 띠를 쓴다.
  - `!important` 4곳(93, 95, 181, 197행)은 왜 필요했는지 확인한 뒤 우선순위 문제를 선택자 구체성으로 풀어 제거한다. 제거할 수 없으면 주석으로 이유를 남긴다.
- 도구 창 루트: `tg-panel tg-toolwin` + `style={{'--k': kindColor}}`, 열릴 때 `tg-tool-in` 220ms
- 종류 칩: `tg-chip tonal`
- BoardPanel 카드: `tg-card .bcard`(호버 시 1.03 확대), 3열 그리드, 버전 표시는 `tg-mono`
- `surface-card` 클래스를 제거한다.

**Step 11b** — 수정 파일: `room/boardTools/LadderPanel.tsx`, `SettlementPanel.tsx`, `TripPanel.tsx`, `CustomPanel.tsx`
- 하드코딩 hex(Settlement 9개, Custom 3개)를 토큰이나 `--k`로 바꾼다.
- 행 스타일: `.srow`, `.ck`, `.prog`, 세로 타임라인 `.tl-v`
- `boardTools.test.tsx`가 검사하는 testid와 문구는 유지한다.

**완료 기준**: 사다리, 정산, 여행, 커스텀 도구 창 4종이 목업 07과 같은 유리 창 + 종류 색 띠 모양이다. boardTools 테스트가 통과한다.

---

### Step 12 — 시트·로그인·투어 (M, 선행 Step 3)
**기준**: 섹션 10 `?only=sheets`(CSS 374–395행), 모션 m7

**Step 12a** — 수정 파일: `room/Sheet.tsx`, `room/LeaveSheet.tsx`, `room/SendAgentSheet.tsx`, `room/MandateForm.tsx`
- Sheet
  - 바깥: `tg-scrim`. 스크림의 `backdrop-filter: blur(6px)`는 유지한다(전체 화면 한 장이라 비용이 크지 않다).
  - 안쪽: `tg-panel tg-sheet p-5`, max-w 480
  - 열릴 때: 스크림은 `tg-fade-in` 220ms, 패널은 `tg-pop`(scale .95→1)
  - **닫힘 애니메이션은 하지 않는다.** 언마운트 지연용 상태가 필요해 회귀 위험이 크다.
- MandateForm: 위임 범위 행 `.mrow .ic.y/.n/.x`, 선택지 `tg-opt`, 입력 `tg-field`, 토글 `tg-switch`

**Step 12b** — 수정 파일: `pages/Login.tsx`, `onboarding/Tour.tsx`
- Login: `tg-panel .login`(380px, p-7)
  - 뒤 배경: 3D가 없는 화면이므로 `--scene-*` 그라디언트(`.scene-bit` 규칙)를 body 대신 루트 div에 깐다.
  - 사용자 선택 버튼: `btn('person')` + `--c`
- Tour: 스포트라이트 `.spot`(아쿠아 링), 카드 `tg-panel .tour`, 단계 점 `.steps`

**투어 회귀 위험**: Step 5와 Step 8에서 레이아웃이 바뀌었으므로 투어의 대상 요소와 위치를 다시 확인한다. `onboarding/tourSteps.ts`의 대상 선택자는 수정하지 않는다.

---

### Step 13 — 3D 위 DOM 요소 (M, 선행 Step 3)
**기준**: 섹션 09 `?only=over3d`(CSS 223–247행), 모션 m9
**수정 파일**: `world/LabelLayer.tsx`, `stage/StageChrome.tsx`, `stage/FxOverlay.tsx`

**LabelLayer**
- inline style 가운데 **위치 관련 속성만 남긴다**: `position`, `left`, `top`, `display`, `willChange`. 나머지는 `className="world-label tg-nametag"` + `style={{'--c': it.color}}`로 옮긴다.
- 크기: 목업 36px은 조감 화면에서 너무 크다. `height: 30px`, `padding: 0 12px 0 10px`로 줄인다. 이 수치는 목업과 다르게 정한 것이니 시각 확인 후 조정한다.
- `attention`: `.attn`. false에서 true로 바뀌는 순간 `.pulse1`을 1회 붙였다가 animationend에 뗀다.
- 배지: `tg-chip`(앰버면 `.warn`, 아니면 `.tag` + `--c`)
- 인원 수: `tg-mono`
- 폰트 inline 지정을 제거한다(`var(--font)` 상속).
- **`LabelProjector`는 수정하지 않는다.** `transform`은 Projector가 쓰고, `.pulse1`은 box-shadow만 애니메이션하므로 충돌하지 않는다.

**StageChrome**
- 품질 토글: `tg-seg tg-solid`
- HoverTip: `tg-tip tg-solid`
- `backdrop-blur`, `bg-panel`을 제거한다.

**FxOverlay**
- 범례: `tg-legend tg-solid tg-mono`(사람은 원, Agent는 팔각, Room Agent는 육각 아이콘)
- 팝업 pill: `tg-solid rounded-full`
- `backdrop-blur`를 제거한다.
- `${agreeColor}aa`류 하드코딩은 유지한다. 연출 색이라 데이터 색에 따른다.

**완료 기준**: 밝은 모래나 하늘 위에서도 이름표, 범례, 툴팁 글자가 같은 대비로 읽힌다. 이 요소들에는 blur가 0이다.

---

### Step 14 — 3D 말풍선·이름표 캔버스 (M, 선행 Step 1(폰트), Step 7(앰버); 2D 단계와 병렬 가능)
→ 섹션 4에 상세

### Step 15 — 3D 낮 바다 장면 (L → 두 개로 분할, 선행 Step 0만; 2D 단계와 병렬 가능)
→ 섹션 3에 상세

### Step 16 — 캔버스 전체 화면화 + 슬롯 기준 투영 (L, 선행 Step 5, 8, 15)
→ 섹션 3-6에 상세

### Gate G — 보류 파일 해제 (사용자 결정 9-1)
- 보류 파일 소유자의 변경이 커밋되고, 그것이 이 브랜치에 merge 또는 rebase된 뒤에 Step 6b, 9b, 그리고 RoomStage 2D 폴백 정리(아래 Step 17)를 진행한다.
- `Avatar.tsx`(초상): 섹션 08의 `.av` 흰 테두리 2px와 `.pdot`만 적용한다. **포트레이트 로직은 건드리지 않는다.**

### Step 17 — 정리 (M, 마지막)
**수정 파일**: `themes.css`, `index.css`, `styles/tide.css`, `CREDITS.md`, `pages/Metrics.tsx`, (Gate G 뒤) `room/RoomStage.tsx`

**할 일**
- 다음 명령으로 하드코딩 hex 잔여를 점검한다:
  ```
  grep -rnE "#[0-9a-fA-F]{6}" apps/web/src --include=*.tsx | grep -v world/
  ```
- 쓰이지 않는 호환 별칭을 삭제한다. `grep "var(--X)"`로 0건인 것만 지운다.
- 옛 키프레임을 삭제한다.
- 임시 클래스 `.surface-card`, `.chat-surface`를 삭제한다.
- RoomStage의 2D 폴백 glow(`#ffd9a0`)와 `--stage-*`를 scene 토큰 기준으로 바꾼다.
- `sunset_1k.hdr`와 CREDITS의 해당 행을 삭제한다(Step 15를 채택한 경우).
- Metrics 페이지에 `tg-panel`을 적용한다.

---

### 단계 의존 관계와 병렬 가능 구간
```
0 ─┬─ 1 ────────────────────────┐
   ├─ 2 ── 3 ─┬─ 4              │
   │          ├─ 5 ──┐          │
   │          ├─ 6a  ├─ 8 ─ 9a  │
   │          ├─ 10  │          ├─ 14
   │          ├─ 11a ─ 11b      │
   │          ├─ 12a, 12b       │
   │          └─ 13             │
   ├─ 7 (2 이후 아무 때나) ─────┘
   └─ 15a ─ 15b ──────────── 16 (5, 8 이후)
Gate G → 6b, 9b, 17
```
- 동시에 띄우는 implementer는 **2명까지**를 권장한다. 같은 worktree에서 typecheck를 돌리면 서로의 작업 중 변경이 섞여 보이기 때문이다. 3D 1명 + 2D 1명 조합이 가장 안전하다.

---

## 3. 3D 장면 전환 (Step 15a/15b)

### 3-1. 하늘을 만드는 방식 비교

| 안 | 비용 | 위험 | 판단 |
|---|---|---|---|
| **A. 절차적 하늘 셰이더**(`--scene-*` 색으로 그리는 그라디언트 + 태양 원반/후광 + 선택적 fbm 구름) | 셰이더 1개. 에셋 없음. HDR 로딩이 없어져 첫 화면이 더 빨리 뜬다 | 사진처럼 사실적인 구름은 없다. 유리와 바다 반사가 단순해진다 | **추천** |
| B. Poly Haven CC0 낮 하늘 HDRI(예: `kloofendal_48d_partly_cloudy_puresky`, `qwantani_noon_puresky`의 1k .hdr) | 다운로드 약 1.5–2MB(추정). `sky.ts`의 태양 방위를 다시 측정해야 한다 | 색이 토큰과 정확히 맞지 않는다. 다운로드 승인이 필요하다 | 대안 |
| C. drei `<Sky>`(Preetham) | 코드가 적다 | AgX를 거치면 하얗게 날아가거나 탁해진다. 토큰 색을 맞추기 어렵다 | 비추천 |

**A를 추천하는 이유**
- 목업 `--scene-*`가 곧 색 기준이므로 토큰 값을 그대로 uniform으로 넣을 수 있다.
- 지금 하늘 돔, 환경 캡처, 바다 반사가 모두 `skyColor(vec3 d)` **함수 하나만** 호출하는 구조다(확인함). 이 함수 본문만 바꾸면 세 곳이 동시에 낮 하늘이 된다.

**A가 포기하는 것**: 실사 구름과 HDRI 특유의 미세한 조명 변화. 결과가 부족하면 B로 바꾸면 되고, 그때만 다운로드 승인을 받으면 된다.

### 3-2. Step 15a — 하늘·바다·안개·태양 (L)
**수정 파일**: `world/scenePalette.ts`(신규), `world/sky.ts`, `world/Beach.tsx`

**`scenePalette.ts`**
- `themes.css`의 `--scene-*` hex를 그대로 옮긴 상수를 둔다: `SKY_TOP #3f8fd8`, `SKY_MID #7cc0ee`, `SKY_LOW #d6eefa`, `HAZE #e4f3fb`, `SEA_FAR #0b5c8a`, `SEA_MID #12a3b8`, `SEA_SHORE #7fe0d2`, `FOAM #ffffff`, `SAND #f7efe0`, `SAND_SHADE #e6d9c2`, `SHADOW #1e4664`.
- 주석에 "`themes.css`와 동기화"라고 적는다.
- 셰이더 uniform에 넣을 때는 `new THREE.Color(hex)`를 쓴다(ColorManagement가 sRGB→linear 변환을 해 준다).

**`sky.ts`**
- `HDR_SUN_AZIMUTH`, `ENV_ROTATION_Y`를 삭제한다. 다른 파일에서 쓰는지 grep으로 먼저 확인한다.
- `TARGET_AZIMUTH = -Math.PI/2 - 0.55`로 바꾼다. 목업처럼 태양이 왼쪽 위에 오게 하려는 것이며 값은 시각 조정 대상이다.
- `SUN_ELEVATION = 40°`, `SUN_VIS_EL = 28°`로 바꾼다.
- `FOG_COLOR = '#e4f3fb'`로 바꾼다.

**`Beach.tsx`**
1. `SKY_GLSL`을 교체한다. `skyMap`, `skyRot`, `skyMax` uniform을 없애고 `skyTop`, `skyMid`, `skyLow`, `skyHaze`(vec3), `skyGain`(float)을 둔다.
   ```glsl
   vec3 skyColor(vec3 d){ d=normalize(d); float e=d.y;
     vec3 c=mix(skyHaze, skyLow, smoothstep(0.0,0.06,e));
     c=mix(c, skyMid, smoothstep(0.04,0.32,e));
     c=mix(c, skyTop, smoothstep(0.30,0.95,e));
     return c*skyGain; }
   ```
2. 하늘 돔(`SkyBackdrop`)의 태양 항을 흰색 계열로 바꾼다:
   `col += vec3(1.0,0.98,0.94)*(pow(cs,800.)*4. + pow(cs,40.)*0.35 + pow(cs,6.)*0.12)`
   - 선택 사항: 고도 0.05–0.4 띠에 2D fbm 구름(흰색, 알파 0.5)을 얹는다. 이것은 별도 커밋으로 한다.
3. `useEnvironment({files: HDR})`를 제거한다.
   - `SkyAndEnv`: HDR 없이 `<SkyBackdrop/>` + `<Environment resolution={256} frames={1}><SkyForEnv/></Environment>`로 한다.
   - `SeaAndSand`: hdr prop을 없애고, `useTexture`가 suspend한 뒤에 `patchSky({ready:true})`를 호출하는 흐름을 유지한다.
4. 바다 셰이더
   - 깊은 물 색: `deep = mix(SEA_FAR, SEA_MID, shore)`
   - 얕은 물 띠: `col = mix(col, SEA_SHORE, smoothstep(SHORE_Z-14., SHORE_Z+1., vWP.z)*0.6)`
   - 태양 반짝임 색을 `vec3(1.0,0.97,0.92)`로 한다.
5. 포말 그라디언트 색을 `rgba(255,255,255,…)`로 바꾼다.
6. 모래
   - `color '#f6e6d2'` → `'#f7efe0'`
   - 젖은 모래 처리: `mix(1.0,0.5,wetK)` → `mix(1.0,0.74,wetK)`, 색 틴트 `vec3(0.95,0.88,0.85)` → `vec3(0.9,0.96,0.97)`(젖은 모래가 청록빛을 띠게)
7. `Sun` 조명
   - 주광: `color #fff3df`, intensity 4.0
   - 보조광: `#dcefff` 0.6
   - hemisphere: `['#cfe8ff','#f1e4cc',0.9]`
   - `shadow-intensity` 0.5
   - 모든 수치는 시작값이며 시각 조정 대상이다.
8. 안개: `<fog args={[FOG_COLOR, 160, 900]}>`
9. `const HDR` 상수를 삭제한다.

**완료 기준**
- `?q=high`, `?q=mid`, `?q=low` 각각에서 하늘이 파랑이고 수평선 쪽이 밝은 헤이즈이며, 바다가 파랑→에메랄드, 모래가 밝은 크림색이다.
- 화면 캡처를 `design/mockups/assets/tide-glass-hero.png`와 나란히 놓고 하늘 위쪽, 바다, 모래 색감이 같은 계열인지 비교한다.
- 첫 프레임 페이드인(`skyReady`)이 여전히 동작한다.

### 3-3. Step 15b — 톤매핑·후처리·그림자·실내 (M)
**수정 파일**: `world/Postfx.tsx`, `world/WorldCanvas.tsx`, `world/capsule/CapsuleShell.tsx`, `world/capsule/InteriorLights.tsx`(확인 위주)

**톤매핑**
- AgX는 밝은 파랑을 회색 쪽으로 누른다. **Neutral 톤매핑을 시도한다.**
  - `ToneMappingMode.NEUTRAL`과 `THREE.NeutralToneMapping`이 설치된 postprocessing/three 버전에 있는지 확인한다(추정상 있음):
    ```
    grep -n NEUTRAL node_modules/postprocessing/build/index.d.ts
    ```
  - 있으면 `Postfx`의 `<ToneMapping mode>`와 `WorldCanvas.tsx:75`의 low 단계 렌더러 톤매핑을 **같은 상수로** 맞춘다. 새 상수 `TONE_MAPPING`을 `scenePalette.ts`에 둔다.
  - 없으면 AgX를 유지하고 `skyGain`(1.4–2.0)과 `HueSaturation`(0.12 → 0.2)으로 보정한다.

**후처리 수치**
- Bloom: `luminanceThreshold` 2.0 → 2.4, intensity 0.45 → 0.3. 낮 장면에서 모래와 구름이 번지지 않게 한다.
- Vignette darkness: 0.55 → 0.3
- BrightnessContrast: contrast 0.16 → 0.08, brightness -0.02 → 0

**그림자·실내**
- `CapsuleShell.tsx:124` 접지 그림자: `color '#1a0d06'` → `'#1e4664'`, opacity 0.62 → 0.4. 목업 `--scene-shadow`가 푸른 그림자다.
- `InteriorLights.tsx`: 따뜻한 실내 `#ffb066`은 **유지한다**. 목업의 실내 미니어처도 따뜻한 전구색이다. 다만 낮 장면에서 실내가 상대적으로 어두워 보이면 `c.level * 30`의 계수를 1.2–1.4배로 올린다.

**완료 기준**
- 승인 대기 상태의 캡슐 앰버 글로우가 낮 장면에서도 구분된다. `fxLevel` 블룸 감쇠가 그대로 동작해야 한다.
- 캡슐 그림자가 푸른 톤이다.

### 3-4. 실내 조명 요약
- 색(따뜻한 전구색)은 유지하고, 밝기만 필요하면 올린다.
- `BoardToolProps`의 나무 소품은 장면 안의 물체이므로 그대로 둔다.

### 3-5. 새 에셋
- **A안(추천)은 다운로드가 필요 없다.**
- B안을 택할 때만 Poly Haven 1k .hdr 다운로드에 대해 사용자 승인이 필요하다(9-3).

### 3-6. Step 16 — 캔버스 전체 화면화 (L, 위험 중간–높음)
**수정 파일**: `stage/WorldHost.tsx`, `world/WorldCanvas.tsx`, `world/CameraRig.tsx`

**왜 필요한가**: 지금은 Room 캔버스가 슬롯 크기로만 그려진다. 그래서 목업 hero처럼 패널 뒤에도 장면이 보이게 하려면 캔버스를 키워야 한다.

**방법**
1. `WorldHost`: Room이든 메신저(band)든 항상 `inset: 0`(화면 전체)으로 렌더한다.
2. 슬롯 사각형(`slotRect`)을 `WorldCanvas`에 prop `viewRect`로 넘긴다.
3. `CameraRig`: 포즈 계산(`focusPose`/`overviewPose`)에 `aspect = viewRect.w / viewRect.h`를 쓰고, 매 리사이즈 시 다음을 실행한다:
   ```
   camera.aspect = viewRect.w/viewRect.h;
   camera.setViewOffset(viewRect.w, viewRect.h, -viewRect.left, -viewRect.top, W, H);
   camera.updateProjectionMatrix();
   ```
   - 원리: 시야 절두체는 슬롯 기준으로 정의되고, 캔버스 전체는 그 바깥까지 선형으로 확장된다. three.js의 multi-view 수식이 범위 밖 offset도 허용한다.
4. R3F가 리사이즈 때 aspect를 자동으로 덮어쓰지 않게 해야 한다. `<Canvas camera={{ manual: true }}>`를 쓰거나 `useThree().camera.manual = true`로 설정하고, 동작하는지 확인한다.
5. 메신저의 band는 `viewRect = band 사각형`이다. 기존 동작(폭 전체, band 아래끝까지)은 대체된다.

**확인할 것**
- `LabelProjector`의 투영 좌표가 맞는지
- 캡슐 클릭(레이캐스트)
- `focusUv`(TiltShift 초점 띠)
- 인트로 카메라
- 품질 단계 변경으로 캔버스가 다시 마운트될 때

**비용**: dpr 기준 렌더 면적이 Room 화면에서 약 2.5배 늘어난다(추정). high 단계 fps를 다시 측정해야 한다. PerformanceMonitor가 자동으로 단계를 낮출 수 있다.

**완료 기준**
- Room과 메신저 모두 패널 뒤로 장면이 보인다.
- 포커스 캡슐은 여전히 가운데 빈 영역의 중앙에 있다.
- 클릭과 호버가 정확하다.

**실패 시 대체안**: 이 단계를 되돌리고, Room 패널은 page-bg 위의 유리 패널로 둔다. 목업과의 차이는 패널 뒤 배경뿐이다.

---

## 4. 3D 말풍선·이름표 통일 (Step 14)

**수정 파일**: `world/agents/labels.tsx`, `world/agents/Actor.tsx`(spec 생성부만), `world/agents/LabelStacker.tsx`(앵커 기준 확인; 수정은 필요할 때만)

### 4-1. 공통 준비
- **색 섞기 도우미**: `mixSrgb(a, b, t)`를 `@ensemble/shared`의 `hexToRgb`/`rgbToHex`로 만든다. sRGB 공간에서 섞어야 CSS `color-mix(in srgb)`와 같은 결과가 나온다. `THREE.Color.lerp`는 linear 공간이라 쓰지 않는다.
- **폰트**: `FONT = '"DM Sans","Pretendard Variable",Pretendard,"Malgun Gothic",sans-serif'`, `MONO = '"JetBrains Mono","Pretendard Variable",monospace'`
- **폰트 로드 대기**: 모듈 수준에서 `fontsReady` 프라미스를 둔다.
  - `document.fonts.load('600 30px "Pretendard Variable"')`와 `document.fonts.load('600 22px "JetBrains Mono"')`를 기다린다.
  - 완료되면 `Bubble`은 `last.key`를 초기화해 다시 그리고, `NameTag`은 `useMemo` 의존성에 `fontsVersion`을 추가해 다시 만든다.
  - 이 처리가 없으면 첫 텍스처가 대체 폰트로 구워진다.
- **해상도**: 모든 캔버스 크기를 **2배**로 키운다(예: `CW=768`, `CH=336`). sprite의 월드 크기 계산(`width`, `k`)은 같은 결과가 나오게 보정해서 화면상 크기를 유지한다.

### 4-2. 말풍선 `drawBubble` (기준: 섹션 09 아래쪽 "3D 말풍선 7종")
- `base = '#0e2838'`
- 종류별 강조색 `c`:
  - `ask` → `#ffb45a`
  - `paused` → `#8dbed2`
  - `error` → `#ff5964`
  - 나머지 → `spec.color`
- 바탕: `mixSrgb(c, base, 0.20)`, **불투명**
- 테두리: 1px 상당(2배 캔버스에서 2px), 색은 `mixSrgb(c, base, 0.38)`
- 왼쪽 띠: 3px 상당(6px)을 `c`로 그린다(agent 계열 전부). `error`이면서 전송 실패인 경우는 점선 테두리 `setLineDash`.
- 모양: `g.roundRect(x, y, w, h, [R, R, R, Rtail])`, R = 16px 상당, Rtail = 4px 상당. 배열 순서는 좌상, 우상, 우하, 좌하다. **삼각 꼬리를 삭제한다.**
- 그림자: `shadowColor 'rgba(40,20,0,.28)'`, `shadowBlur` 24px 상당, `offsetY` 8px 상당(목업 `.in3d`). 캔버스 여백을 그만큼 확보한다.
- 태그 줄: `BubbleSpec`에 선택 필드 `tag?: string`을 추가한다.
  - mono 600, 11px 상당, 대문자, 자간 0.08em, 색 `mixSrgb(c, '#d9f3f7', 0.8)`
  - 예: `"✦ ALICE의 AGENT · WRITING"`
  - `Actor.tsx`에서 spec을 만드는 곳(818행 근처)에서 이름을 넣는다.
  - 태그가 없으면 종류 라벨만 쓴다(`WRITING`/`RECALLING`/`PAUSED`/`ERROR`/`승인 필요`).
- 본문: `#d9f3f7`, 500, 15px 상당, **왼쪽 정렬**
- `thinking` 점: 6px 상당, 색 `c`(`recalling`의 보라 `#7e5fd8`는 제거), 1.2s 주기 bounce
- `writing` 커서: 7×15px 블록, 색 `c`, 1s 깜박임
- **앵커 위치**: 꼬리가 사라졌으므로 말풍선의 아래-왼쪽 날카로운 모서리가 캐릭터 머리 위에 오게 한다.
  - 사각형을 캔버스 왼쪽 여백 `padL`에서 시작하게 그린다.
  - `<sprite center={[padL/CW, padB/CH]}>`로 둔다.
  - `LabelStacker`가 말풍선이 가운데 정렬이라고 가정하고 겹침을 계산한다면, 그쪽의 x 오프셋을 맞춘다.
- `toneMapped={false}`와 `SRGBColorSpace`는 유지한다. 블룸 threshold(2.4)보다 밝은 값이 없으므로 번지지 않는다.

### 4-3. 이름표 `NameTag` (기준: 섹션 09 이름표, 범례)
- 공통 모양: 알약(radius = H/2)
  - 바탕: `mixSrgb(color, base, 0.16)`
  - 테두리: `mixSrgb(color, base, 0.40)` 2px 상당
  - 글자: `#d9f3f7` 600
- 앞 아이콘 모양은 목업 범례 규칙을 따른다:
  - `human`: 원 점(지름 10px 상당)
  - `agent`: 팔각형(`polygon(30% 0,70% 0,100% 30%…)`을 path로)
  - `room`: 육각형
- 위의 아이콘 규칙은 **추정 해석**이다. 목업은 Agent 이름표 자체를 그리지 않았고 범례와 프레임 모양만 있다. 결과는 사용자 시각 확인을 받는다.
- 기존 각진 chamfer 몸통과 왼쪽 색 블록은 삭제한다.
- `me`: 크림 바탕 대신 테두리를 `color` 100%, 3px 상당으로 한다.
- 배지: 기본은 `tg-chip`(fg 8% 바탕, mono 대문자). 앰버 배지는 `amber-tonal` 바탕 + `#ffb45a` 글자.
- `subtleBadge`: `#8dbed2` 글자.

### 4-4. DOM 이름표
- Step 13에서 처리한다. 3D 캔버스 이름표와 DOM 칩이 **같은 색 공식**(16% tonal, 40% 테두리)을 쓰게 맞춘다.

### 4-5. 완료 기준
- 한 화면에서 2D 채팅 말풍선(Step 6b)과 3D 말풍선의 모양(16px 둥근 모서리 + 아래-왼쪽 4px), 색, 태그 규칙이 같다.
- `thinking`/`writing`/`ask`/`paused`/`error` 상태를 각각 재현해 목업 7종과 비교한다(mock 모드에서 Agent 실행 중 / 승인 요청 / 일시정지).
- 폰트가 로드된 뒤 다시 그려진다.

---

## 5. 모션

### 5-1. 옮기는 범위
- 토큰(`--dur-fast` 150ms, `--dur-base` 220ms, `--dur-slow` 400ms, `--dur-pop` 180ms, `--ease-standard`, `--ease-out`, `--motion`): Step 2
- 키프레임과 기존 클래스 본문 교체: Step 3

### 5-2. 목업 모션 → 앱 적용 위치

| 목업 | 앱 적용 위치 | 단계 |
|---|---|---|
| m1 패널 등장 | `.anim-card` 본문 교체, 화면 패널 `tg-enter` | 3, 5, 8 |
| m2 카드 stagger(40ms) | BoardPanel 카드에 `style={{animationDelay: i*40ms}}` | 11a |
| m3 말풍선 pop + 스트리밍 커서 | `.anim-in`, `.stream-cursor` 본문 교체 | 3 |
| m4 작업 중 점 | `.work-dots` 본문 교체. thinking→said 교차 페이드는 **하지 않는다**(구조 변경이 필요해 비용 대비 효과가 작음) | 3 |
| m5 승인 / 거절 | `tg-appr` 상태 전환, 체크 draw | 10 |
| m6 버튼 hover / active | `tg-btn` | 3 |
| m7 시트 | 열림만 적용, 닫힘은 제외 | 12a |
| m8 도구 창 | `tg-tool-in` | 11a |
| m9 이름표 주의·배지 pop | `.pulse1`, `tg-pop-badge` | 13, 5 |
| m10 타임라인 tick | 선택 사항(새 이벤트 점에 1회) | 8 |
| m11 화면 전환 | Room 진입 시 `tg-enter-t/l/r/b` | 8 |

### 5-3. 기존 모션과의 관계
- `fx-*`(FxOverlay 합의·리플 연출)와 Lottie(`public/assets/lottie/*.json`)는 **그대로 둔다**. 연출 계층이고 목업에 대응하는 대상이 없다.
- 단, FxOverlay 팝업 pill의 스타일만 Step 13에서 바꾼다.

### 5-4. 감소 모션
- `--motion:0`이면 이동과 확대가 0이 된다(transform이 곱셈 구조라 자동).
- 무한 루프(`pulse`, `glow`, `blink`, `bounce`, `dash`)는 `animation: none`으로 멈춘다.
- 기존 `fx-*`의 감소 모션 처리는 유지한다.
- 3D 쪽은 이미 있는 `reducedMotion` prop 경로를 유지한다. 말풍선의 점·커서 애니메이션도 `reducedMotion`이면 정지 프레임으로 그린다. 이것은 Step 14에서 `Bubble`에 prop을 추가해 처리한다.

---

## 6. 폰트

| 안 | 장점 | 단점 |
|---|---|---|
| CDN(목업과 같은 Google Fonts + jsDelivr) | 설정이 가장 간단하다 | 사내망·오프라인 데모에서 실패하면 Malgun으로 떨어진다. 외부 요청이 생긴다 |
| **self-host(npm: `pretendard`, `@fontsource-variable/dm-sans`, `@fontsource/jetbrains-mono`)** | 오프라인에서 동작한다. Vite가 번들하고 dynamic-subset이라 쓰는 글자 묶음만 로드한다 | 처음 `npm install`에 네트워크가 필요하다. 의존성 3개가 늘어난다 |

- **추천은 self-host다.** 데모 환경이 사내망일 수 있고, 3D 캔버스 텍스트도 같은 폰트를 써야 하므로 폰트 로드 시점을 우리가 통제해야 한다(`document.fonts`).
- **3D 텍스트 일치**
  - 캔버스 2D 말풍선과 이름표는 Step 14에서 같은 폰트 스택과 `fontsReady` 후 재그리기로 일치시킨다.
  - troika 3D 간판(`world/text.tsx`, `NotoSansKR-Bold-subset.ttf`)은 **이번 범위에서 유지한다**. Pretendard로 바꾸려면 새 서브셋 ttf를 만들어야 한다(별도 과제).

---

## 7. 성능 위험 — WebGL 위 backdrop-filter

### 7-1. 비용 구조
- WebGL 캔버스는 매 프레임 갱신된다. 그래서 그 위에 있는 `backdrop-filter` 요소마다 매 프레임 다음이 일어난다:
  1. 뒤 영역을 읽어 온다.
  2. 2패스 가우시안 blur를 한다.
  3. 결과를 합성한다.
- 비용은 대략 **blur가 걸린 면적 × blur 반경 × DPR²**에 비례한다(추정).
- Room 화면 목업에는 blur 패널이 5개 있다(헤더, 좌, 우, 보드, 타임라인). 화면 면적의 약 45%이고 DPR 2, 24px 기준이면 내장 GPU에서 프레임당 수 ms가 추가될 수 있다(추정; 측정 필요).

### 7-2. 완화책 (계획에 이미 반영됨)
1. **blur는 큰 패널(`tg-panel`)과 시트 스크림에만 쓴다.** 3D 위 작은 요소(이름표, 범례, 툴팁, 흐름 띠, 말풍선)는 불투명 `tg-solid`로, blur가 0이다. 이것이 목업 규칙이기도 하다(Step 13).
2. **품질 단계와 연동한다**(Step 4): high 24px, mid 12px, low/off 없음 + 불투명도 .95. 월드가 꺼져 있으면 blur를 쓰지 않는다. `prefers-reduced-transparency`에서도 끈다.
3. 패널 바탕이 이미 .86 불투명 그라디언트라서 blur 반경을 줄여도 시각 차이가 작다. mid 단계의 12px로도 충분하다.
4. TSX에 남아 있는 `backdrop-blur*` 17곳을 모두 제거한다(Step 5, 8, 13에서). 중복 blur를 막기 위해서다.
5. PerformanceMonitor와의 상호작용: blur 때문에 fps가 떨어지면 자동으로 단계가 내려가고, 그러면 blur도 줄어든다. 자기 조절이 되므로 허용한다. 단, 단계가 위아래로 계속 바뀌는지(진동) Step 4 측정 때 확인한다.

### 7-3. 측정 기준
- `?q=high`에서 Room 화면 fps를 blur를 켰을 때와 끈 경우로 비교한다. 하락이 10%를 넘으면 high 단계의 blur도 16px로 낮춘다.
- Step 16(캔버스 전체 화면) 뒤에 다시 측정한다.

---

## 8. 검증 방법

### 8-1. 자동 검증
- 매 단계: `npm run typecheck -w apps/web`, `npm test -w apps/web`
- Step 7: 위 명령 + `npm test -w packages/shared`, `npm test -w apps/server`
- Phase가 끝날 때: `npm run build -w apps/web`
- 시각 회귀를 자동으로 검사하는 테스트는 없다. e2e도 없다.

### 8-2. 시각 확인 절차
- dev 서버를 mock 모드로 띄운다(Step 0의 포트).
- 로그인 화면에서 시드 사용자 Alice로 로그인한다.

| 화면·상태 | 만드는 방법 | 비교할 목업 |
|---|---|---|
| 메신저 기본 | 로그인 직후, 방 하나 선택 | `?only=messenger`, `tide-glass-messenger.png` |
| 대화(사람/Agent/스트리밍) | 방에서 메시지를 보내 mock Agent가 응답하게 함 | `?only=chat` |
| 승인 대기/승인/거절 | Agent가 소유자 결정 사안을 요청하게 함(최근 커밋 `ccfa77b` 흐름) → 승인 / 거절 클릭 | `?only=approval`, 모션 m5 |
| Room 화면 | 방에서 [들어가기] | `?only=hero`, `tide-glass-hero.png` |
| 보드·도구 4종 | Room 보드에서 사다리/정산/여행/커스텀 열기 | `?only=board` |
| 3D 위 요소 | 메신저 조감(이름표), 캡슐 호버(툴팁), 범례 | `?only=over3d` |
| 3D 말풍선 7종 | Agent 실행 중 / 승인 대기 / 일시정지 / 오류 | `?only=over3d` 아래쪽 |
| 시트·투어·로그인 | Leave, Agent 보내기, 가이드 버튼, 로그아웃 | `?only=sheets` |
| 품질 단계 | `?q=high`, `?q=mid`, `?q=low`, QualityToggle에서 off | 단계마다 blur와 장면 확인 |
| 감소 모션 | OS 설정 또는 DevTools Rendering에서 `prefers-reduced-motion` 에뮬레이션 | `?only=motion` 설명 |

### 8-3. 회귀 위험이 큰 곳
1. **pointer-events**: 떠 있는 배치로 바뀐 뒤 패널 사이 틈으로 캡슐을 클릭·호버할 수 있는지.
2. **슬롯 측정**: `data-world-slot="band"`, `data-room-stage-slot`이 남아 있고 크기가 맞는지. 3D 카메라 구도가 여기에 의존한다.
3. **투어**: 레이아웃이 바뀌어 스포트라이트 위치가 어긋날 수 있다.
4. **`ink()` 문자열 테스트**: `ink()` 출력 형식을 바꾸면 깨진다.
5. **이름표 겹침**: 이름표가 커지면 `offsetWidth`가 커져 위로 쌓이는 양이 늘어난다.
6. **portal 요소**: `Sheet`, `RejoinDigest`가 `<html>` 속성 기반 토큰을 받는지.
7. **backdrop root**: 패널 조상에 opacity/transform 애니메이션이 있으면 blur가 사라진다.
8. **3D**: `skyReady` 첫 프레임 페이드, 승인 시 블룸 감쇠, low 단계(postfx 없음)의 톤매핑 일치.
9. **Step 16**: 레이캐스트, 라벨 투영, 품질 변경으로 Canvas가 다시 마운트될 때.

---

## 9. 사용자가 결정해야 할 것

### 9-1. 미커밋 변경 처리와 브랜치 전략 (필수, Step 0 전에)
- 현재 상황:
  - 다른 사람이나 다른 세션이 수정 중인 파일이 11개다. 그중 리디자인 대상과 겹치는 것이 4개다: `Avatar.tsx`, `MessageList.tsx`, `AgentStatusList.tsx`, `RoomStage.tsx`.
  - `vite.s50.config.ts`가 있는 것으로 보아 **같은 작업 트리를 다른 세션이 지금 쓰고 있을 가능성이 높다.**
- 선택지:
  - **A (추천)**: `git worktree`로 `feat/tide-glass` 브랜치를 HEAD에서 분리하고, `design/`은 복사해서 이 브랜치에 커밋한다. 겹치는 4개 파일의 단계(6b, 9b, Avatar, RoomStage 정리)는 해당 작업이 커밋된 뒤(Gate G)로 미룬다.
  - B: 먼저 그 작업의 소유자가 변경을 커밋하게 한 뒤, 같은 트리에서 브랜치를 만든다. 충돌은 없지만, 소유자를 기다려야 하고 동시 작업 위험이 남는다.
  - C: 지금 트리에서 그대로 작업한다. **비추천**: 남의 미커밋 변경과 섞인다.

### 9-2. 폰트 호스팅 (Step 1)
- A (추천): npm self-host. 의존성 3개 추가와 `npm install`(네트워크)을 승인해야 한다.
- B: 목업과 같은 CDN 링크를 `index.html`에 넣는다. 오프라인·사내망 데모에서는 폰트가 나오지 않는다.

### 9-3. 낮 하늘 소스 (Step 15)
- A (추천): 절차적 하늘 셰이더. 다운로드가 없다.
- B: Poly Haven CC0 낮 HDRI를 다운로드한다(1k .hdr, 약 1.5–2MB 추정). 외부 에셋 다운로드 승인이 필요하고, CREDITS를 갱신해야 한다.
- 먼저 A로 구현해 보고, 사실감이 부족하다고 판단될 때만 B를 승인받는 순서를 권한다.

### 9-4. 범위 확인
- Step 16(캔버스 전체 화면화)은 목업과 맞추려면 필요하지만, 3D 카메라 구조를 건드리는 가장 위험한 단계다.
- 선택지:
  - **A (추천)**: 이번 범위에 포함하되 맨 마지막에 별도 커밋으로 한다. 실패하면 되돌린다.
  - B: 다음 과제로 미룬다. 그러면 Room 화면에서는 패널 뒤가 장면이 아니라 어두운 바탕으로 보인다.

---

## 트레이드오프 요약

**토큰과 프리미티브**
- 선택: 새 토큰 + 호환 별칭, CSS 클래스(`tg-`) + 작은 TS 도우미
- 얻는 것: 매 단계 앱이 돌아가고, 파일 5개 이하 단위로 나눌 수 있다.
- 포기하는 것: 정리 기간 동안 변수 이름이 두 벌 있고, variant를 컴파일 시점에 강제할 수 없다.

**3D 하늘**
- 선택: 절차적 하늘
- 얻는 것: 토큰 색과 정확히 일치하고, 에셋과 라이선스 문제가 없으며 로딩이 빠르다.
- 포기하는 것: 실사 구름과 HDRI 조명의 풍부함.

**목업과 다르게 정한 것 (모두 시각 확인 후 조정 가능)**
- 3D 위 DOM 이름표 높이: 36px → 30px. 조감 화면에서 겹침을 줄이기 위해서다.
- 시트 닫힘 애니메이션과 thinking→said 교차 페이드는 하지 않는다. 구조를 바꿔야 해서 회귀 위험이 크다.

**앰버 단일화**
- `packages/shared`를 바꾸므로 예약색 검증 기준이 `#ffc88c`에서 `#ffb45a`로 이동한다. 시드 데이터에는 영향이 없을 것으로 추정한다(서버 테스트로 확인).

---

## 관련 경로
- 목업: `C:\Users\siheon.ryu\Desktop\workspace\R2P\EnsembleRoom\design\mockups\02-tide-glass.html`(토큰 16–52행, 컴포넌트 CSS 65–457행)
- 토큰: `C:\Users\siheon.ryu\Desktop\workspace\R2P\EnsembleRoom\apps\web\src\themes.css`, `C:\Users\siheon.ryu\Desktop\workspace\R2P\EnsembleRoom\apps\web\src\index.css`, `C:\Users\siheon.ryu\Desktop\workspace\R2P\EnsembleRoom\apps\web\src\theme.ts`
- 3D: `C:\Users\siheon.ryu\Desktop\workspace\R2P\EnsembleRoom\apps\web\src\world\Beach.tsx`, `C:\Users\siheon.ryu\Desktop\workspace\R2P\EnsembleRoom\apps\web\src\world\sky.ts`, `C:\Users\siheon.ryu\Desktop\workspace\R2P\EnsembleRoom\apps\web\src\world\Postfx.tsx`, `C:\Users\siheon.ryu\Desktop\workspace\R2P\EnsembleRoom\apps\web\src\world\WorldCanvas.tsx`, `C:\Users\siheon.ryu\Desktop\workspace\R2P\EnsembleRoom\apps\web\src\world\CameraRig.tsx`, `C:\Users\siheon.ryu\Desktop\workspace\R2P\EnsembleRoom\apps\web\src\world\agents\labels.tsx`, `C:\Users\siheon.ryu\Desktop\workspace\R2P\EnsembleRoom\apps\web\src\world\LabelLayer.tsx`
- 캔버스 배치: `C:\Users\siheon.ryu\Desktop\workspace\R2P\EnsembleRoom\apps\web\src\stage\WorldHost.tsx`(123–126, 170–172행)
- 앰버: `C:\Users\siheon.ryu\Desktop\workspace\R2P\EnsembleRoom\packages\shared\src\colors.ts`, `C:\Users\siheon.ryu\Desktop\workspace\R2P\EnsembleRoom\packages\shared\src\interactions.ts`, `C:\Users\siheon.ryu\Desktop\workspace\R2P\EnsembleRoom\apps\web\src\messenger\visits.ts`
