# Ensemble Room 구현 계획 (최종판)

> 이 문서 하나로 완결된다. implementer는 9절 단계 순서대로 구현한다.

## 0. 확인한 사실 / 추론 구분

**로컬에서 확인**
- 로컬 Node는 v24.16.0, npm은 11.13.0이다.
- 저장소 `C:\Users\siheon.ryu\Desktop\workspace\R2P\EnsembleRoom`는 `.git`만 있다(origin github.com/jovinus302/EnsembleRoom).

**컨셉 문서** (`C:\Users\siheon.ryu\Downloads\ensemble_room_concept.html`, 10장)
- Room은 "채팅방·Task Board가 아니다"(03). My/Your/Our Room 3분 구도(03).
- Agent는 팀원이다(01). 개인 Agent 정보는 자동 공유하지 않는다(04).
- 상호작용 문법은 Invite/Visit/Leave/Merge/Split/Rejoin이다(05). 히어로 인터랙션은 "Leave My Agent Here"(06).
- MVP는 Invite→Leave→Rejoin이다(09). 지표: 초대율, Leave 실행률, 재합류율, 반복 Room 사용률, 승인/수정 비율.
- 색: Agent 민트(#3baf96/#64e4bd), Skill 보라(#8f7dbd), 강조 오렌지(#ffc88c).

**캐릭터 에셋 파일** (`C:\Users\siheon.ryu\Downloads\ensemble-demo-v33.0.html`, 16.7MB, 4466줄)
- 3D 라이브러리가 없다. CSS keyframes와 lottie-web(SVG)으로 만든 2D 피치덱 12장이다.
- `swarm`, `boid`, `flock`, `mouse`는 0건이다.
- **Lottie 3종** (60fps, PNG가 base64로 임베드됨)
  - `ap-j1` "Lime cheerful notification → idle": 512², 마커 action과 idle.
  - `ap-j2` "Lime jump + upright yaw 360": 7.5° 간격 회전 프레임 47장, 각 512².
  - `ob-j` "Blue and lime high-five then idle": 768×512, 마커 conversation, agreement, prepare, joint jump, high five, landing.
- Lottie 레이어가 눈(near/far), 입, 몸 부유, 밑단 물결로 분리돼 있다.
- **캐릭터 `<img>` 6종** (모두 144×144)
  - 유령형(라임·초록, "PM Agent > A/B/C 프로젝트" 행): 별 후광, 고글 등의 장식.
  - 알형(하늘·청록, 팔과 발, "팀 Agent" 행): 베레모, `</>`, 고글.
  - 얼굴은 공통으로 검은 타원 눈 두 개와 미소.
- **고해상도 몸통**: `blue_body` 512²(얼굴 없음), `blue_arm` 160×208, `lime_body` 1254²(얼굴 없음).
- 위 구분은 행 순서로 판단한 것이라 추정을 포함한다.

**Room 비주얼 참고 이미지**
- 1번(직접 확인함): 노을 진 해변 모래 위의 가로로 누운 알약형 투명 유리 캡슐.
  - 안에 미니어처 작업실이 들어 있다: 원목 바닥, 흰 벽, 책상, 모니터, 의자, 서랍장, 스탠드, 액자, 화분, 조약돌.
  - 유리에 세로 이음매 링이 2개 있고, 벽에 이름 간판이 있다.
  - 얕은 피사계 심도로 접사 느낌이 난다.
- 2번(묘사만 전달받음): 같은 계열의 더 통통한 캡슐 안에 카페가 있다. 원목 바 카운터, 에스프레소 머신, 빵, 펜던트 전구 2개, 원형 테이블·스툴 여럿, 아치 선반, 덩굴 식물.
- 간판 문구와 특정 디자인은 복제하지 않는다.

**WebSearch / WebFetch로 확인**
- Hindsight: MIT. bank는 strictly isolated. Anthropic 제공자 지원. npm 클라이언트 `@vectorize-io/hindsight-client`. Docker 또는 pip(Python)로 실행하고 기본 DB는 임베디드 pg0. 기본 임베딩은 `BAAI/bge-small-en-v1.5`(local), 리랭커는 `ms-marco-MiniLM`. Windows x86_64 지원.
- chatscope chat-ui-kit-react: MIT(v2.1.1).
- WorkAdventure: AGPL v3 + Commons Clause(비OSI).
- Rocket.Chat: 코어 MIT, 엔터프라이즈는 별도 라이선스.
- Tinode, Synapse, Conduit: 라이선스 표기가 출처마다 다르다.
- R3F: 안정판 v9, v10은 WebGPU 우선 알파.
- drei `MeshTransmissionMaterial`: `samples`, `resolution`, `backside`, `backsideResolution` 옵션이 있다. backside는 추가 패스다. 여러 오브젝트가 **공유 버퍼**를 쓰는 예제가 있다.
- @react-three/postprocessing: `TiltShift2`, `N8AO`, `ToneMapping`(AGX 등 모드) 제공.
- drei `Environment`: preset은 CDN에 의존하므로 프로덕션 사용은 권장하지 않는다. `files`로 자체 HDR을 지정할 수 있다. sunset preset은 venice_sunset_1k.
- Poly Haven: 모든 에셋 CC0.
- Kenney Furniture Kit: CC0, "140×" 파일, 2018 v1.0(파일 형식은 페이지에서 확인 못 함).
- Quaternius: CC0(2차 출처, 미검증).
- Poly Pizza: 모델별 라이선스이고 대부분 CC-BY라 크레딧이 필요하다.
- "mouse swarm"과 가까운 레퍼런스: GitHub "Swarm"(DrBaph, Apache-2.0, 커서를 쫓는 무리), three.js 포럼의 R3F + WebGPU/TSL 무리 장면.

**그 외 설계 판단은 추론이다.** 기억에 의존한 주장은 "(미검증)"으로 표시한다.

## 1. 확정 스택과 3D 기술

| 층 | 선택 | 근거 |
|---|---|---|
| 모노레포 | npm workspaces: `packages/shared`, `apps/server`, `apps/web` + 루트 `concurrently` | `npm install && npm run dev` 하나로 뜬다 |
| 프런트 | Vite + React + TypeScript + Tailwind + zustand | SSR 불필요, 3D와 DOM이 스토어 하나를 공유 |
| 3D | **@react-three/fiber v9 + three + @react-three/drei + @react-three/postprocessing(WebGL2)** | 아래 근거 |
| 유리 | drei `MeshTransmissionMaterial`(공유 버퍼), 하위 단계는 `MeshPhysicalMaterial` + 프레넬 가짜 유리 | |
| 환경·조명 | drei `Environment files=`(자체 호스팅 Poly Haven CC0 sunset HDRI, `backgroundBlurriness`), 낮은 각도의 따뜻한 DirectionalLight, 실내 PointLight 최대 4개(나머지 전구는 emissive) | |
| 그림자 | drei `AccumulativeShadows` + `RandomizedLight`(정적 베이크) 또는 `ContactShadows`(frames=1) | 정적인 모래 위 그림자 |
| 후처리 | Bloom(luminanceThreshold), TiltShift2(미니어처), ToneMapping(AGX), Vignette, N8AO(high 단계만) | |
| 입자 | three `GPUComputationRenderer`(examples/jsm) GPGPU | 수만 개 입자 |
| 텍스트 | drei `Text`(troika) + Noto Sans KR 서브셋(OFL), 라벨은 drei `Html` | 한글 간판·라벨 |
| 2D 애니메이션 | lottie-web(DOM 오버레이 전용) | 에셋이 Lottie |
| 서버 | Node 24 + Fastify + @fastify/websocket + zod | 로컬 단일 프로세스 |
| DB | node:sqlite(내장). 문제가 있으면 better-sqlite3로 `db/index.ts`만 교체 | 네이티브 빌드 위험 회피 |
| LLM | @anthropic-ai/sdk, 스트리밍 + tool use. env는 `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL_AGENT`, `ANTHROPIC_MODEL_LIGHT` | 서버에서만 호출 |
| 에셋 처리 | `@gltf-transform/cli`(glb 최적화), Kenney 원본이 OBJ/FBX뿐이면 `obj2gltf`(미검증) | |
| 테스트 | vitest(shared, server) + 수동 체크리스트(web) | |

**3D 근거**
- DOM UI(메신저, 패널, 승인)와 3D가 이벤트 리듀서 결과 하나를 공유해야 한다. R3F는 이를 동기화 코드 없이 해결한다.
- 유리 투과, 환경 맵, 틸트 시프트, 블룸, GPGPU가 drei와 postprocessing에 이미 부품으로 있다.
- 2D 캐릭터는 빌보드로 충분하다.

**대안**
- Babylon.js: React 동기화를 직접 짜야 한다.
- PixiJS 2.5D: 유리, 카메라 비행, 입자 표현이 약하다.
- R3F v10/WebGPU: 알파 단계라 불안정하다.
- Unity/Godot 웹: 무겁고 DOM UI와 결합하기 어렵다.

**호스팅으로 옮길 때 바꿀 지점** (코드에 `// HOSTING:` 표시)
- `db/index.ts`: SQLite → Postgres
- `realtime/hub.ts`: 메모리 → Redis pub/sub
- `agents/scheduler.ts`: 프로세스 내 큐 → 내구성 있는 큐
- `auth.ts`: 이름 로그인 → 실제 인증
- web: `VITE_API_BASE`

**가정이 틀렸을 때 바뀌는 부분**
- Claude API가 막혀 있다 → `agents/claude.ts`만 교체하고, 그동안 `AGENT_MODE=mock`으로 시연한다.
- 외부 배포를 한다 → HOSTING 지점과 인증을 교체한다.
- 노트북 GPU가 약하다 → 품질 low가 기본값이 된다(가짜 유리, 입자 4k).
- node:sqlite를 쓸 수 없다 → better-sqlite3로 교체한다.

## 2. 범위

**넣는 것**
- 메신저 홈: 사람, DM, "우리" 목록, Room 미리보기.
- My Room, Your Room(사람 방문, Agent만 보내기), Our Room.
- Invite / Visit / Leave / Rejoin, 승인(다중 승인자).
- 메모리 네임스페이스와 격리.
- Claude Agent: Personal Agent, 그리고 Our Room에만 있는 Room Agent.
- 3D 해변 월드와 유리 캡슐 Room(테마별 실내), swarm, 피드백 계층, 타임라인 재생, 지표.

**빼는 것**
- Merge와 Split 기능(단, "내 것 + 네 것 → 우리 것"의 합의 연출은 넣는다).
- Skill Agent, 알림, 모바일, 네이티브 앱.
- 관계 유형 체계, 실제 인증, CRDT.
- Hindsight 실연동(S20 선택 단계).

**Our Room**
- 실제 공동 소유 Room이다. 모델은 이름 + 구성원뿐이다.
- 시드 3개: "친구들"(Alice, Bob), "우리 가족"(Alice + 시드 사용자 '엄마'), "팀"(Alice, Bob, 시드 사용자 'Dana').
- 세 Room 모두 같은 코드로 동작한다. 시드 사용자(`users.kind='seed'`)는 로그인하지 않으므로 항상 자리 비움이며, 그 Agent는 자동 대리(`auto_reply`)로 인물 설정(`agents.persona_public`)에 맞게 `say`/`pass`만 한다(승인해 줄 사람이 없어 `request_approval`은 도구 목록과 서버 검증에서 모두 막는다). 승인자 계산에서도 제외한다.
- 세 Room 모두 시드 대화·카드·방 기억을 넣는다(친구들: 주말 저녁 영화 모임, 미확정 카드). 가족과 팀의 기억은 서로 다르게 두어 격리를 시연한다.

**실내 테마 (1차에 실제 제작은 3세트)**
- `studio`(작업실): Alice의 My Room.
- `lounge`(라운지·서재): Bob의 My Room.
- `cafe`(카페): Our Room 기본값.
- "우리 가족"과 "팀"은 `cafe` 세트를 소품 변형으로 재사용한다. `variant: 'home'`은 식탁과 러그, `'meeting'`은 긴 테이블과 화이트보드.
- Our Room에 카페를 쓰는 것은 **선택지**다. 여러 좌석이 있는 공간이라 "우리"에 어울린다는 추정에 따른 것이다. 테마는 `rooms.theme` 값으로 바꿀 수 있고, 대안은 `living`(거실)이다.

## 3. 디렉터리 구조와 파일 책임

```
EnsembleRoom/
  package.json            # workspaces; scripts: dev, build, test, typecheck, seed, assets:extract, assets:props
  tsconfig.base.json  .gitignore(data/, .env, node_modules, assets-src/)  .env.example  README.md  CREDITS.md
  docs/implementation-plan.md
  tools/extract-demo-assets.mjs   # 캐릭터 에셋 추출 (10.1)
  tools/import-props.mjs          # 소품 glb 가져오기·최적화 (10.2)
  tools/props-manifest.json       # 테마별로 가져올 소품 목록(원본 파일명 → 출력명, 라이선스)
  assets-src/                     # 사용자가 내려받은 원본 zip 압축 해제 위치 (커밋 안 함)
  packages/shared/src/
    events.ts  api.ts  permissions.ts  namespaces.ts
    agentState.ts   # 이벤트 → AgentVisualState
    roomState.ts    # 이벤트 → board/members/presence/visits/approvals + roomAmbience(조명 단계)
    perspective.ts  # relation(viewer, room) → mine|yours|ours, 라벨, glassClarity(viewer, room, visits)
    colors.ts       # 팔레트, oklch 혼합
    themes.ts       # 테마 id 목록과 좌석 수 등 서버·클라이언트 공통 메타
    index.ts
  packages/shared/test/
  apps/server/src/
    index.ts  config.ts  auth.ts
    db/schema.sql  db/index.ts  db/repo.ts  db/seed.ts
    events/store.ts  realtime/hub.ts
    domain/actions.ts  domain/presence.ts  domain/visits.ts  domain/approvals.ts  domain/rooms.ts
    memory/types.ts  memory/localStore.ts  memory/gateway.ts  memory/summarizer.ts  memory/hindsightStore.ts(S20)
    agents/scheduler.ts  agents/runTurn.ts  agents/context.ts  agents/tools.ts  agents/prompts.ts  agents/llm.ts  agents/claude.ts  agents/mock.ts
    routes/auth.ts  rooms.ts  visits.ts  approvals.ts  memory.ts  metrics.ts
  apps/server/test/
  apps/web/
    vite.config.ts  index.html
    public/assets/characters/*  avatars/*  lottie/*  props/*.glb  hdri/*.hdr  textures/*  fonts/*
    src/main.tsx  App.tsx
    src/api/client.ts  api/ws.ts
    src/store/session.ts  worldStore.ts  roomStore.ts  fxStore.ts
    src/messenger/MessengerHome.tsx Sidebar.tsx ConversationView.tsx MessageList.tsx Composer.tsx RoomPreviewPanel.tsx VisitCards.tsx
    src/room/RoomView.tsx ActivityFeed.tsx BoardPanel.tsx ApprovalPanel.tsx LeaveSheet.tsx SendAgentSheet.tsx TimelineScrubber.tsx MemoryPanel.tsx AgentStatusList.tsx
    src/scene/WorldCanvas.tsx      # 앱 루트에 1회 마운트
    src/scene/CameraRig.tsx        # 원근 접사 카메라, 조감 ↔ 캡슐 진입 비행, 초점 거리 제어
    src/scene/quality.ts           # 품질 단계 (8.6)
    src/scene/world/Beach.tsx      # 모래 바닥, 원경 HDRI, 노을 태양광, 베이크 그림자
    src/scene/world/layout.ts      # 시점 중심 캡슐 배치
    src/scene/world/GlassTube.tsx  # 캡슐 사이 유리 튜브 통로
    src/scene/capsule/CapsuleShell.tsx    # 공통 캡슐: 유리, 이음매 링, 받침, 열리는 가운데 마디
    src/scene/capsule/GlassMaterial.tsx   # 품질 단계별 유리(투과 / 가짜), 서리 정도, 파문 uniform
    src/scene/capsule/RoomSign.tsx        # 벽 간판(Room 이름, drei Text)
    src/scene/capsule/InteriorLights.tsx  # 조명 단계 → 전구·스탠드 강도와 색
    src/scene/interiors/themes.tsx        # 테마 id → 실내 컴포넌트, 앵커(좌석, Agent 위치, 보드, 조명, 문), 팔레트
    src/scene/interiors/Studio.tsx  Lounge.tsx  Cafe.tsx  # 소품 배치 (glb + 프리미티브)
    src/scene/interiors/Prop.tsx          # useGLTF 래퍼 + 프리미티브 대체
    src/scene/BoardObject.tsx  HumanAvatar.tsx
    src/scene/agents/AgentSprite.tsx spriteMaterial.ts faceTexture.ts useYawAtlas.ts
    src/scene/fx/Swarm.tsx swarmSim.ts swarmDirector.ts Projectile.tsx Tether.tsx ApprovalCrystal.tsx GlassRipple.ts Postfx.tsx
    src/overlay/LottieMoment.tsx
    src/pages/Login.tsx Metrics.tsx SceneLab.tsx
```

**두 창 시연**: 토큰을 **sessionStorage**에 저장한다. 같은 브라우저의 두 창에서 다른 사용자로 로그인할 수 있다.

## 4. 데이터 모델 (SQLite)

- `users(id, name, color, kind 'person'|'seed')`
- `sessions(token, user_id)`
- `agents(id, owner_id, name, persona_public, variant)`
- `room_agents(id, room_id, name)`: Our Room 전용
- `rooms(id, kind 'my'|'our'|'dm', owner_id NULL, title, theme 'studio'|'lounge'|'cafe', theme_variant NULL|'home'|'meeting')`
- `room_members(room_id, user_id)`
- `visits(id, host_room_id, visitor_kind, visitor_user_id, visitor_agent_id, status requested|active|ended|declined, permissions_json, mandate_json, start_seq, end_seq, requested_in_dm_room_id)`
- `events(room_id, seq, ts, actor_kind human|agent|room_agent|system, actor_id, type, payload_json, visibility 'room'|'private:<userId>', turn_id)`, PK `(room_id, seq)`
- `board_cards(room_id, card_id, title, body, owner_tag 'user:<id>'|'agent:<id>'|'ours', version, agreed)`
- `approvals(id, room_id, kind edit|decision|visit|takeout, requested_by, payload_json, status, created_at)`
- `approval_votes(approval_id, user_id, decision approve|edit|reject, edited_json)`
- `memory_items(id, ns, kind fact|preference|agreement|summary, text, source_room_id, source_seqs, created_by, status, created_at)`
- `room_summaries(room_id, upto_seq, text)`
- `read_cursors(user_id, room_id, last_seen_seq, left_at_seq)`

## 5. 이벤트 타입 · API · 실시간 채널

**영속 이벤트** (`packages/shared/src/events.ts`, zod discriminated union)
- **Room / 구성원**: `room_created`, `member_entered{userId, role owner|member|visitor}`, `member_left{userId, implicit, mandate?}`, `member_rejoined{userId, missedCount}`, `digest_viewed{userId}`
- **방문**:
  - `visit_requested{visitId, visitorKind}` (DM과 호스트 Room 양쪽에 기록)
  - `visit_accepted{visitId, permissions}`, `visit_declined`
  - `agent_departed{agentId, visitId, toRoomId}`, `agent_arrived{agentId, visitId, fromRoomId}`
  - `visit_takeout{visitId, text}` (호스트 Room에 공개)
  - `visit_ended{visitId, reason}`
  - `agent_returned{agentId, visitId}`, `visit_report{visitId, summary}` (출발 Room, private:소유자)
- **내용**: `message{text, to?, memoryRefs?, recipients?, replyTo?}`(`recipients`: A2A 질문의 수신 Agent 1~3개, `replyTo`: 답·정리가 잇는 질문 seq. 둘 다 Agent만 쓸 수 있고 사람이 보내면 403 `agent_only_field`), `card_created`, `card_updated{cardId, patch, version}`, `comment_added{cardId, text}`, `card_pointed{cardId, toAgentId}`
- **Agent**:
  - `agent_turn_started{agentId, turnId, trigger{seq, reason}}`
  - `agent_step{agentId, turnId, kind reading|recalling|drafting|talking, target?}` (턴당 최대 3개)
  - `agent_turn_ended{agentId, turnId, result acted|pass|error, passReason?}`
  - `agent_paused{agentId, reason chain_limit|budget|visit_turn_limit}`
- **승인**: `approval_requested{approvalId, approvers[], kind, summary, publicRationale}`, `approval_voted`, `approval_resolved{approvalId, outcome}`
- **보드 도구**: `board_tool_created{toolId, title, ownerTag, init}`, `board_tool_updated{toolId, op}`(op는 `title_set`, `ladder_set`, `ladder_run{seed}`, `ladder_reset`, `expense_add/remove`, `trip_item_add/remove`, `check_add/set/remove`, 자유형 `block_add/remove`, `block_check_add/set/remove`, `vote_option_add/remove`, `vote_cast`, `counter_add`), `board_tool_removed{toolId}`. 도구는 카드가 아니라 별도 엔티티(`RoomState.boardTools`)이며 투영 테이블 없이 이벤트 리듀싱으로 만든다. 가시성은 항상 `room`.
- **합의**: `agreement_formed{cardId, memberIds}`
- **메모리**: `memory_retained{itemId, ns, kind}` (ns가 private이면 가시성도 private:소유자)

**휘발성 메시지**: `activity{agentId, turnId, text, tokensPerSec}`, `cursor{userId, x, y, z, roomId|null}`(20Hz), `presence{roomId, userIds}`

**REST** (Bearer 토큰)
- 세션·사용자: `POST /api/login{name}`, `GET /api/me`, `GET /api/users`
- 월드: `GET /api/world` (Room 목록, 테마, 미리보기: 안 읽은 수, 부재 중 변화 수, Agent 상태, 대기 중인 승인 수, 조명 단계, 유리 투명도)
- Room 조회: `GET /api/rooms/:id/snapshot`
- Room 쓰기: `POST /api/rooms/:id/messages{text,to?,clientId}`, `POST .../cards`, `PATCH .../cards/:cardId`, `POST .../comments`, `POST .../point{cardId, agentId}`, `POST .../leave{mandate}`, `POST .../rejoin`, `POST .../seen{seq}`
- 방문: `POST /api/rooms/:id/visits{kind:'human'}`, `POST /api/rooms/:id/visits/agent{mandate}`, `POST /api/visits/:id/accept{permissions}`, `POST /api/visits/:id/decline`, `POST /api/visits/:id/end`
- 보드 도구: `POST /api/rooms/:id/tools{title, init}`, `POST /api/rooms/:id/tools/:toolId/ops{op}`, `DELETE /api/rooms/:id/tools/:toolId`
- 승인: `GET /api/approvals?mine=pending`, `POST /api/approvals/:id/vote{decision, edited?}`
- 메모리: `GET/POST/DELETE /api/memory`, `GET /api/rooms/:id/memory`
- 지표: `GET /api/metrics`

**WS** `/ws?token=`
- 클라이언트 → 서버: `subscribe{roomId}`, `unsubscribe`, `cursor`, `subscribe_world`
- 서버 → 클라이언트: `event`, `ack{clientId, seq}`, `activity`, `cursor`, `presence`, `world_preview`
- 가시성 필터는 hub에서 구독자별로 적용한다.

**가시성 규칙** (`canSee`)
- `private:X` → X만 본다.
- `room` 이벤트:
  - my Room: 소유자는 전부 본다. 방문자는 자기 방문의 `start_seq` 이상, 방문이 active인 동안만 본다.
  - our/dm Room: 구성원이 본다.
- `world_preview`도 같은 규칙을 따른다. 남의 캡슐에 대해서는 이름, 테마, 조명 단계만 내려보내고 내용 요약은 보내지 않는다.

## 6. Agent 런타임

**Agent 종류**
- Personal Agent: 사람마다 1개.
- Room Agent: Our Room마다 1개. 중립 조율자로서 요약하고, 충돌을 선택지로 정리하고, 합의 카드를 정리한다. 지목되면 답하고, 결정하지 않는다.

**트리거 규칙** (`scheduler.ts`. 결정적 규칙이며 LLM으로 발언자를 고르지 않는다)
1. **사람 이벤트**(message, card 계열, point)가 오면 `chainCount`를 0으로 되돌리고 paused를 해제한다. 대상은 다음 순서로 고른다.
   - `to`나 `point`로 지정된 Agent
   - my Room에서 작성자가 소유자 → 소유자의 Agent
   - 방문자의 메시지이고 소유자가 부재 → 호스트 Agent
   - Our Room: 작성자의 Agent는 부르지 않는다. `AGENT_AUTO_REPLY`(기본 on)가 켜져 있으면 사람이 보낸 모든 메시지가 Room Agent를 깨운다(짧게 반응하고 정말 할 말이 없을 때만 pass). 꺼져 있으면 이전 규칙(질문, "정리", 부재 구성원 언급일 때만).
   - Our Room 자동 대리(`reason: auto_reply`): 지금 Room에 present가 아니고 명시적 Leave도 하지 않은 구성원(한 번도 입장하지 않았거나 암묵적 퇴장만 한 사람, 시드 사용자 포함)의 Personal Agent를 깨운다. (a) 이름이 언급됐거나 `to`로 지정된 구성원이 있으면 그 부재 구성원 전원(Room Agent는 깨우지 않음, 단 "룸 에이전트"·"room agent"·"@room"으로 명시 호출하면 함께). (b) 지목이 없으면 Room Agent + 부재 구성원을 구성원 순서대로 **최대 2명**(`AUTO_REPLY_MAX_AGENTS`), 질문·제안이 아닌 잡담도 포함한다. 단 문자·숫자 2개 이하의 반응("ㅇㅇ", "ㅋㅋ")에는 Personal Agent를 깨우지 않는다. 사람 메시지 1건당 각 Agent는 최대 1턴이고 Agent의 `say`(to 없음)는 다른 Agent를 깨우지 않으므로 연쇄는 생기지 않는다(`AGENT_CHAIN_LIMIT`·`MAX_TURNS_PER_ROOM_HOUR`도 그대로). 지정된 구성원이 present면 본인이 답하고 아무도 깨우지 않으며, 위임 없이 Leave했으면 아무도 대신 답하지 않는다.
   - 시드 사용자(엄마·Dana) 턴은 프롬프트에 `[인물 대리 응답]`이 붙고 도구는 `say`·`pass`뿐이다(persona 말투 우선). Bob 같은 로그인 사용자는 일정 등 소유자 결정은 `request_approval`로 넘긴다.
   - 자동 대리 턴은 representing 모드이고 위임은 보수적 기본값(대화만, 소유자가 정할 일은 `request_approval`)이다. 도구는 `say`·`request_approval`·`pass`로 제한하고 기억은 기존 Our Room 범위(그 Room·for-room ns)만 쓰므로 가시성·권한을 넓히지 않는다. 구성원이 다시 접속(present)하면 대기 중인 자동 대리 작업도 버려 즉시 멈추고, 그 사이 쌓인 승인은 기존 승인함·Rejoin 다이제스트로 보인다. 접속 중인 구성원의 Agent는 지정됐을 때만 말한다. My Room·DM은 바뀌지 않는다.
2. **A2A(Agent↔Agent, `AGENT_A2A` 기본 on)**: Agent가 `ask_agents{agent_ids, question}`로 보낸 질문(`message.recipients`)은 수신 Agent마다 `a2a_ask` 턴을 1회 준다.
   - 대상은 Our Room에서 지금 present가 아닌 구성원(자동 대리 또는 위임 Leave)의 Personal Agent뿐이다. Room Agent·방문 중인 Agent·질문자 소유자의 Agent는 제외한다. 대기 중이던 같은 Agent의 `auto_reply` job은 이 턴으로 제자리 교체한다.
   - `a2a_ask` 턴은 보수적 위임이다. 도구는 `say`·`request_approval`·`pass`뿐이고(시드 소유자는 `say`·`pass`), 서버가 `to`=질문자, `replyTo`=질문 seq를 강제한다. 답(`replyTo`가 있는 message)은 아무도 깨우지 않는다.
   - fan-in: 수신자 전원이 끝나면(버려진 job 포함) 질문자에게 `a2a_collect` 턴을 1회 준다.
   - `ask_agents`는 `room_agent_call`, `addressed`(Personal Agent), `a2a_collect` 턴에서 라운드가 남았을 때만 노출한다. `allowedTools`에는 들어 있지 않다.
   - 한도: 에피소드(사람 content 이벤트마다 리셋)당 1라운드(`A2A_MAX_ROUNDS`), 팬아웃 3(`A2A_FANOUT_MAX`), a2a 턴 6(`A2A_MAX_TURNS_PER_EPISODE`, 초과 시 `agent_paused` `chain_limit`). a2a 턴은 `chainCount`를 올리지 않는다.
   - **상호작용 8종 분류**(`shared/interactions.ts`의 `indexInteractions`): `h2a_direct`, `h2a_delegate`, `a2a_ask`, `a2a_answer`, `a2a_result`, `a2h_ask`, `a2h_report`, `a2h_approval`.
3. **Agent 이벤트**: `to`로 지정된 다른 Agent만 부른다. `chainCount`를 1 올리고, `AGENT_CHAIN_LIMIT`(기본 4)에 도달하면 `agent_paused`를 기록한다.
4. `agent_arrived` → 방문한 Agent에게 도착 턴을 1회 준다.
5. 방문 턴 수가 `VISIT_MAX_TURNS`(기본 6)에 도달하면 `end_visit`만 허용하는 턴을 강제한다.
6. Room당 턴은 직렬 1개다. 대기열 중복은 제거하고, Agent는 자기 이벤트로 깨어나지 않는다. 시간당 상한은 `MAX_TURNS_PER_ROOM_HOUR`(60)이다.
7. **트리거 판정 직후, LLM 호출 전에 `agent_turn_started`를 동기로 append한다.**

**Claude 호출** (`claude.ts`, `runTurn.ts`)
- `messages.stream`에 tools를 넣고 `tool_choice:{type:'any'}`로 호출한다. **턴당 행동은 1개**다.
- tool_use가 여러 개면 첫 번째만 실행한다. tool_result 루프는 없다.
- `max_tokens`는 1024. 실패하면 1회 재시도하고, 그래도 실패하면 `agent_turn_ended{error}`.
- 스트리밍:
  - tool 블록이 시작되면 `agent_step{drafting}`을 기록한다.
  - 입력 JSON에서 `to`가 Agent로 확인되면 `agent_step{talking,target}`을 기록한다.
  - `say.text`, `comment.text`만 `activity`로 흘려보낸다(80ms 간격 묶음).
  - SDK의 partial JSON 이벤트 이름은 설치 버전 문서로 확인한다(미검증).
- `AGENT_MODE=mock`이면 `mock.ts`가 결정적 응답을 낸다.
  - 예: `@`로 불리면 `say`, 문장에 "확정"이 있으면 `request_approval`, 도착하면 인사.

**도구** (권한으로 걸러서 쓸 수 없는 도구는 주지 않는다)
- 공통 필드: `public_rationale?`, `owner_note?`(private:소유자), `used_memory_ids?`

| 도구 | 사용 주체 / 비고 |
|---|---|
| `say{text, to?}` | 모두 |
| `comment{card_id, text}` | 모두 |
| `propose_edit{card_id?, title?, body?}` | 모두 |
| `edit_board{op, card_id?, title?, body?}` | 동행 중인 My Room 소유자 Agent만 |
| `request_approval{question, options[2-4]}` | 모두. 승인자는 서버가 정한다 |
| `remember{text, kind}` | 모두. ns는 서버가 정한다 |
| `end_visit{public_takeout, report_for_owner}` | 방문 중인 Agent만 |
| `pass{reason: not_addressed\|nothing_to_add\|waiting_for_human\|outside_mandate}` | 모두 |

**권한 강제** (`shared/permissions.ts` + `domain/actions.ts`, 두 겹)
- 역할별 capability:
  - my Room 소유자(사람): 전부.
  - 소유자 Agent 동행 중: `chat, comment, edit_board, remember`.
  - 소유자 Agent 대리 참여 중: `edit_board`를 빼고 `propose_edit`(승인자는 소유자).
  - 방문자(사람): grant ⊆ `{chat, comment, propose_edit}`.
  - 방문 Agent: grant ∩ `mandate.allowedActions`. `edit_board`와 `remember`는 없다.
  - Our Room 구성원(사람): `chat, comment, edit_board`(합의된 카드는 decision 승인을 거쳐야 수정 가능).
  - Our Room 구성원 Agent: `chat, comment, propose_edit, remember`. `propose_edit` 승인자는 소유자를 제외한 사람 구성원 1인.
  - Room Agent: `chat, comment, propose_edit, request_approval`. decision 승인자는 시드가 아닌 사람 구성원 전원.
- 보드 도구(capability `board_tools`): my Room 소유자, Our 구성원(사람), Room Agent, 소유자·구성원의 Agent(동행·대리 포함)가 가진다. 사람 방문자는 보기만 하고(`VISITOR_GRANTABLE` 불변), 방문 Agent는 금지다. 사다리 실행·다시 하기와 도구 삭제는 사람만(403 `humans_only`). Agent 도구는 `create_board_tool`(ladder/settlement/trip 생성 + 선택적 `room_message`)과 `update_board_tool`(ladder_run·ladder_reset 제외)이고, 자동 대리 턴의 도구 목록(`AUTO_REPLY_TOOLS`)에는 없다. 사다리 결과는 서버가 `crypto.randomInt`로 만든 시드만 이벤트에 저장하고 가로줄·결과는 shared 순수 함수(mulberry32)가 계산해 서버·웹·재생이 같다. 시드 도구는 `db/seedBoardTools.ts`(도구 이벤트가 없는 Room에만, 멱등).
- 자유형 도구(`kind: 'custom'`, 메모판): 블록 4종(`text`/`checklist`/`vote`/`counter`)의 선언적 조합. 스키마는 전부 `.strict()`이고 HTML·URL·스타일 필드가 없으며 웹은 고정 컴포넌트가 텍스트 노드로만 그린다. 투표 내역(`votes: userId → optionId`)과 카운터 값은 이벤트가 아니라 리듀서 상태에만 있고, 투표자는 이벤트의 actor(사람 userId)다. `vote_cast`·`counter_add`·`vote_option_remove`는 사람만(403 `humans_only`)이고 `AGENT_TOOL_OPS`에 없다. 오류 코드는 기존 체계(`item_not_found` 404 / `op_kind_mismatch` 400 / `tool_full` 409). 생성 경로는 기존 `create_board_tool`의 `kind: 'custom'`(`blocks`)이며 별도 provider를 쓰지 않는다. 시드에는 custom 도구가 없다.
- `dispatch(actorCtx, action)`가 모든 쓰기 직전에 서버 진실로 `effectiveCapabilities`를 다시 계산한다. 위반하면 403과 `agent_turn_ended{error}`.
- `to`, `card_id`, `used_memory_ids`가 실제로 존재하는지, 이번 턴에 제공된 항목의 부분집합인지 검증한다.

**프롬프트** (`context.ts`, 상한 약 9k 토큰)
- 역할 규칙(모드별: 동행/대리/방문/Our)
- `persona_public`
- mandate
- gateway가 허용한 기억 항목(최근 20개, 1.5k 토큰 이하, id 포함)
- Room 요약(600 토큰 이하)
- 보이는 이벤트 최근 30개(3k 토큰 이하)
- 보드 스냅샷(1.5k 토큰 이하)

**행동 규칙**
- **Personal Agent**
  - 동행 중: 거의 침묵한다. 불렸을 때나 소유자 기준과 충돌할 때만 말한다.
  - 대리·방문 중: mandate 안에서 코멘트, 제안, 응답을 스스로 한다.
  - 승인으로 넘길 것: 확정, mandate 밖의 일, 소유자 선호와 상충하는 타협, 돈이나 시간이 드는 약속.
  - 금지: 제공되지 않은 정보 추측, 한 턴에 2개 이상 행동.
- **Room Agent**: 편을 들지 않는다. 의견이 갈리면 선택지 2~3개로 `request_approval`.

## 7. 메모리 설계 (Hindsight 검토 포함)

| ns | 귀속 | 내용 | 쓰기 | 읽기 |
|---|---|---|---|---|
| `room:<roomId>` | Room(My/Our) | 활동 요약, 합의, 결과물 사실 | 그 Room 안의 Agent, 승인 해소 시 시스템 | 그 Room 안에서만 |
| `agent:<agentId>:private` | Personal Agent | 소유자의 개인 기억 | 소유자, 또는 My Room 단독일 때 Agent의 `remember` | My Room에 소유자와 그 Agent만 있을 때만 |
| `agent:<agentId>:for:<roomId>` | Personal Agent | 소유자가 이 Room에 공유하기로 고른 개인 기억 | 소유자(MemoryPanel에서 항목별 지정) | 그 Room 안의 그 Agent만 |
| `visit:<visitId>` | 호스트 Room | 호스트 Room 이벤트 범위(`start_seq..end_seq`)로 표현 | — | 방문 중인 Agent와 호스트 |

**방문 후 가지고 나오는 것**
- `end_visit.public_takeout`만 가지고 나온다.
- 이 텍스트는 호스트 Room에 `visit_takeout`으로 **공개 기록**된다.
- 출발 Room에는 `visit_report`로 저장되고, 소유자가 원하면 private로 승격할 수 있다.
- 방문 Agent의 프롬프트에는 개인 ns를 넣지 않는다. `persona_public`, mandate, 방문 범위의 이벤트만 들어간다.

**강제 지점**
- `memory/gateway.ts`의 `recallForTurn(agentId, roomId)`와 `retainFromAgent(...)`만 메모리에 접근한다.
- ns는 `allowedNamespaces` / `writableNamespace`가 서버 진실로 계산한다. 도구에 ns 파라미터는 없다.
- private ns의 조건: room.kind='my' AND 소유자 일치 AND presence가 {소유자, 그 Agent}뿐.
- `memoryIsolation.test.ts`로 확인할 것:
  - 가족 Room의 항목이 팀 Room 턴에 없다.
  - 방문자가 있을 때 private 항목이 없다.
  - 방문 Agent 프롬프트에 개인 ns가 없다.
  - 허용 밖의 `used_memory_ids`는 거부된다.

**원문과 추출의 구분**
- 원문은 `events`다.
- 추출은 `memory_items`(승인 해소 시 agreement 자동 기록, `remember`, 사람 입력)와 `room_summaries`(30이벤트마다, 그리고 Rejoin 시점에 LIGHT 모델로 갱신)다.
- **Rejoin 다이제스트** = `left_at_seq` 이후 이벤트의 LIGHT 요약 + 보드 diff + 대기 중인 승인.
- 시연 규모에서는 최근순과 키워드로 충분하다. 벡터 검색은 넣지 않는다.

**Hindsight 판단: 1차는 채택하지 않는다.** S20에 `MEMORY_BACKEND=hindsight` 어댑터를 선택 단계로 둔다.
- 맞는 점: MIT. bank 격리가 ns와 1:1로 매핑된다. Anthropic 지원. npm 클라이언트가 있다.
- 맞지 않는 점
  - Docker나 Python 프로세스가 추가로 필요하다.
  - 기본 임베딩이 영어 중심이라 한국어 품질이 떨어질 수 있고(추정), HuggingFace 다운로드가 사내망에서 막힐 수 있다.
  - retain마다 LLM 비용이 든다.
  - 시연 규모에서는 이점이 작다.
- `MemoryStore`(`retain`, `recall(nsList, query, tokenBudget)`, `list`)를 Hindsight 연산 모양으로 맞춰 둔다.
- 다른 후보(미검증): Mem0는 벡터 DB가 필요하고, Zep/Graphiti는 그래프 DB가 필요하며, Letta는 런타임을 대체하므로 과하다.

## 8. 화면: 메신저 진입 · 해변의 캡슐 월드 · Agent · swarm · 피드백

### 8.1 메신저 구현: (a) 직접 구현
- 기존 이벤트 로그와 WS 위에 만든다. dm Room에는 3D와 Agent가 없다.
- 오픈소스 백엔드(Matrix, Rocket.Chat, Tinode)는 별도 서버와 DB가 필요하고 Agent가 봇 수준으로만 들어간다. 과하다.
- chatscope(MIT)는 레이아웃 참고만 한다. 커스텀 요소가 대부분이고 테마가 충돌한다.
- WorkAdventure(AGPL + Commons Clause, 2D 타일맵)는 동선 참고만 한다.
- 통째로 쓸 만한 것은 없다.

### 8.2 진입 흐름 (데스크톱 3단)
- **좌측**: 나(아바타), My Room 카드, "우리"(우리 가족 / 친구들 / 팀), "사람"(DM).
- **가운데**: 대화창.
- **우측**: Room 미리보기.
  - 해당 캡슐을 클로즈업한 정적 렌더
  - "내가 없는 동안 변화 N건"
  - Agent 상태 칩, 대기 중인 승인 배지, [들어가기]
- **대화와 Room 피드의 관계**
  - Our Room: 메신저 채팅 = 그 Room의 이벤트 스트림이다.
  - DM: 별개의 dm Room이다. 방문 요청과 수락은 DM 카드로 오간다. DM 헤더에 [방문 요청] [내 Agent 보내기]가 있다.
- **메신저 → 3D 전환**
  - `WorldCanvas`는 메신저 뒤에 흐리게 깔린 해변 조감 뷰다.
  - [들어가기]를 누르면 미리보기 카드가 FLIP으로 사라지고, 카드 위치에서 입자가 버스트한다.
  - 카메라가 해당 캡슐로 1.4초 비행한다.
  - 캡슐 **가운데 마디(두 이음매 사이)가 위로 미끄러져 열린다.**
  - 카메라가 안으로 들어가면 유리 불투명도를 0으로 페이드한다.
  - 메신저 패널은 Room 사이드 패널로 접힌다.
  - 나오기는 역재생이다.

### 8.3 나 / 너 / 우리: 해변 위의 유리 캡슐
- **색**
  - 사람마다 고유 색: Alice 코랄, Bob 스카이, 시드 사용자는 각자의 색. 민트와 오렌지는 예약 색이다.
  - **우리 색** = 구성원 색을 oklch로 혼합한 값. 경계와 장식은 구성원 색의 그라데이션 링으로 그린다.
  - 민트는 Room Agent와 시스템 전용, **오렌지는 승인 전용**이다.
- **월드**
  - 해 질 녘 해변이다. 원경(바다, 하늘, 도시)은 HDRI 배경을 흐리게 해서 쓰고, 근경은 모래 바닥 평면이다.
  - 낮고 따뜻한 태양광이 유리 하이라이트와 긴 그림자를 만든다.
  - TiltShift2로 미니어처 접사 느낌을 준다. 초점 띠는 현재 대상 캡슐을 따라간다.
- **캡슐 = Room 하나**
  - 공통 셸: 가로로 누운 알약형(CapsuleGeometry를 회전), 세로 이음매 링 2개, 원목 받침 트레이, 벽 간판(`RoomSign`). 유리 치수(radius/length/floor)는 종류와 무관하게 고정이라 실내 배치가 그대로다.
  - **종류는 형태로 구분한다**(색 없이도 갈린다).
    - My와 Your 캡슐은 길쭉한 알약에 소유자 **단색** 띠 받침이다. 내 방은 투명, 남의 방은 서리 유리에 뒷줄 배치라 닫힌 느낌을 낸다.
    - Our 캡슐은 통통하고(약 1.6배), 받침이 유리보다 0.6 넓은 **마루(porch)**다(바닥 면적 약 2.6배). 띠는 **구성원 색 줄무늬**(폭 0.5마다 순환), 마루 앞에 **구성원 수만큼 색 구슬**(최대 6)이 놓인다. 이음매 링은 구성원 색 그라데이션을 유지한다.
    - 간판과 조망 이름표 칩도 1인(소유자 실루엣) / 여럿(겹친 색 점 + 인원 수)으로 구분한다. 사람 방과 Agent 방 표식은 캐릭터 칩의 시각 언어(사람 = 둥근 칩, Agent = 각진 태그)를 따른다.
- **배치** (`world/layout.ts`, viewer 중심)
  - 3행이다: 내 캡슐(z=12, 카메라 바로 앞 중앙), Our 캡슐들(z=-4), 상대 캡슐들(z=-20). 행 안에서는 x로 펼치고 가장자리는 약간 뒤로 휜다(z -= 0.08|x|).
  - Our 순서는 완전탐색(최대 6개)으로 정한다: 2층 교차 수 최소 -> 연결 길이 합 최소 -> 원래 순서 선호. 상대 캡슐 x는 연결된 Our x의 평균에 순서를 지키는 최소 간격(`spreadMinGap`)으로 놓는다.
  - **Bob 창에서는 Bob의 캡슐이 앞 중앙**이고, 라벨은 `perspective.ts`로 "My Room / Alice의 Room"이 반대로 붙는다.
- **연결: 유리 튜브 통로** (`GlassTube`, 경로는 `world/routing.ts`의 `routeTubes` 하나에서만 나온다)
  - 내 캡슐과 내가 속한 Our 캡슐, 그리고 Our 캡슐과 다른 구성원 캡슐을 튜브로 잇는다.
  - **포트 규칙**: 포트는 받침 벽 스타디움 둘레의 1차원 좌표로 배정한다. 상대 쪽을 향한 최근접점에 두고 최소 간격(1.3)으로 펼치며, 앞면 간판 구역은 금지한다. 그래서 끝단에서 U턴하는 고리가 없다.
  - **교차는 아치**: 서로 교차하는 관 한 쌍은 한쪽이 높이 1.1의 아치로 넘어간다(내 방에서 나온 관은 아래로 둔다). 다른 캡슐은 우회점으로 피한다. 이동 연출(TripOrb)도 같은 곡선(아치 포함)을 따른다.
  - 튜브 안쪽 바닥은 출발 쪽 색에서 도착 쪽 색으로 그라데이션된다. 그래서 "내 영역에서 우리 영역, 다시 상대 영역으로 넘어간다"가 보인다.
  - **Our 캡슐은 "내 유리와 네 유리가 만나 생긴 공간"**으로 읽히도록 만든다: 튜브가 모이는 위치, 유리 테두리의 구성원 색 그라데이션 링.
- **유리 = 경계** (소유, 권한, 기억이 1:1로 대응. `perspective.glassClarity`)
  - 내 캡슐, 그리고 내가 구성원인 Our 캡슐: **투명**.
  - 남의 캡슐: **서리 유리**(roughness 높음). 실내 조명과 실루엣만 보이고 간판은 읽힌다.
  - 내가 한 **사람 방문**이 수락돼 활성이면: 그 캡슐이 나에게 투명해진다(`clear`, 1.8초 와이프 전환).
  - 내 **Agent 방문**이 수락돼 활성이면: 그 캡슐의 서리도 걷히지만 **완전 투명이 아니라 "agent 시야"(`agent`)**다. 옅은 서리가 남고(서리 0.58), 내 색(뷰어 색)의 림 빛이 천천히 숨 쉬며, 캡슐 라벨 칩에 "Agent 방문 중" 표식이 붙는다. 실내(조명·소품)는 읽히되 사람 방문의 clear와 한눈에 구분된다. 걷힘·다시 낌은 사람 방문과 같은 와이프를 쓴다. 사람 방문과 Agent 방문이 겹치면 clear가 이긴다.
  - 두 경우 모두 방문이 끝나면 다시 서리가 낀다. 호스트 쪽 화면은 원래 clear라 변화가 없다(와이프도 없다). 제3자는 계속 서리.
  - 미리보기 `detail`(안 읽은 수, 승인 수 등)은 clear든 agent든 남의 캡슐에 내려가지 않는다. agent 시야가 새로 노출하는 서버 필드는 없다(`glass` 값만 다르다).
  - **위임 범위 표시**: Agent 방문의 위임 문구(`visit_requested.mandate`)는 호스트와 방문 Agent 소유자에게 보인다. 일반 메시지·카드와 구분되는 전용 블록("위임 범위" 태그, 점선 테두리, 소유자 색 포인트, "OO님이 Agent에게 맡긴 범위예요" / 소유자에게는 "내가 맡긴 범위예요")으로 방문 요청 카드와 Room의 Agent 상태 목록에 같은 컴포넌트로 표시한다.
  - 대기 중인 승인이 있으면 유리 테두리에 오렌지 반짝임이 생긴다.
- **조명 단계** (`roomState.roomAmbience` → `InteriorLights`)

| 단계 | 조건 | 표현 |
|---|---|---|
| `occupied` | 사람이 있음 | 전구와 스탠드 100%, 따뜻한 2700K |
| `agentOnly` | 사람 없이 Agent만 있음(대리 참여) | 조도 40%, 가장 가까운 등이 Agent 색으로 은은하게 |
| `empty` | 아무도 없음 | 꺼짐, 노을 반사만 |
| `attention` | 승인 대기 | 단계에 오렌지 보조광 추가 |

  - Agent가 drafting 중이면 보드 옆 등이 토큰 속도에 맞춰 미세하게 맥동한다.
- **소유 표시**
  - 카드: `owner_tag` 색 테두리. 우리 카드는 그라데이션과 "우리" 아이콘, 합의된 카드는 금빛 핀.
  - 실내 벽면 액자 = 보드 카드.
  - **기억 선반**: 실내 선반의 빛나는 유리병 = 메모리 항목. 내 private은 나에게만 보인다. `for:room`은 내 색 병, `room`은 Room 색 병이다.
  - Agent 발화의 출처 칩(`used_memory_ids`): 예 "내 기억 · 우리 가족에만 공유".
- **Our에 속하는 것**: Our Room 보드의 카드, `agreement`, Room 요약, Room Agent. 개인 Agent와 개인 기억은 Our Room 안에 있어도 각자의 것이다.

### 8.4 Agent 디자인 (에셋 기준)
- **Personal Agent = 알형 패밀리**
  - 몸통은 `body-blue.png`를 소유자 색으로 틴트한다.
  - 변종(베레모, `</>`, 고글)은 메신저 아바타에서 144px로 쓰고, 3D에서는 1차로 장식을 생략한다.
- **Room Agent = 유령형 패밀리**
  - `body-lime.png`와 47장 yaw 아틀라스로 대상 방향으로 몸을 돌린다.
  - 민트·라임 고정색이다.
  - 원 데모의 PM Agent → Room Agent 매핑(추론).
- **크기**: 캡슐 실내 스케일에 맞춰 의자 높이 정도의 미니어처다.
- **3D 표현 방식**
  - Y축만 회전하는 빌보드 + `spriteMaterial`: 틴트, 탈색, 밑단 물결, 림 글로우.
  - 얼굴은 별도 레이어(`faceTexture`): near/far eye 오프셋, 깜빡임, **입 벌림 ∝ tokensPerSec**.
  - 절차적 모션: 부유, squash/stretch, 기울기, 점프.
  - 소유자 연결: 바닥 링 색 = 소유자 색, 동행 중이면 빛의 끈.
- **사람 아바타**: 무광의 말(pawn) 형태 미니어처, 바닥 링에 소유자 색.
- **Lottie** (DOM 오버레이 전용): `lime-notify`는 승인 토스트, `duo-highfive`는 합의, `lime-jump-yaw`는 모든 승인 완료.
- **에셋으로 덮이지 않는 상태와 보완 수단**
  - 승인 대기: 오렌지 결정 + 오렌지 보조광.
  - 대리 참여: 소유자 좌석, 후광, 입자로 된 소유자 실루엣, `agentOnly` 조명.
  - 이동: 입자로 분해되고 유리를 통과한다.
  - paused: 탈색되고 입자가 가라앉는다.

### 8.5 상태 머신 ↔ 이벤트 ↔ 3D (`shared/agentState.ts`, 1:1)
- `AgentVisualState = {activity, mode, location, target, handoverPending}`
- mode는 `accompanied | representing | visiting | traveling`.

| 이벤트 | 상태 | 캐릭터 | swarm / 캡슐 |
|---|---|---|---|
| (기본) | idle | 부유, 깜빡임 | 느슨한 궤도. 캡슐 안에 머묾 |
| 다른 행위자의 room 이벤트 | idle + lookAt | 그쪽을 봄 | 그쪽으로 쏠림 |
| `agent_turn_started` | thinking | 미세 진동, 눈을 가늘게 | 머리 위 응집 소용돌이 |
| `agent_step{recalling}` | thinking | 동일 | 기억 선반의 병에서 입자가 빨려 나옴 |
| `agent_step{drafting}` | drafting | 보드 쪽으로 기울고 입이 움직임 | 벽 액자(카드)로 쏟아짐, 보드 옆 등 맥동 |
| `agent_step{talking,target}` | talking | 대상 쪽으로 회전 | 두 Agent 사이의 띠 |
| `approval_requested` | awaiting | 승인자 좌석을 봄 | 오렌지로 응결, 유리 테두리 오렌지 반짝임 |
| `agent_turn_ended{pass}` | idle | 끄덕임 | 수축 |
| `agent_paused` | paused | 탈색 | 가라앉음 |
| `member_left`(소유자) | representing | 소유자 좌석으로 이동 | 소유자 실루엣, 조명 `agentOnly` |
| `agent_departed` | traveling | 문 쪽으로 감 | 무리로 분해 → **내 캡슐 유리를 통과(파문)** → 튜브를 따라 흐름 |
| `agent_arrived` | visiting | 호스트 캡슐 안 문 앞에서 재조립 | **호스트 유리를 통과(파문)**, 방문 배지(점선 링) |
| `visit_takeout` | visiting | 작은 카드를 품에 안음 | — |
| `agent_returned` + `visit_report` | handoverPending | 카드 묶음을 내밂 | 역방향 유리 통과 |
| `member_rejoined`(missed>0) | handoverPending | 동일 | 소유자에게 흘러 들어감, 조명 `occupied`로 점등 |
| `digest_viewed` | 인계 해제 | 점프 | 해소 링 |
| `agreement_formed` | (Our) | 구성원 Agent와 Room Agent가 모여 점프 + 하이파이브 Lottie | 양쪽 색 무리가 카드로 모여 우리 색으로 섞임. 전구가 차례로 켜지고 유리 테두리 그라데이션이 한 바퀴 돎 |

- `tokensPerSec`는 상태를 바꾸지 않는다. 입, 밀도, 등 맥동의 강도만 조절한다.
- **타임라인 재생**: `replaySeq`까지 리듀싱한 결과가 3D(조명 단계와 유리 투명도 포함)로 그대로 재생된다. 재생 중에는 휘발성 효과를 끈다.

### 8.6 swarm과 유리 렌더링
- **해석**: 커서를 따라 무리 짓는 입자(boids)로 진행한다. 확신은 중간이다.
- **시뮬레이션** (`swarmSim.ts`)
  - GPUComputationRenderer로 위치·속도 텍스처를 만들고, 입자마다 그룹 id를 둔다(최대 12개: 사람별 ambient, Agent별, Room Agent).
  - 그룹별 uniform: 목표, 모드(orbit/cohere/vortex/flow/condense/scatter/settle), 강도, 색, **소속 캡슐 id**.
  - **캡슐 SDF 제약**: 캡슐 소속 그룹은 그 캡슐 안에 머문다. 이동 모드에서만 제약을 풀고, 유리를 통과하는 지점에 `GlassRipple` 이벤트를 낸다.
  - 커서 ambient 무리는 캡슐 밖(해변)이나, 캡슐에 들어가 있으면 그 캡슐 안을 따라다닌다.
  - 힘: 목표 유도 + curl noise + 분리 + 커서 인력·척력 + 회피 구(얼굴과 라벨).
  - 렌더: Points, additive blending.
- **커서**
  - 바닥이나 캡슐 바닥에 레이캐스트해 내 색 무리가 따라온다.
  - 같은 Room이나 같은 월드에 있는 상대의 커서 무리도 보인다(WS `cursor`).
- **유리 렌더** (`GlassMaterial.tsx`)
  - **월드 전체에서 `MeshTransmissionMaterial`이 하나의 공유 버퍼(drei 공유 버퍼 패턴)를 쓴다.** 투과 패스는 프레임당 1회다.
  - `backside=false`.
  - 초점 캡슐과 화면 안의 가까운 캡슐 2개까지만 투과 유리를 쓰고, 나머지와 튜브는 가짜 유리(`MeshPhysicalMaterial` transparent + envMap 반사 + 프레넬 림)를 쓴다.
  - 서리 효과는 roughness로 낸다.
  - 파문은 `GlassRipple`이 통과 지점과 시각을 uniform으로 넘기고, 셰이더가 노멀을 교란해 굴절 링을 만든다.
- **품질 단계** (`quality.ts`, drei `PerformanceMonitor`로 자동 하향. `?q=`로 강제 가능)

| 단계 | 입자 | 유리 | 후처리 | 기타 |
|---|---|---|---|---|
| high | 65,536(256²) | 투과 3개, resolution 512, samples 6 | Bloom, TiltShift2, AGX, Vignette, N8AO | 실내 PointLight 4 |
| mid(시작값) | 16,384(128²) | 투과 1개(초점), resolution 256, samples 3 | Bloom, TiltShift2, AGX | PointLight 2 |
| low | 4,096(64²) | 전부 가짜 유리 | AGX만 | PointLight 0(emissive만), dpr 1 |

  - mid에서 60fps가 2초 유지되면 high로 올린다.
  - float 렌더 타깃을 지원하지 않으면 CPU InstancedMesh 1,000개로 폴백한다.
  - 그림자는 정적으로 베이크하고, 이후 캡슐 상태가 바뀌어도 다시 굽지 않는다.
  - 실내 소품은 glb를 최적화하고 인스턴싱한다(같은 소품 재사용).
- **R3F 유지**: WebGPU 경로(v10 알파)는 1차에서 쓰지 않는다.

### 8.7 반응성과 인과 연출

| 입력 | 즉시 반응(3D, 다음 프레임) | 즉시 반응(2D) | 서버 확정 후 |
|---|---|---|---|
| 캡슐 호버(조감) | 캡슐이 스프링으로 0.05 떠오름, 유리 프레넬 림 밝아짐, 실내 조명 +20%, 간판 발광, 내 무리가 캡슐 주위로 모임 | 이름, 상태, 변화 수 툴팁 | — |
| 캡슐 클릭 | 가운데 마디 열림 → 카메라 진입(8.2) | 미리보기 패널이 Room 패널로 바뀜 | snapshot 수신 |
| 호버(Agent·사람·카드) | 스케일 1.08, 림 밝아짐, 무리가 모임 | 툴팁, 피드 하이라이트 | — |
| 클릭(Agent) | 눌림, 카메라 미세 접근 | Agent 패널 | — |
| 드래그(빈 공간) | 제한 회전 ±25°, 무리 관성 | — | — |
| 드래그(카드 → Agent) | 카드 사본이 따라가다 Agent로 날아감 | "보여 줌" | `card_pointed` → turn_started |
| 메시지 전송 | 내 좌석에서 수신자로 빛 투사체 | 말풍선이 "보냄"(테두리만) | ack 시 채워짐 |
| Agent 호출 | 투사체 + "!" 펄스 | "부름" | thinking 소용돌이(150ms 이내) |
| 방문 요청 | 내 캡슐에서 상대 캡슐로 튜브를 따라 신호 입자 | DM "요청 중…" | 상대 창: DM 카드 등장, 그 사람의 캡슐 유리가 깜빡임 |
| 방문 수락 | 튜브가 밝아지고 상대 캡슐 유리 서리가 걷힘 | "수락됨" | 요청자 창: [들어가기] 맥동 |
| Agent 보내기 | Agent가 문으로 감 | "출발 중" | departed / arrived 연출 |
| 승인 / 수정 / 거절 | 결정이 터짐 / 녹아서 바뀜 / 흩어짐, Agent 반응, 유리의 오렌지 반짝임 해제 | 결과 칩 | 적용 연출 |

**지연 예산**
- 로컬 피드백 16ms 이내, ack 100ms 이내, turn_started 150ms 이내.
- Claude 첫 토큰까지의 빈 시간은 thinking 연출과 "생각 중 · 사유"가 채운다. 이후는 스트리밍이 연속 피드백이 된다.
- 실패하면 무리가 흩어지고 "다시 시도" 버튼이 뜬다.

**인과 궤적**
- 모든 연출은 `fxStore.emit({kind, from, to, priority, color})`를 거친다.
- 로컬의 낙관적 입력과 원격 이벤트가 같은 emit을 쓴다. `clientId`로 중복 재생을 막는다.
- 캡슐 사이를 오가는 연출은 반드시 해당 튜브 경로를 따라간다.

**과함 방지**
- 우선순위는 L1 승인 > L2 Agent 행동 > L3 분위기·커서다.
  - L1이 활성이면 L3를 30%로 낮추고 블룸을 낮추며, 카메라는 승인자 쪽으로 미세 이동한다.
  - L2는 동시 2개까지, 250ms 간격으로 순차 재생하고, 이때 L3는 50%로 낮춘다.
- 카메라 미세 이동은 내가 대상이거나 내가 일으킨 행동일 때만 한다.
- 가독성 규칙:
  - 라벨과 승인은 DOM(drei `Html`)으로 그리므로 블룸, 입자, 유리 굴절에 덮이지 않는다.
  - 유리 반사 강도는 실내 인물이 읽히는 수준으로 제한한다(초점 캡슐의 envMapIntensity 상한).
  - 회피 구, `AgentStatusList`(aria-live), `prefers-reduced-motion`을 지킨다.

**수동 검증 체크리스트**
1. 두 창에서 한쪽이 보낸 메시지의 투사체가 다른 창에서도 1초 안에 보인다.
2. Agent를 부르면 0.2초 안에 thinking이 시작된다.
3. 승인이 대기 중이면 분위기 연출이 줄고, 결정과 유리의 오렌지 반짝임이 보인다.
4. 무리, 유리 반사, 굴절이 얼굴과 라벨을 가리지 않는다.
5. 내장 그래픽 노트북에서 low/mid 단계로 30fps 이상이 나온다.
6. 상대 커서 무리가 보인다.
7. Bob 창의 월드가 Alice 창과 대칭이다(앞 중앙 캡슐과 라벨이 반대).
8. 타임라인을 되감으면 3D, 조명, 유리 상태가 과거로 돌아간다.
9. 방문을 수락하면 상대 캡슐의 서리가 걷히고, 종료하면 다시 낀다.
10. Agent가 유리를 통과할 때 파문이 보인다.

## 9. 구현 단계 (implementer 1회분씩, 순서대로)

| # | 내용 (주요 파일) | 완료 확인 |
|---|---|---|
| S0 | 모노레포 골격, Fastify `/api/health`, Vite 프록시 | `npm install && npm run dev` → `localhost:5173`에서 health OK 표시, `npm run typecheck` |
| S1 | shared: `events.ts`, `api.ts`, `permissions.ts` + 테스트 | `npm test -w packages/shared` |
| S2 | shared: `agentState.ts`, `roomState.ts`(roomAmbience 포함), `namespaces.ts`, `perspective.ts`(glassClarity 포함), `colors.ts`, `themes.ts` + 테스트 | 8.5 표 각 행, 조명 4단계, 유리 투명도 규칙, 두 시점 대칭 |
| S3 | server: db(schema, index, repo, seed: 사용자 4명, My Room 테마 studio/lounge, Our 3개 cafe(+variant), DM, 시드 이벤트와 기억), `events/store.ts`, `auth.ts`, `routes/auth.ts` | seq 단조 증가, 가시성 테스트, `npm run seed` 후 `curl /api/login` |
| S4 | `realtime/hub.ts`, `domain/actions.ts`, `domain/rooms.ts`, `routes/rooms.ts` | 403 테스트, WS 클라이언트 2개 수신, 가시성 필터 |
| S5 | web 메신저: Login, MessengerHome, Sidebar, ConversationView(MessageList, Composer), api, session/worldStore | 두 창에서 DM과 "친구들" 채팅이 실시간, 낙관적 "보냄 → 확정" |
| S6 | `domain/presence.ts`, `domain/visits.ts`, `routes/visits.ts`, VisitCards, RoomPreviewPanel | 방문 가시성 테스트, 암묵적 퇴장 30초, DM 요청·수락 |
| S7 | `memory/types.ts`, `localStore.ts`, `gateway.ts`, `routes/memory.ts`, MemoryPanel | `memoryIsolation.test.ts` 4케이스 |
| S8 | Agent 코어(mock): scheduler, runTurn, context, tools, prompts, llm, mock | 연쇄 상한, 동기 turn_started, 금지 도구 거부, private 제외 |
| S9 | `claude.ts`, `config.ts`(claude 모드에서 키가 없으면 기동 실패) | 키를 넣고 My Room 대화 스트리밍, mock 모드에서 동일 흐름 |
| S10 | `domain/approvals.ts`, `routes/approvals.ts`, Agent 방문(departed/arrived/takeout/report, 턴 상한), `memory/summarizer.ts` | mock: 보내기 → 방문 → 보고 도착, Our 결정 2인 승인 시 `agreement_formed` |
| S11 | 2D Room UI: RoomView, ActivityFeed, BoardPanel, ApprovalPanel, AgentStatusList | 3D 없이 My/Your/Our 전체 흐름 동작 |
| S12 | LeaveSheet, SendAgentSheet, TimelineScrubber, Rejoin 다이제스트, replaySeq | Leave → 진행 → Rejoin 요약·diff·승인, 피드 되감기 |
| S13 | 캐릭터 에셋 추출 `tools/extract-demo-assets.mjs`와 실행(10.1) | 파일 목록과 PNG 시그니처 검사, `/lab`에서 로드 |
| S14 | 소품·환경 에셋 가져오기: `tools/import-props.mjs`, `tools/props-manifest.json`, HDRI·모래 텍스처·폰트 배치, `CREDITS.md`(10.2) | `npm run assets:props` → `public/assets/props/*.glb` 생성, 각 파일 1MB 이하, CREDITS에 출처와 라이선스, `/lab`에서 glb 표시 |
| S15 | 해변 월드: WorldCanvas, CameraRig(원근 접사), `world/Beach.tsx`, `world/layout.ts`, `world/GlassTube.tsx`, Postfx(TiltShift2, Bloom, AGX) | 메신저 뒤 해변 조감 뷰, 두 창 대칭, 튜브 연결 |
| S16 | 캡슐: `capsule/CapsuleShell.tsx`, `GlassMaterial.tsx`(공유 버퍼, 가짜 유리, 서리), `RoomSign.tsx`, `InteriorLights.tsx`, `quality.ts` | 초점 캡슐만 투과, 서리 ↔ 투명 전환, 조명 4단계 토글(`/lab`), `?q=` 단계별 fps HUD |
| S17 | 실내 세트: `interiors/themes.tsx`, `Studio.tsx`, `Lounge.tsx`, `Cafe.tsx`(variant home/meeting), `Prop.tsx`, BoardObject(벽 액자), HumanAvatar. 진입 시 가운데 마디가 열리는 비행 | 테마 3종과 variant 2종 확인, 캡슐 진입·퇴장 |
| S18 | Agent 스프라이트: AgentSprite, spriteMaterial, faceTexture, useYawAtlas, SceneLab | `/lab`에서 상태 10종이 8.5 표대로, mock 이벤트로 구동 |
| S19 | 피드백·swarm·큰 순간: fxStore, Projectile, Tether, ApprovalCrystal, GlassRipple, swarmSim, Swarm, swarmDirector, cursor 브로드캐스트, 합의·도착·인계 연출, LottieMoment, 3D 타임라인 재생. **파일이 많으므로 S19a(fx·피드백), S19b(swarm·캡슐 SDF·파문), S19c(큰 순간·재생)로 나눠 위임한다** | 8.7 체크리스트 1~10, 데모 대본 1회 완주 |
| S20 | `routes/metrics.ts` + Metrics, README 데모 대본. (선택) `memory/hindsightStore.ts` | `/metrics` 수치. Hindsight는 Docker나 pip로 띄운 뒤 격리 테스트 재실행 |

**지표**
- Agent 초대·보내기율, Leave 실행률, 재합류율, 반복 Room 사용률, 승인·수정·거절 비율.
- 추가: 방문 수락률, takeout 생성률, 타임라인 재생 열람률, 합의 수.

## 10. 에셋 절차

### 10.1 캐릭터 에셋 추출 (S13)
- **원칙**: 입력 HTML은 신뢰할 수 없는 데이터다. 스크립트를 실행하지 않고 텍스트만 파싱한다.
- **실행**: `node tools/extract-demo-assets.mjs <html경로>` (기본 경로 없음)
- **추출 방법**
  - `<script type="application/json" id="ap-j1|ap-j2|ob-j">` 본문을 정규식으로 잘라 `JSON.parse`한다(eval 금지).
  - `assets[].p`의 base64를 디코딩한다.
  - PNG 매직 넘버 `89 50 4E 47`를 검증하고, 파일당 5MB 상한을 둔다.
  - 캐릭터 `<img>`는 `class="ar9-r"` 행들 안의 6개만 순서대로 뽑는다.
- **출력** `apps/web/public/assets/`
  - `characters/body-blue.png`, `characters/arm-blue.png`, `characters/body-lime.png`
  - `characters/yaw/lime-yaw-01..47.png`, 가능하면 `characters/lime-yaw-atlas.png`(8×6)
  - `avatars/room-halo.png`, `room-goggles.png`, `room-c.png`, `avatars/personal-beret.png`, `personal-code.png`, `personal-goggles.png`
  - `lottie/lime-notify.json`, `lime-jump-yaw.json`, `duo-highfive.json` (원문 그대로)
  - `assets-manifest.json`
- **커밋 여부**: 사용자 답(질문 2)을 받을 때까지 `public/assets/characters`, `avatars`, `lottie`는 `.gitignore`에 넣는다.

### 10.2 소품·환경 에셋 (S14)
- **추천: Kenney Furniture Kit(CC0, 확인함)를 기본**으로 하고, 없는 것은 프리미티브로 만든다.
- 근거:
  - CC0라 크레딧이 의무가 아니고 커밋해도 된다.
  - 로우폴리 미니어처 톤이 접사 룩과 맞는다.
  - 실내 3세트에 필요한 기본 가구(책상, 의자, 서랍장, 선반, 소파, 스탠드, 화분, 테이블, 스툴)를 덮는 것으로 예상한다(추정. 압축을 풀어 확인).
- **프리미티브로 만들 것**: 캡슐 셸, 받침 트레이, 이음매 링, 펜던트 전구(emissive 구 + 코드선), 조약돌, 빵·디저트(눌린 캡슐과 구), 에스프레소 머신(RoundedBox 조합), 아치 선반, 액자 = 보드 카드.
- **보조**: Quaternius(CC0, 1차 출처 미검증)는 필요할 때 페이지에서 직접 확인하고 쓴다. Poly Pizza는 모델별로 라이선스를 확인하고, CC-BY면 `CREDITS.md`에 작성자를 기록한다. 기본적으로는 쓰지 않는다.
- **절차**
  1. 사용자(또는 implementer가 사용자 승인 아래)가 kenney.nl에서 Furniture Kit zip을 내려받아 `assets-src/kenney-furniture-kit/`에 푼다. 인터넷 다운로드는 자동화하지 않는다.
  2. `tools/props-manifest.json`에 `{ "src": "<원본 상대경로>", "out": "studio-desk.glb", "theme": "studio", "license": "CC0", "source": "Kenney Furniture Kit" }` 형식으로 목록을 쓴다.
  3. `npm run assets:props` → `tools/import-props.mjs`가 처리한다.
     - 원본이 glb/gltf면 `gltf-transform optimize`(weld, dedup, meshopt, 텍스처 리사이즈 512)를 적용한다.
     - OBJ/FBX뿐이면 OBJ를 `obj2gltf`로 변환한다(미검증). FBX는 건너뛰고 경고만 낸다.
     - 결과는 `apps/web/public/assets/props/<out>`에 쓰고, 파일당 1MB 상한을 둔다.
  4. **HDRI**: Poly Haven(CC0)의 sunset HDRI 1k 또는 2k(예: venice_sunset. 해변이 아니어도 배경을 흐리게 하므로 무방하다)를 `public/assets/hdri/sunset_1k.hdr`에 둔다. drei preset의 CDN은 쓰지 않는다.
  5. **모래**: Poly Haven CC0 모래 텍스처 1k(구체 에셋은 미검증, 페이지에서 확인)를 `public/assets/textures/sand_*`에 둔다. 없으면 절차적 노이즈 셰이더로 대체한다.
  6. **폰트**: Noto Sans KR(OFL)의 간판용 서브셋을 `public/assets/fonts/`에 둔다.
  7. `CREDITS.md`에 에셋별 출처 URL, 라이선스, 내려받은 날짜를 기록한다.

## 11. 데모 시나리오 (나 → 상대 → 우리, 두 창)

0. **월드**: Alice가 로그인하면 메신저 뒤로 노을 해변이 보인다. 앞 중앙에 Alice의 작업실 캡슐(투명), 뒤로 Our 캡슐 3개(카페형), 더 뒤에 Bob의 라운지 캡슐(서리 유리)이 있고 유리 튜브로 이어져 있다. Bob 창에서는 Bob의 라운지 캡슐이 앞 중앙이다.
1. **나**
   - Alice가 자기 캡슐에 들어간다. 가운데 마디가 열리고 카메라가 진입한다.
   - 내 Agent(코랄 알형)와 "주말 아이디어" 카드 3장을 만든다. 카드가 벽 액자로 걸린다.
   - 기억 선반에 "일요일 오전 가족 행사"(공유 대상: 우리 가족만) 병이 생긴다.
2. **상대**
   - DM에서 [방문 요청]을 보내고, Bob 창에서 수락한다.
   - Alice 화면에서 Bob 캡슐의 서리가 걷힌다. 카메라가 튜브를 따라 Bob의 라운지로 들어간다.
   - Alice는 댓글만 달 수 있다(편집 비활성).
   - Alice가 나와 [내 Agent 보내기]를 한다. mandate는 "토요일 오후, 3만원, 확정은 내 승인". 그리고 Leave한다. Alice 캡슐의 조명이 `empty`로 바뀐다.
   - Alice의 Agent가 입자로 분해돼 내 캡슐 유리를 통과(파문)하고, 튜브를 지나 Bob 캡슐 유리를 통과해 재조립된다.
   - Bob의 Agent와 띠로 대화한다. takeout을 공개한 뒤 돌아간다.
3. **인계**: Alice가 돌아오면 조명이 `occupied`로 점등되고, 내 Agent가 카드 묶음을 내민다. 방문 보고를 확인한다.
4. **우리**
   - 두 사람이 "친구들" 카페 캡슐에 각자의 튜브로 들어온다.
   - 라임 Room Agent가 두 Agent의 제안을 선택지 2개로 정리하고 decision을 연다. 유리 테두리에 오렌지 반짝임이 생기고 두 창 모두에 결정이 뜬다.
   - 둘 다 승인하면 코랄과 스카이 무리가 카드로 모여 우리 색으로 섞인다. 펜던트 전구가 차례로 켜지고 테두리 그라데이션이 한 바퀴 돌며 하이파이브 Lottie가 나온다.
   - Alice가 Leave한다. 카페 조명이 `occupied`(Bob이 있음) 상태로 유지되는 가운데 Alice의 Agent가 대리 참여를 이어간다. Bob이 시간을 바꾸려 하자 승인이 Alice에게 남는다.
   - Alice가 Rejoin해 타임라인을 3D로 되감아 보고(조명과 유리 상태도 함께 되감김), 수정 후 승인한다.
5. **보드 도구**
   - "친구들"에서 "국밥 누가 쏠까? 사다리로 정하자"를 보내면 Room Agent가 탁자에 새 사다리를 올려 둔다(시드의 "오늘 커피 누가 살까?" 사다리는 실행 전 상태로 따로 있고, 같은 문장을 보내면 새로 만들지 않고 안내만 한다). 사람이 사다리 타기를 누르면 두 창에서 같은 경로와 결과가 나온다. "정산"이라는 말에는 정산표, "여행 가자"에는 여행 계획이 올라온다. "뭐 먹을지 투표하자"에는 메모판(투표 블록)이, "할 일 나누자: 장보기, 청소"에는 체크리스트 블록이 올라온다(투표는 사람이 한 표씩, Agent는 투표하지 않는다).
   - 방문자 Alice는 보기만 하고 실행 버튼이 없다. 자동 대리 응답에서는 도구를 만들지 않는다.
6. **같은 나, 다른 우리**
   - "우리 가족"(home variant)에서 "이번 주말 어때?"라고 물으면, Agent가 선반의 가족 공유 병에서 입자를 끌어와(recalling) 일요일 행사를 들어 토요일을 제안한다. 출처 칩은 "내 기억 · 우리 가족에만 공유"다.
   - "팀"(meeting variant)에서 같은 질문을 하면 그 병이 선반에 아예 없고, 가족 이야기도 나오지 않는다.

## 12. 사용자에게 물을 것

1. **Claude API 접근**: 이 PC와 사내망에서 api.anthropic.com을 직접 호출할 수 있고 키를 받을 수 있는가? 모델 ID는 무엇인가?
   - A) 가능 → `claude` 모드
   - B) 불가 → `mock` 모드로 시연
2. **캐릭터 에셋**: 데모 파일의 캐릭터를 GitHub 저장소(jovinus302/EnsembleRoom)에 커밋해도 되는가? 장식 변종의 고해상도(512px 이상) 원본이 있는가?
   - A) 커밋 가능 + 원본 제공
   - B) 로컬 추출만, 144px로 진행
3. **Hindsight**: 1차 시연에 실연동이 필요한가?
   - A) 아니다. 자체 메모리 + 인터페이스(권장)
   - B) 필요하다. Docker나 Python 설치, 임베딩 모델 선택, HuggingFace 다운로드를 허용

## 출처
- Hindsight: https://github.com/vectorize-io/hindsight , https://hindsight.vectorize.io/ , https://arxiv.org/html/2512.12818v1 , https://vectorize.io/blog/introducing-hindsight-agent-memory-that-works-like-human-memory , https://cdn.jsdelivr.net/npm/pi-hindsight@1.4.2/skills/hindsight-docs/references/developer/configuration.md , https://cdn.jsdelivr.net/npm/pi-hindsight@1.4.2/skills/hindsight-docs/references/developer/installation.md , https://pypi.org/project/hindsight-api/
- chatscope: https://www.github.com/chatscope/chat-ui-kit-react , https://npmjs.com/@chatscope/chat-ui-kit-react
- WorkAdventure: https://workadventu.re/faq/what-is-the-license-of-the-self-hosted-version-of-workadventure/ , https://workadventu.re/support/pricing-and-licensing/
- 메신저 비교: https://openapps.pro/apps/rocket-chat , https://mintlify.com/awesome-selfhosted/awesome-selfhosted/categories/communication/custom-systems , https://selfhostyourself.com/alternative-to/telegram
- swarm: https://awesome.ecosyste.ms/projects/github.com%2Fsaganaki22%2Fswarm , https://discourse.threejs.org/t/interactive-3d-scene-built-with-three-js-webgpu-and-tsl/90492 , https://tympanus.net/codrops/2019/01/17/interactive-particles-with-three-js/
- R3F, WebGPU, 후처리: https://www.utsubo.com/blog/threejs-2026-what-changed , https://newreleases.io/project/npm/@react-three/fiber/release/10.0.0-alpha.6 , https://github.com/pmndrs/react-postprocessing , https://react-postprocessing.docs.pmnd.rs/effects/tilt-shift-2 , https://react-postprocessing.docs.pmnd.rs/effects/tone-mapping
- 유리: https://drei.docs.pmnd.rs/shaders/mesh-transmission-material , https://discourse.threejs.org/t/transmission-effect-pbr-material-performance/59274 , https://discourse.threejs.org/t/meshtransmissionmaterial-poor-performances-urgent/68566
- 환경: https://drei.docs.pmnd.rs/staging/environment , https://docs.polyhaven.com/en/faq , https://polyhaven.com/a/venice_sunset
- 소품: https://kenney.nl/assets/furniture-kit , https://app.cinevva.com/guides/free-3d-model-sites , https://opengameart.org/content/furniture-kit
- 로컬 파일: `C:\Users\siheon.ryu\Downloads\ensemble_room_concept.html`, `C:\Users\siheon.ryu\Downloads\ensemble-demo-v33.0.html`, 참고 이미지 1(`C:\Users\siheon.ryu\AppData\Local\Temp\claude\778d790de123c958\ffaf0d4f-ea9e-4da1-84db-ca43150ec33f\images\1.webp`)

## 사용자 결정 (2026-11-19)

12절 질문에 대한 답이다.

1. **Claude API**: 사용자가 저장소 루트의 `.env.txt`에 프록시 설정을 넣어 두었다. 변수 이름은 `ANTHROPIC_BASE_URL`과 `ANTHROPIC_API_KEY`이며 값은 비밀이다(읽거나 출력하거나 로그에 남기지 않는다).
   - 서버는 claude 모드에서 `ANTHROPIC_BASE_URL`을 SDK의 baseURL로 넘긴다.
   - 환경 파일은 `.env`를 우선 읽고, 없으면 `.env.txt`를 읽는다.
   - 모델 ID는 사용자가 지정하지 않았으므로 기본값을 `ANTHROPIC_MODEL_AGENT=claude-sonnet-5`, `ANTHROPIC_MODEL_LIGHT=claude-sonnet-4-6`로 두고 env로 덮어쓸 수 있게 한다. 프록시가 이 ID를 받는지는 S9에서 실제 호출로 확인한다.
   - 키가 없을 때를 위해 `AGENT_MODE=mock`도 유지한다.
2. **캐릭터 에셋**: GitHub 저장소에 커밋해도 된다. 따라서 10.1절의 "characters/avatars/lottie를 `.gitignore`에 넣는다"는 적용하지 않는다. 장식 변종의 고해상도 원본은 없으므로 144px로 진행한다.
3. **Hindsight**: 1차는 자체 메모리(SQLite) + 인터페이스만 만든다. S20의 `hindsightStore.ts`는 만들지 않는다.
4. **모델 ID (2026-11-19 갱신)**: 프록시가 제공하는 모델에 맞춰 기본값을 `ANTHROPIC_MODEL_AGENT=claude-sonnet-5`, `ANTHROPIC_MODEL_LIGHT=claude-sonnet-4-6`으로 변경했다. 프록시가 받지 않는 ID는 403(`key_model_access_denied`)이 되므로 env로 덮어쓴다.
