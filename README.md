# Ensemble Room

Ensemble Room은 "나 / 상대 / 우리" 세 종류의 Room을 해변 위 유리 캡슐로 보여 주는 협업 데모다. 각자의 My Room(나)에는 Personal Agent가 있고, 상대의 My Room은 방문(사람 또는 내 Agent 보내기)으로만 들어갈 수 있으며, 함께 쓰는 Our Room(우리)에는 중립적인 Room Agent가 있다. MVP 흐름은 **Invite → Leave → Rejoin**이다. 초대나 방문으로 시작해 자리를 비우면(Leave) 내 Agent가 위임 범위 안에서 대신 참여하고, 돌아오면(Rejoin) 놓친 변화를 다이제스트로 받아 승인·수정한다. 모든 변화는 이벤트 로그에 쌓이고, 타임라인으로 되감아 볼 수 있다. 설계 기준은 [docs/implementation-plan.md](docs/implementation-plan.md)다.

## 요구 사항

- Node.js 24 이상 (루트 `package.json`의 `engines`. 서버가 내장 `node:sqlite`를 쓴다. 개발은 24.x에서 했다.)
- npm 11 (workspaces)
- WebGL2가 되는 브라우저 (3D 월드)
- Claude 모드를 쓸 때만: Anthropic API 키(또는 프록시)

## 설치와 실행

```bash
npm install
npm run seed     # 선택. data/ensemble.db에 시드 데이터를 넣는다 (서버도 빈 DB면 기동 시 자동으로 넣는다)
npm run dev      # 서버 + 웹 동시 실행
```

- 웹: http://localhost:5173 (Vite가 `/api`, `/ws`를 서버로 프록시한다)
- 서버: http://localhost:8787 (`GET /api/health`로 상태와 `agentMode` 확인)

**로그인**: 이름만 고른다. 로그인 가능한 사용자는 **Alice**와 **Bob**이다. 엄마와 Dana는 시드 전용이라 로그인할 수 없다(월드에 뒤편 캡슐과 우리 Room 구성원으로만 보인다).

**두 창으로 열기**: 세션 토큰이 `sessionStorage`에 저장되므로 브라우저 **탭(또는 창)마다 다른 사용자**로 로그인할 수 있다. 같은 브라우저에서 탭 두 개를 열어 한쪽은 Alice, 다른 쪽은 Bob으로 입장한다. 나란히 놓으면 데모가 가장 잘 보인다.

## 환경 변수

저장소 루트의 `.env`를 우선 읽고, 없으면 `.env.txt`를 읽는다(둘 다 git에서 무시된다). 예시는 [.env.example](.env.example). 값 없이도 기본값(mock)으로 동작한다.

| 이름 | 기본값 | 의미 |
|---|---|---|
| `PORT` | `8787` | 서버 포트 |
| `AGENT_MODE` | `mock` | `mock`: LLM 없이 결정적으로 동작(키 불필요). `claude`: 실제 Claude 호출. `claude`가 아니면 모두 mock |
| `ANTHROPIC_BASE_URL` | (비어 있음) | 프록시를 쓸 때 SDK baseURL |
| `ANTHROPIC_API_KEY` | (비어 있음) | Claude 모드의 API 키. 절대 커밋하지 않는다 |
| `ANTHROPIC_MODEL_AGENT` | `claude-sonnet-5` | Agent 턴에 쓰는 모델 ID |
| `ANTHROPIC_MODEL_LIGHT` | `claude-sonnet-4-6` | Room 요약·다이제스트 같은 가벼운 작업용 모델 ID |
| `AGENT_MOCK_DELAY_MS` | `350` | mock Agent의 단계별 지연(ms). 0이면 지연 없음 |
| `IMPLICIT_LEAVE_MS` | `30000` | Room 구독이 끊긴 뒤 암묵적 퇴장으로 기록하기까지의 시간(ms) |
| `SUMMARY_EVERY_EVENTS` | `30` | Room 요약을 갱신하는 변화 이벤트 수 |
| `AGENT_CHAIN_LIMIT` | `4` | Agent끼리 연쇄로 이어 말할 수 있는 상한. 넘으면 `agent_paused` |
| `VISIT_MAX_TURNS` | `6` | 방문 중인 Agent의 턴 상한. 도달하면 방문을 끝내고 takeout을 공개 |
| `MAX_TURNS_PER_ROOM_HOUR` | `60` | Room당 시간당 Agent 턴 상한 |
| `DB_PATH` | `data/ensemble.db` | SQLite 파일 경로 |

참고: 프로젝트 `.env`(또는 `.env.txt`)에 적은 `ANTHROPIC_BASE_URL`과 `ANTHROPIC_API_KEY`는 셸에 이미 내보내진 같은 이름의 값보다 **우선한다**(상위 도구가 값을 내보내 둬도 파일 설정이 쓰인다). 나머지 변수는 셸 값이 우선한다.

Claude 모드 예: `.env`에 `AGENT_MODE=claude`, `ANTHROPIC_API_KEY=...`(프록시면 `ANTHROPIC_BASE_URL=...`)를 적고 `npm run dev`.

## 데모 대본

사전 준비: `npm run dev`로 실행하고 탭 두 개를 연다. 왼쪽 탭은 **Alice**, 오른쪽 탭은 **Bob**으로 입장한다. 처음이면 `data/`를 지우고 다시 시작하는 것이 깔끔하다(아래 "초기화").

mock 모드에서 알아 둘 점: Agent는 **불렀을 때만** 답한다. 입력창 왼쪽의 "받는 이" 선택(기본 "모두에게")에서 Agent를 골라 보내야 응답한다. 선택하지 않은 일반 대화에는 조용하다(Agent는 동행 중 거의 침묵한다). 답변은 정해진 규칙이라 같은 입력에는 같은 답이 나온다. claude 모드에서는 같은 흐름이 실제 모델 응답으로 바뀌고, 호출을 받지 않았을 때 끼어들지 말지도 모델이 판단한다.

### 1. 조망: 나 / 상대 / 우리
- 두 탭 모두 로그인하면 메신저 뒤로 해변 월드가 보인다.
- 앞 중앙에 **내 캡슐**(유리가 투명), 뒤쪽에 **우리 캡슐**(친구들·우리 가족·팀), 더 뒤에 **상대 캡슐**(서리 낀 유리, 안이 안 보임)이 있고 유리 튜브로 이어져 있다.
- Bob 탭에서는 같은 월드가 대칭으로 보인다(Bob의 캡슐이 앞 중앙).
- 상대 커서와 Agent 무리(swarm)가 캡슐 사이를 움직인다.

### 2. 내 방에서 Agent와 대화 (Alice 탭)
1. 왼쪽 대화 목록에서 **내 Room**을 열거나 캡슐로 들어간다. 가운데 마디가 열리며 카메라가 들어간다.
2. 입력창의 받는 이에서 **내 Agent**("Alice의 Agent")를 고르고 "주말 아이디어 카드 만들어 줘"처럼 보낸다. 카드/보드 말이 들어가면 mock Agent가 카드를 만들어 보드에 붙는다(활동 피드와 보드 패널에서 확인).
3. "토요일 기억해 줘"처럼 "기억"을 넣어 보내면 기억이 쌓인다. 기억은 기본 **나만 보기**다.
4. 보이는 것: Agent가 "생각하는 중/쓰는 중" 상태로 바뀌고 답이 스트리밍된다. 보드에 카드가 생긴다.

### 3. 상대: Bob의 Agent 방문 (수락, 튜브 이동, takeout 승인, 방문 보고)
1. Alice 탭 사이드바의 **사람 > Bob**(대화)을 선택하고, 오른쪽 미리보기 패널의 **Agent 보내기**를 누른다. 시트에 위임 메모(예: "토요일 오후로 조율, 예산 3만원, 확정은 내 승인")와 허용할 행동을 정하고 **보내기**.
2. Bob 탭의 Alice 대화에 방문 요청 카드가 뜬다. 허용할 권한을 확인하고 **수락**을 누른다.
3. 보이는 것: Alice의 Agent가 입자로 분해돼 튜브를 지나 Bob의 캡슐에 도착한다. 도착하면 인사 한 줄을 한다.
4. Bob이 자기 Room에서 받는 이로 방문 Agent를 골라 말을 걸면 위임 범위 안에서 답한다. 방문 중에는 받는 이 목록에 "→ Alice의 Agent"가 나타난다. "확정" 같은 말에는 직접 정하지 못한다고 답하고 Alice에게 메모를 남긴다(승인 요청은 Leave 뒤 대리 참여나 Room Agent에서 일어난다).
5. 방문은 두 가지로 끝난다. 끝나면 두 탭의 방문 표시가 사라지고 방문 Agent는 같은 튜브로 집에 돌아간다(조망에서 입자가 되돌아가는 것이 보인다).
   - **방문 Agent가 스스로 끝낸 경우**(턴 상한, 기본 6턴·인사 포함, 에 닿아 방문을 마침): 방문 Agent가 가져갈 내용(takeout)을 공개하고, Bob에게 **가져가기 승인** 카드가 뜬다. **승인**하면 Alice 쪽으로 옮겨지고 **거절**하면 폐기된다.
   - **호스트 Bob이 "방문 종료"를 직접 누른 경우**: 방문만 끝나고("호스트가 종료") takeout이 없으므로 **가져가기 승인 카드는 생기지 않는다**. takeout은 방문 Agent 자신이 끝낼 때만 만들어지는 설계다(계획 7절).
6. Alice 탭에서 **방문 보고**를 확인한다. 보고는 Alice에게만 보이고 Bob에게는 보이지 않는다.
- 사람 방문도 가능하다: 상대 DM의 **방문 요청**을 보내면 상대가 **수락**해야 요청자 화면에서 상대 캡슐의 서리가 걷히고(흰 띠가 한 번 지나간다), **방문 종료**하면 다시 낀다. 내 Agent가 방문 중인 상대 캡슐도 서리가 걷히지만, 사람 방문의 투명 유리와 달리 **옅은 서리가 남고 내 색의 림 빛이 돌며 라벨에 "Agent 방문 중"이 붙는 "agent 시야"**로 보이고, 방문이 끝나면 다시 낀다(호스트 화면은 원래 투명이라 변화 없음, 제3자는 계속 서리). Agent를 보낼 때 적은 위임 범위는 호스트의 방문 요청 카드와 Room의 Agent 상태에 "위임 범위" 전용 블록(점선 테두리)으로 보이고, 소유자에게는 "내가 맡긴 범위"로 보인다. 사람 방문자는 허용된 권한(보기, 댓글 등)만 쓴다.

### 4. 우리: 합의
1. 두 탭 모두 **친구들** Room(우리 캡슐)으로 들어간다.
2. 한쪽이 "토요일로 확정할까?"처럼 **"?"를 넣어** 보내거나(받는 이는 "모두에게" 그대로), 받는 이를 **→ 친구들 Room Agent**로 골라 "토요일로 확정하자"를 보낸다. "?" 없이 "모두에게" 보낸 문장에는 Room Agent가 반응하지 않는다. Room Agent가 "확정/결정" 말을 보면 선택지(**확정** / **조금 더 논의**)와 **거절** 버튼이 달린 **결정 요청** 카드를 연다.
3. 두 탭에서 모두 같은 선택지(예: **확정**)를 누르면 합의 카드가 만들어지고(`agreement_formed`) 합의 연출이 나온다. 한 명이라도 **거절**하면 즉시 거절로 끝난다.
4. 질문("?" 포함)이나 "정리해 줘"를 보내면 Room Agent가 최근 대화를 요약한다.

### 5. Leave(위임)와 대리 참여
1. Alice 탭에서 친구들 Room의 **Leave**를 누른다. 시트에서 위임 메모를 적고 **Leave**(비워 두면 대리 참여 없이 자리만 비운다). 캡슐 조명이 비어 있음 쪽으로 바뀐다.
2. Bob이 계속 대화한다. 위임 범위 안에서는 Alice의 Agent가 대신 말한다. 위임 밖의 일(카드 수정 등)은 Alice에게 승인으로 남는다.
3. Leave 상태에서는 Alice의 입력이 막히고 "Leave 중이에요 · Rejoin하면 쓸 수 있어요"가 보인다.

### 6. Rejoin 다이제스트
1. Alice 탭에서 **Rejoin**을 누른다(Leave 중에는 Leave 자리에 이 버튼이 나온다).
2. "돌아온 것을 환영해요" 다이제스트 창이 뜬다: **요약**, **보드 변화**, **내가 결정할 승인**. **확인했어요**를 누르면 `digest_viewed`가 기록된다. 창을 닫았다면 위에 뜨는 **다이제스트 보기**로 다시 열 수 있다.
3. 대기 중인 승인은 다이제스트 창이나 오른쪽 활동 피드에서 카드의 선택지 버튼(결정 요청은 **확정** / **보류** 같은 선택지와 **거절**, 편집 제안은 **승인 / 수정 승인 / 거절**)으로 처리한다. 이 승인·수정·거절은 지표에 센다.
4. 새로고침 등으로 생긴 "자리를 비웠어요 → 돌아왔어요" 암묵 퇴장·재입장 쌍은 활동 피드에서 "잠깐 자리를 비웠다 돌아왔어요 · N회" 한 줄로 접혀 보인다(서버 기록은 그대로).

### 7. 타임라인
- Room 화면 하단 **타임라인**의 슬라이더(또는 **◀ / ▶** 한 단계 앞/뒤 버튼)를 끌면 3D 장면, 활동 피드, 조명이 그 시점으로 되감긴다. 재생 중에는 "과거 재생 중" 배지가 보이고 입력이 막힌다. 끝까지 당기거나 **지금으로**를 누르면 돌아온다.

### 8. 기억 패널과 격리
1. 메신저 오른쪽 패널의 **내 기억** 탭을 연다. 기억마다 **나만 보기** / **이 방에 제공**(Room별 공유) 중 공유 대상을 바꿀 수 있다.
2. 격리 확인: Alice가 어떤 기억을 "친구들"에만 공유하면, 같은 질문을 "우리 가족"이나 "팀"에서 해도 그 기억은 쓰이지 않는다. Bob 탭의 Bob의 Agent는 Alice의 개인 기억을 볼 수 없다. 방문 Agent는 방문 범위 밖 이벤트와 호스트의 개인 기억을 보지 못한다.
3. mock에서 인용을 보려면 기억이 있는 상태에서 Agent를 불러 질문하면 첫 기억을 인용한다(`(기억: …)`).

### 연쇄 상한 시연 (선택)
Agent끼리 연쇄는 `AGENT_CHAIN_LIMIT`(기본 4)에서 멈춘다. 친구들 Room에서 받는 이를 내 Agent로 하고 `ping ag_bob`을 보내면 Alice의 Agent가 Bob의 Agent에게 ping을 보내고, 서로 ping/pong을 주고받다 상한에서 `agent_paused`가 기록된다. 사람이 다시 말하면 풀린다. 시드 Agent id: `ag_alice`, `ag_bob`.

## 지표

`GET /api/metrics` (Bearer 토큰)는 이벤트 로그에서 파생한 지표를 돌려준다: Agent 턴 수, 방문 요청·수락률·takeout, Leave(위임)·Rejoin·놓친 변화·다이제스트, 승인 요청/해소 수와 평균 소요 시간, 승인·수정·거절 비율, 합의 수, 기억 수, Room 반복 사용률. 요청자에게 **보이는 이벤트만** 센다(남의 Room이나 private 이벤트는 반영되지 않는다). `?roomId=`로 한 Room만 볼 수 있고, 접근 권한이 없으면 403이다. 화면은 사이드바의 **지표** 버튼(`/metrics`)에서 볼 수 있다: 전체 카드, Room별 표, 비율(값이 없으면 "-"), 평균 해소 시간(초), 종류별 승인 수.

## 초기화

`data/`를 지우면 DB가 초기화된다. 서버를 끈 뒤 지우고 다시 시드한다.

```bash
rm -rf data        # Windows PowerShell: Remove-Item -Recurse -Force data
npm run seed       # 또는 npm run dev (빈 DB면 기동 시 자동 시드)
```

## 에셋

3D 소품·환경·캐릭터 에셋은 이미 `apps/web/public/assets/`에 들어 있다. 다시 만들려면:

```bash
npm run assets:extract -- <데모.html 경로>   # 캐릭터·아바타·Lottie 추출 (스크립트를 실행하지 않고 텍스트만 파싱)
npm run assets:props                          # assets-src/의 원본을 소품 GLB·HDRI·텍스처·폰트로 가져오기
npm run assets:props -- --download            # 없는 원본을 공식 배포처에서 내려받기
```

자세한 내용은 [tools/README.md](tools/README.md). 출처와 라이선스는 [CREDITS.md](CREDITS.md).

## 개발 명령

| 명령 | 설명 |
|---|---|
| `npm run dev` | 서버(Fastify, `tsx watch`)와 웹(Vite) 동시 실행 |
| `npm test` | 전 워크스페이스 vitest |
| `npm run typecheck` | 전 워크스페이스 타입 검사 |
| `npm run build` | 웹 타입 검사 + 번들 빌드 |
| `npm run seed` | 시드 데이터 (재실행해도 중복되지 않음) |
| `npm run smoke:claude` | 프록시 연결 확인용 스모크 (아래 문제 해결) |
| `npm run smoke:turn` | Claude 모드로 실제 한 턴을 돌려 이벤트 기록을 확인 (인메모리 DB) |

## 디렉터리 구조

- `packages/shared` 이벤트 스키마, 권한, 상태 리듀서, 시점(perspective) 계산, API 계약. 서버와 웹이 공유한다.
- `apps/server` Fastify + WebSocket + `node:sqlite`. `src/agent`(런타임·mock·Claude provider), `src/domain`(Room·방문·승인·지표), `src/memory`(기억 격리·요약), `src/events`(이벤트 로그), `src/routes`, `src/realtime`(hub), `scripts/`(스모크).
- `apps/web` Vite + React + Tailwind + React Three Fiber. `src/messenger`(메신저), `src/room`(Room 화면), `src/world`(해변·캡슐·Agent 스프라이트), `src/stage`, `src/fx`.
- `tools` 에셋 추출·가져오기 스크립트. `docs` 설계 문서. `data/`(런타임 DB)와 `assets-src/`(원본)는 git에서 무시된다.

## 개발용 화면: `/lab/world`

http://localhost:5173/lab/world 는 서버·로그인 없이 목(mock) 월드로 3D 장면을 확인하는 개발용 화면이다. 쿼리 파라미터 예:

| 파라미터 | 의미 |
|---|---|
| `viewer` | 시점 사용자 (기본 `u_alice`) |
| `focus` / `select` | 포커스·선택할 Room id |
| `visit` | 방문 중인 Room id 목록(쉼표) |
| `amb` | Room별 조명 단계 지정 |
| `state` / `mode` | Agent 상태·모드 |
| `chars=0` | 캐릭터 숨김 |
| `ui=0` | 오버레이 UI 숨김 |
| `fx` | 연출 목록(쉼표) |
| `intro=1` | 진입 연출 켜기 |
| `q` | 3D 품질 단계(`/lab/world`와 월드 공통) |

월드 화면에서는 `?intro=0|1`로 진입 연출을, `?q=`로 품질 단계를 바꿀 수 있다.

## 문제 해결

- **Agent 턴이 오류로 끝난다 / 403 `key_model_access_denied`**: 프록시가 받지 않는 모델 ID를 쓰고 있다. `.env`의 `ANTHROPIC_MODEL_AGENT`·`ANTHROPIC_MODEL_LIGHT`를 프록시가 제공하는 모델로 바꾼다.
- **프록시 연결 확인**: `npm run smoke:claude`는 설정된 두 모델로 스트리밍 + tool use 한 번을 호출해 `[OK]`/`[FAIL]`(모델 ID, HTTP 상태, 에러 타입)만 출력한다. 키·URL·응답 본문은 출력하지 않는다. 모델을 직접 지정하려면 `npm run smoke:claude -- <모델ID> ...`, 실패 시 모델 목록을 보려면 `--list-models`. `npm run smoke:turn`은 실제 한 턴을 돌려 기록된 이벤트를 요약한다. 둘 다 실제 API를 호출한다.
- **셸에 `ANTHROPIC_*`가 있는데 프로젝트 설정이 안 먹는다**: 프로젝트 `.env`의 `ANTHROPIC_BASE_URL`/`ANTHROPIC_API_KEY`가 우선한다. 파일에 값이 빈 줄(`ANTHROPIC_API_KEY=`)이 있어도 셸 값을 빈 값으로 덮어쓰므로, 셸 값을 쓰고 싶으면 그 줄을 지운다.
- **키가 없다**: `AGENT_MODE=mock`(기본)으로 두면 키 없이 동작한다.
- **월드가 안 보인다**: WebGL2가 필요하다. 하드웨어 가속을 켜거나 `?q=`로 품질을 낮춘다.

## 알려진 제한

- 로그인은 이름만 고르는 데모 인증이다(비밀번호 없음). 외부에 공개하지 말 것.
- DM에는 3D Room이 없고 Agent도 돌지 않는다.
- 타임라인 열람률과 토큰·지연 지표는 이벤트로 기록하지 않아 집계하지 않는다.
- 지표는 요청자에게 보이는 이벤트에서만 계산하므로 사용자마다 값이 다르다.
- Hindsight 등 외부 메모리 백엔드는 쓰지 않는다(자체 SQLite 메모리와 인터페이스만 있다).
- 로컬 단일 프로세스 데모다. 동시 접속 확장, 배포용 인증, 마이그레이션 도구는 범위 밖이다.
- 성능은 내장 그래픽 노트북 기준 low/mid 품질을 목표로 했다. 환경에 따라 `?q=`로 조절한다.

## 크레딧

외부 에셋(Kenney Furniture Kit, Poly Haven, Noto Sans KR 등)의 출처와 라이선스는 [CREDITS.md](CREDITS.md)를 본다.
