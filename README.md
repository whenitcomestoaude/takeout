# Take-out

수원사업장 테이크아웃 메뉴를 고르는 한 장짜리 페이지.

- `index.html` — 화면. `build.py` 가 원본 페이지에 `prelude.js` 를 씌워 만든다.
- `prelude.js` — 메뉴와 선택 내용을 읽고 쓰는 연결부.
- `next/` — 큰 변경을 먼저 올려 보는 미리보기.
- 열쇠는 이 저장소에 없다. 주소 끝에 `#k=...` 로 붙여서 연다.

## 서버 (Supabase)

데이터와 서버 코드는 Supabase 프로젝트에 있다. `functions/` 는 배포된 Edge Function 의 사본이다. 고칠 때는 여기를 고쳐 배포하고 같이 커밋한다.

- `functions/welstory-menu` — PlanEAT 에서 R5 B1F·패밀리홀·투게더홀·폴라리스홀 메뉴를 받아 `welstory.menu_item` 에 넣는다.
- `functions/takeout-api` — 페이지가 부르는 곳. 메뉴 읽기, 공유 상태 읽고 쓰기, 사진·진열대 채우기, NEW 기준 기록.
- `functions/takeout-price` — Claude API 로 메뉴별 시중가를 찾아 `welstory.menu_price` 에 넣는다.

세 함수 모두 JWT 검사 없이(`verify_jwt: false`) 열쇠(`k=`)로만 막는다.

비밀 값은 Supabase 에만 있다: `MENU_KEY`, `ANTHROPIC_API_KEY`, `WELSTORY_USERNAME`, `WELSTORY_PASSWORD` (선택: `WELSTORY_DEVICE_ID`, `PRICE_MODEL`).

예약 작업(pg_cron, 한국 시각):

- 05:10, 14:10 — `welstory-menu` 로 사흘치 메뉴 갱신
- 05:14, 14:14 — `takeout-api?api=photos` 로 사진·진열대·NEW 기준·시중가 채우기
- 월요일 04:30 — 지난 cron 실행 기록 정리
