// welstory-menu — Welstory+ 식단을 받아 선택형(테이크아웃) 서브메뉴까지 펼쳐 welstory.menu_item 에 저장한다.
// Secrets: WELSTORY_USERNAME, WELSTORY_PASSWORD, MENU_KEY  (SUPABASE_DB_URL 은 자동 제공)
// GET ?k=<MENU_KEY>&sync=1[&d=YYYYMMDD][&days=3][&m=1,3][&r=REST000007]  → 저장
// GET ?k=<MENU_KEY>&f=txt[&d=..][&m=..][&r=..]                            → 텍스트로 미리보기
// GET ?k=<MENU_KEY>&list=1                                                → 등록 식당 목록
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import postgres from "npm:postgres@3.4.4";

const BASE = "https://welplus.welstory.com";
// 공개 저장소라 기기 ID 는 빼 두었다. 배포본에는 기본값이 들어 있다(웰스토리 로그인 경로 ws=1 에서만 쓴다).
const DEVICE_ID = Deno.env.get("WELSTORY_DEVICE_ID") ?? "";
const MEAL_NAMES: Record<string, string> = { "1": "아침", "2": "점심", "3": "저녁" };
const DEFAULT_REST = "REST000007"; // R5 B1F
const PC_BASE = "https://m.planeatchoice.net/v2";

let token: string | null = null;
let tokenExp = 0;

function jwtExp(t: string): number {
  try {
    const p = t.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(p)).exp ?? 0;
  } catch {
    return 0;
  }
}

async function login(): Promise<string> {
  const res = await fetch(`${BASE}/login`, {
    method: "POST",
    headers: {
      "User-Agent": "Welplus",
      "X-Device-Id": DEVICE_ID,
      "X-Autologin": "N",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      username: Deno.env.get("WELSTORY_USERNAME") ?? "",
      password: Deno.env.get("WELSTORY_PASSWORD") ?? "",
      "remember-me": "false",
    }).toString(),
  });
  const auth = res.headers.get("Authorization");
  if (!res.ok || !auth) throw new Error(`로그인 실패 (HTTP ${res.status})`);
  token = auth;
  tokenExp = jwtExp(auth);
  return auth;
}

async function getToken(force = false): Promise<string> {
  if (!force && token && tokenExp - Date.now() / 1000 > 300) return token;
  return await login();
}

// 요청은 항상 직렬로 — 웰스토리는 동시 요청에 빈 응답을 준다.
async function api<T>(path: string): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const t = await getToken(attempt > 0);
    const res = await fetch(`${BASE}${path}`, {
      headers: { "User-Agent": "Welplus", "X-Device-Id": DEVICE_ID, Authorization: t },
    });
    const text = await res.text();
    const html = /^\s*<(!doctype|html)/i.test(text);
    if (res.status === 401 || res.status === 403 || html || !text.trim()) {
      await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} ${path}`);
    const json = JSON.parse(text);
    return (json && typeof json === "object" && "data" in json ? json.data : json) as T;
  }
  throw new Error(`응답 없음 ${path}`);
}

type Dish = {
  menuName: string; hallNo: string; menuCourseType: string; courseTxt: string;
  typicalMenu: string; salesType?: string; kcal: string | null; sumKcal: string | null;
  restaurantName?: string;
};
type Item = {
  raw: string; tag: string | null; name: string; kcal: number | null;
  coin: number | null; handmade: boolean; main?: boolean;
};
type Course = {
  course: string; hallNo: string; courseType: string; title: string; kcal: number | null;
  selectable: boolean; takeout: boolean; items: Item[];
};

const num = (v: string | null | undefined) => {
  if (!v) return null;
  const n = parseFloat(String(v).replace(/,/g, ""));
  return isNaN(n) ? null : n;
};
const COUNT_RE = /외\s*\d+\s*종|\d+\s*종\s*$|선택형/;

function parseItem(raw: string, kcal: string | null, main?: boolean): Item {
  let rest = raw.trim();
  let tag: string | null = null;
  const m = rest.match(/^\[([^\]]+)\]\s*(.*)$/);
  // 첫 대괄호가 [수제]/[건강빵] 같은 설명이면 태그가 아니다
  if (m && !/수제|건강|착즙|콩즙/.test(m[1])) {
    tag = m[1];
    rest = m[2];
  }
  const handmade = /\[수제\]/.test(rest);
  const name = rest.replace(/\[수제\]\s*/g, "").trim();
  const coinMatch = tag?.match(/(\d+)\s*$/);
  return { raw, tag, name, kcal: num(kcal), coin: coinMatch ? +coinMatch[1] : null, handmade, main };
}

async function loadMeal(rest: string, date: string, meal: string): Promise<Course[]> {
  const q = `menuDt=${date}&menuMealType=${meal}&restaurantCode=${rest}`;
  const wrap = await api<{ mealList?: Dish[] }>(`/api/meal?${q}`);
  const dishes = wrap?.mealList ?? [];
  const groups = new Map<string, Dish[]>();
  for (const d of dishes) {
    const key = `${d.hallNo}|${d.menuCourseType}`;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(d);
  }

  const courses: Course[] = [];
  for (const group of groups.values()) {
    const first = group[0];
    const main = group.find((d) => d.typicalMenu === "Y") ?? first;
    const takeout = (first.salesType ?? "").startsWith("T") || /T\/O|테이크/i.test(first.courseTxt ?? "");
    const selectable = group.some((d) => COUNT_RE.test(d.menuName)) || takeout;

    let items: Item[] = group.map((d) => parseItem(d.menuName, d.kcal, d.typicalMenu === "Y"));

    if (selectable) {
      const dq = `menuDt=${date}&hallNo=${first.hallNo}&menuCourseType=${first.menuCourseType}&menuMealType=${meal}&restaurantCode=${rest}`;
      try {
        let detail = await api<{ menuName: string; kcal: string | null }[]>(`/api/meal/detail/nutrient?${dq}`);
        if (!Array.isArray(detail) || detail.length === 0) detail = await api(`/api/meal/detail?${dq}`);
        if (Array.isArray(detail) && detail.length) {
          items = detail.filter((d) => !/외\s*\d+\s*종/.test(d.menuName)).map((d) => parseItem(d.menuName, d.kcal));
        }
      } catch (_) { /* 펼치기 실패 시 원래 목록 유지 */ }
    }

    courses.push({
      course: first.courseTxt ?? "",
      hallNo: first.hallNo,
      courseType: first.menuCourseType,
      title: parseItem(main.menuName, null).name.replace(/\s*외\s*\d+\s*종$/, ""),
      kcal: num(first.sumKcal),
      selectable,
      takeout,
      items,
    });
  }
  return courses;
}

function kst(offsetDays = 0) {
  const d = new Date(Date.now() + 9 * 3600 * 1000 + offsetDays * 86400 * 1000);
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}
function addDays(ymd: string, n: number) {
  const d = new Date(Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8)) + n * 86400 * 1000);
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}

async function restaurants() {
  const rests = await api<{ restaurantId?: string; restaurantCode?: string; restaurantName: string }[]>(
    "/api/mypage/rest-my-list",
  );
  return (rests ?? [])
    .map((r) => ({ id: (r.restaurantId ?? r.restaurantCode ?? "").toUpperCase(), name: r.restaurantName }))
    .filter((r) => /^REST\d{6}$/.test(r.id) && !/운영종료/.test(r.name));
}

// ---- PlanEAT Choice (신세계푸드 앱, 실제 운영은 CJ) — 로그인 없는 공개 API ----
// R5 B1F 도 PlanEAT 에 그대로 있다 — 웰스토리 로그인 없이 받는다. id 는 페이지의 기존 기록과 맞추려고 웰스토리 코드를 쓴다.
const PC_RESTS = [
  { id: "REST000007", name: "R5 B1F", busiCd: "RH3_K_001", compCd: "K_KR_017", storCd: "CAF36", orgTreeId: "0:0:6" },
  // 패밀리홀(신세계): 코인 대신 [DELI]=2 · [SIDE]=1 · [2Pick]=2 · [1Pick]=4(한 개로 1인분) 표기
  { id: "CAF04", name: "패밀리홀", busiCd: "RH3_K_001", compCd: "K_KR_017", storCd: "CAF04", orgTreeId: "0:0:10", fam: true },
  // 투게더홀(CJ)은 [3Coin], 폴라리스홀(동원)은 [Main3] 처럼 코인이 적혀 있다
  { id: "CAF05", name: "투게더홀", busiCd: "RH3_K_001", compCd: "K_KR_017", storCd: "CAF05", orgTreeId: "0:0:9" },
  { id: "CAF38", name: "폴라리스홀", busiCd: "RH3_K_001", compCd: "K_KR_017", storCd: "CAF38", orgTreeId: "0:0:11" },
] as { id: string; name: string; busiCd: string; compCd: string; storCd: string; orgTreeId: string; fam?: boolean }[];
const FAM_TAG: [RegExp, number, string][] = [[/\[DELI\]/i, 2, "DELI"], [/\[SIDE\]/i, 1, "SIDE"], [/\[1\s*Pick\]/i, 4, "1Pick"], [/\[2\s*Pick\]/i, 2, "2Pick"]];
function famTag(raw: string) { for (const [re, c, t] of FAM_TAG) if (re.test(raw)) return { coin: c, tag: t }; return null; }
// 패밀리홀은 한 묶음에 과일·김밥·라면·요거트가 다 섞여 있어서 품목마다 진열대를 짐작한다
function famCat(raw: string, name: string) {
  if (/\[FROZEN\]/i.test(raw)) return "냉동";
  if (/셀프라면/.test(raw)) return "컵라면";
  if (/떡집|떡$|약과|찹쌀떡/.test(name) && !/떡볶이/.test(name)) return "떡";
  if (/착즙|즙|쉐이크/.test(raw)) return "간식·요거트";
  const g = pcGuess(name);
  return g !== "기타" ? g : cupCat([name]);
}
const PC_CAT: Record<string, string> = {
  FRUIT: "과일", "RICE CAKE": "떡", FROZEN: "냉동", CUPFOOD: "컵푸드", RICE: "밥·죽",
  BAKERY: "빵", NOODLE: "컵라면", SIDE: "사이드", BEVERAGE: "음료", SALAD: "샐러드", SANDWICH: "샌드위치",
  HEALTHY: "간식·요거트", "RICE & NOODLE": "밥·면", // 폴라리스홀 표기 — 밥·면은 품목마다 라면과 밥으로 나눈다
};
// [CUPFOOD] 는 빵·과일·라면·햇반·간식이 섞여 있어서 품목 이름으로 다시 나눈다
function cupCat(names: string[]) {
  const tests: [string, RegExp][] = [
    ["빵", /빵|브레드|크라상|카스테라|포카차|바게뜨|페스츄리|모닝롤|스콘|쉬크레|고로케|베이글|파이|깜빠뉴|캄파뉴|롤$/],
    ["과일", /감귤|사과|토마토|바나나|망고|단감|용과|블루베리|황금향|포도|키위/],
    ["컵라면", /라면|우동|짬뽕|짜장|컵누들|볶음면|국수|툼바|무파마|사발면|왕뚜껑|큰사발|컵면/],
    ["밥·죽", /햇반|밥|죽|김밥|덮밥|국밥|해장국|시리얼/],
  ];
  let best = "간식·요거트", n = 0;
  for (const [cat, re] of tests) { const c = names.filter((x) => re.test(x)).length; if (c > n && c >= names.length * .4) { best = cat; n = c; } }
  return best;
}
function pcParse(raw: string) {
  const coin = raw.match(/\[(\d+)\s*Coin\]|\[Main\s*(\d+)\]/i);
  const cat = raw.match(/\[(FRUIT|RICE CAKE|FROZEN|CUPFOOD|RICE|BAKERY|NOODLE|SIDE|BEVERAGE|SALAD|SANDWICH|HEALTHY|RICE\s*&\s*NOODLE)\]/i);
  const name = raw.replace(/\[[^\]]*\]/g, "").replace(/^\s*음료\s+/, "").replace(/\s*외\s*\d+\s*종\s*$/, "").replace(/\s{2,}/g, " ").trim();
  return { coin: coin ? +(coin[1] ?? coin[2]) : null, cat: cat ? PC_CAT[cat[1].toUpperCase().replace(/\s*&\s*/, " & ")] : null, hand: /\[수제\]/.test(raw), name };
}
// 카테고리 표기가 없는 수제 묶음은 이름으로 진열대를 짐작한다
function pcGuess(name: string) {
  if (/샐러드|포케|채소스틱|옥수수|헬스팩|야채찜|채소찜|구황|완숙란|찐감자|고구마\s*팩|찐고구마|계란/.test(name)) return "샐러드";
  if (/샌드위치|핫도그|토스트|에그|치아바타|크로와상|베이글|버거/.test(name)) return "샌드위치";
  if (/김밥|주먹밥|컵밥|죽$|죽\)|덮밥|볶음밥/.test(name)) return "밥·죽";
  if (/요거|그릭|오트밀/.test(name)) return "간식·요거트";
  if (/치킨|강정|족발|보울|브리또|파스타|스테이크|구이|볶음|스프/.test(name)) return "핫밀";
  return "기타";
}
async function pcRows(r: typeof PC_RESTS[number], date: string, meal: string) {
  const qs = new URLSearchParams({
    itemFg: "", packFg: "", today: new Date().toUTCString(), saleDt: `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`,
    listType: "card", orderType: "new", busiCd: r.busiCd, compCd: r.compCd, storCd: r.storCd, orgTreeId: r.orgTreeId, mealCd: meal,
  });
  const res = await fetch(`${PC_BASE}/portal/dailyMenu?${qs}`, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error(`PlanEAT HTTP ${res.status}`);
  const ds: any[] = (await res.json()).ds ?? [];
  const rows: Record<string, unknown>[] = [];
  for (const x of ds) {
    if (String(x.packFg) !== "2" || x.useYn === "N" || x.displayYn === "N") continue; // 테이크아웃만
    const head = pcParse(String(x.itemNmDp ?? ""));
    const entries = [{ raw: String(x.itemNmDp ?? ""), kcal: x.calorie }, ...(x.dailySubMenuDtos ?? []).map((s: any) => ({ raw: String(s.subItemNmDp ?? ""), kcal: s.calorie }))];
    const mainRaw = String(x.mainNm ?? "");
    let cat = pcParse(mainRaw).cat ?? head.cat ?? pcGuess(head.name);
    if (cat === "컵푸드") cat = cupCat(entries.map((e) => pcParse(e.raw).name));
    const drinks = cat === "음료";
    const groupTag = r.fam ? famTag(mainRaw) ?? famTag(String(x.itemNmDp ?? "")) : null;
    entries.forEach((e, i) => {
      const it = pcParse(e.raw);
      if (!it.name) return;
      let coin = it.coin, tag = coin ? `${coin}Coin` : null, c = cat;
      if (c === "밥·면") c = /라면|우동|짬뽕|국수|쌀국수|볶음면/.test(it.name) ? "컵라면" : "밥·죽";
      if (r.fam && !drinks) {
        const t = famTag(e.raw) ?? groupTag ?? { coin: 2, tag: "DELI?" }; // 표기 없는 코너(김밥·포케)는 델리로 추정
        coin = t.coin; tag = t.tag; c = famCat(e.raw, it.name);
      }
      rows.push({
        menu_dt: date, meal, restaurant_code: r.id, restaurant_name: r.name,
        course: `T/O ${c}`, hall_no: String(x.cnrCd ?? ""), course_type: String(x.itemCd ?? ""), seq: i,
        raw_name: e.raw, tag, name: it.name, kcal: typeof e.kcal === "number" ? e.kcal : null,
        coin, handmade: it.hand, selectable: true, takeout: true,
      });
    });
  }
  return rows;
}

async function put(sql: any, date: string, meal: string, rid: string, rows: Record<string, unknown>[]) {
  await sql.begin(async (tx: any) => {
    await tx`delete from welstory.menu_item where menu_dt = ${date} and meal = ${meal} and restaurant_code = ${rid}`;
    await tx`insert into welstory.menu_item ${tx(rows)}`;
  });
}

async function sync(dates: string[], meals: string[], rests: { id: string; name: string }[], pcRests = PC_RESTS) {
  const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { prepare: false, max: 1 });
  const summary: string[] = [];
  try {
    for (const r of rests) for (const date of dates) for (const meal of meals) {
      const courses = await loadMeal(r.id, date, meal);
      const rows = courses.flatMap((c) =>
        c.items.map((it, i) => ({
          menu_dt: date, meal, restaurant_code: r.id, restaurant_name: r.name,
          course: c.course, hall_no: c.hallNo, course_type: c.courseType, seq: i,
          raw_name: it.raw, tag: it.tag, name: it.name, kcal: it.kcal, coin: it.coin,
          handmade: it.handmade, selectable: c.selectable, takeout: c.takeout,
        }))
      );
      // 메뉴가 아직 안 올라온 날은 기존 데이터를 지우지 않는다
      if (!rows.length) { summary.push(`${date} ${MEAL_NAMES[meal]} ${r.name}: 없음`); continue; }
      await put(sql, date, meal, r.id, rows);
      summary.push(`${date} ${MEAL_NAMES[meal]} ${r.name}: ${rows.length}`);
    }
    for (const r of pcRests) for (const date of dates) for (const meal of meals) {
      try {
        const rows = await pcRows(r, date, meal);
        if (!rows.length) { summary.push(`${date} ${MEAL_NAMES[meal]} ${r.name}: 없음`); continue; }
        await put(sql, date, meal, r.id, rows);
        summary.push(`${date} ${MEAL_NAMES[meal]} ${r.name}: ${rows.length}`);
      } catch (e) { summary.push(`${date} ${MEAL_NAMES[meal]} ${r.name}: 오류 ${(e as Error).message}`); }
    }
    // 지난 날짜는 남겨둘 이유가 없다 — 테이블을 항상 며칠치로 유지
    const gone = await sql`delete from welstory.menu_item where menu_dt < ${kst(0)}`;
    summary.push(`지난 메뉴 삭제: ${gone.count}`);
  } finally {
    await sql.end();
  }
  return summary;
}

function renderText(date: string, blocks: { restaurant: string; meal: string; courses: Course[] }[]): string {
  const out: string[] = [date];
  for (const b of blocks) {
    out.push("", `■ ${b.restaurant} · ${MEAL_NAMES[b.meal] ?? b.meal}`);
    for (const c of b.courses) {
      out.push(`  [${c.course}] ${c.selectable ? `선택형 ${c.items.length}종` : c.title}`);
      if (c.selectable) for (const it of c.items) out.push(`   - ${it.raw}${it.kcal ? ` (${it.kcal})` : ""}`);
    }
  }
  return out.join("\n");
}

const text = (s: string, status = 200) =>
  new Response(s, { status, headers: { "Content-Type": "text/plain; charset=utf-8" } });

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const key = Deno.env.get("MENU_KEY");
  if (!key || url.searchParams.get("k") !== key) return text("forbidden", 403);

  try {
    const p = url.searchParams;

    // ---- PlanEAT Choice (신세계푸드) 탐색용: 로그인 없는 공개 API ----
    if (p.get("pc") === "tree") {
      const res = await fetch(`${PC_BASE}/storTree`, { headers: { "User-Agent": "Mozilla/5.0" } });
      const raw = await res.json();
      const roots = Array.isArray(raw) ? raw : (raw.ds ?? raw.data ?? raw.list ?? raw.resultList ?? []);
      const out: unknown[] = [];
      const walk = (nodes: any[], idx: number[], names: string[]) => nodes.forEach((n, i) => {
        const name = n.title?.ko ?? n.data?.storNm ?? n.code;
        const path = [...idx, i], pnames = [...names, name];
        if (n.type === "STOR" && (p.get("q") ? pnames.join(" ").includes(p.get("q")!) : true))
          out.push({ name, path: pnames.join(" > "), orgTreeId: path.join(":"), ...n.data });
        if (n.children?.length) walk(n.children, path, pnames);
      });
      walk(roots, [], []);
      console.log("pc-tree", JSON.stringify(out).slice(0, 9000));
      return text(JSON.stringify(out, null, 1));
    }
    // 응답 전체(이름이 아닌 칸까지)에서 단어를 찾는다 — 예: pick / 픽
    if (p.get("pc") === "grep") {
      const term = (p.get("t") ?? "pick").toLowerCase();
      const d = p.get("d") ?? kst(0);
      const hits: string[] = [];
      for (const r of PC_RESTS) for (const meal of ["1", "2", "3"]) {
        const qs = new URLSearchParams({ itemFg: "", packFg: "", today: new Date().toUTCString(), saleDt: `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`,
          listType: "card", orderType: "new", busiCd: r.busiCd, compCd: r.compCd, storCd: r.storCd, orgTreeId: r.orgTreeId, mealCd: meal });
        const ds: any[] = (await (await fetch(`${PC_BASE}/portal/dailyMenu?${qs}`, { headers: { "User-Agent": "Mozilla/5.0" } })).json()).ds ?? [];
        for (const x of ds) {
          const walk = (o: any, path: string) => {
            if (o && typeof o === "object") { for (const [k, v] of Object.entries(o)) walk(v, `${path}.${k}`); return; }
            if (typeof o === "string" && o.toLowerCase().includes(term)) hits.push(`${r.name} ${MEAL_NAMES[meal]} | ${x.itemNmDp} | ${path} = ${o}`);
          };
          walk(x, "");
        }
      }
      console.log("pc-grep", hits.join("\n").slice(0, 9500));
      return text(hits.join("\n") || "없음");
    }
    if (p.get("pc") === "menu") {
      const q = new URLSearchParams({ busiCd: p.get("busiCd") ?? "", compCd: p.get("compCd") ?? "", storCd: p.get("storCd") ?? "" });
      const t = await (await fetch(`${PC_BASE}/storTime?${q}`, { headers: { "User-Agent": "Mozilla/5.0" } })).json();
      const d = p.get("d") ?? kst(0);
      const qs = new URLSearchParams({ itemFg: "", packFg: "", today: new Date().toUTCString(), saleDt: `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`,
        listType: "card", orderType: "new", busiCd: p.get("busiCd") ?? "", compCd: p.get("compCd") ?? "", storCd: p.get("storCd") ?? "",
        orgTreeId: p.get("orgTreeId") ?? "", mealCd: p.get("mealCd") ?? "1" });
      const m = await (await fetch(`${PC_BASE}/portal/dailyMenu?${qs}`, { headers: { "User-Agent": "Mozilla/5.0" } })).json();
      const ds: any[] = m.ds ?? [];
      const keys = [...new Set(ds.flatMap((x) => Object.keys(x)))].filter((k) => !/vitamin|origin|row|updated|file|folic|iron|phos|potass|calcium|fat|salt|sugar|carbo|protein|fiber|chol/i.test(k));
      const lines = ds.map((x) => [x.packFg, x.itemFg, x.cnrCd, x.cnrNm, x.itemNmDp, x.mainNm, x.calorie, x.soldOutYn,
        (x.dailySubMenuDtos ?? []).map((s: any) => s.subItemNmDp).join("+")].join(" | "));
      const out = `keys: ${keys.join(",")}\n` + lines.join("\n");
      console.log("pc-menu", out.slice(0, 9500));
      return text(out);
    }

    // 기본 갱신은 PlanEAT 만 쓴다 — 웰스토리 로그인은 ws=1 일 때만
    if (p.get("sync") === "1" && p.get("ws") !== "1") {
      const start = p.get("d") ?? kst(0);
      const days = Math.min(+(p.get("days") ?? 3) || 3, 7);
      const dates = Array.from({ length: days }, (_, i) => addDays(start, i));
      const meals = (p.get("m") ?? "1,3").split(",").filter((x) => MEAL_NAMES[x]);
      const summary = await sync(dates, meals, []);
      console.log("sync", summary.join(" | "));
      return text(summary.join("\n"));
    }

    const only = (p.get("r") ?? "").toUpperCase().split(",").map((s) => s.trim()).filter(Boolean);
    const all = await restaurants();
    if (p.get("list") === "1") return text(all.map((r) => `${r.id}  ${r.name}`).join("\n"));
    const want = only.length ? only : [DEFAULT_REST];
    const rests = all.filter((r) => want.includes(r.id));

    if (p.get("sync") === "1") {
      const start = p.get("d") ?? kst(0);
      const days = Math.min(+(p.get("days") ?? 3) || 3, 7);
      const dates = Array.from({ length: days }, (_, i) => addDays(start, i));
      const meals = (p.get("m") ?? "1,3").split(",").filter((x) => MEAL_NAMES[x]);
      const summary = await sync(dates, meals, rests, []);
      console.log("sync", summary.join(" | "));
      return text(summary.join("\n"));
    }

    const date = p.get("d") ?? kst(0);
    const meals = (p.get("m") ?? "1,3").split(",").filter((x) => MEAL_NAMES[x]);
    const blocks = [];
    for (const r of rests) for (const meal of meals) blocks.push({ restaurant: r.name, meal, courses: await loadMeal(r.id, date, meal) });
    const out = renderText(date, blocks);
    if (p.get("debug") === "1") console.log(out.slice(0, 9000));
    return text(out);
  } catch (e) {
    console.error(e);
    return text(`오류: ${(e as Error).message}`, 502);
  }
});
