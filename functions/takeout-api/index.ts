// takeout-api — 독립 페이지(홈 화면 앱)용: 메뉴 읽기, 담은 메뉴·하트 읽고 쓰기.
// GET  ?k=<MENU_KEY>&api=menu   → 오늘부터의 테이크아웃 메뉴 (welstory.menu_item) + 시중가(pr, ps: naver|est|manual, pc: 분류)
// GET  ?k=<MENU_KEY>&api=price&name=<메뉴> → 그 메뉴의 시중가 { pr, ps, pt, pl } 또는 null
// GET  ?k=<MENU_KEY>&api=state  → 저장된 선택 { data }
// POST ?k=<MENU_KEY>&api=state  → 본문(JSON 글자)을 통째로 저장
// GET  ?k=<MENU_KEY>&api=sync   → 메뉴를 지금 다시 가져온다(welstory-menu 호출) + 사진
// GET  ?k=<MENU_KEY>&api=ping&id=<기기> → 동시 접속 표시용. 다른 기기 수 { others }
// GET  ?k=<MENU_KEY>&api=backfill&from=YYYYMMDD&days=N[&r=CAF05,CAF38] → 지난 메뉴 이름을 PlanEAT 에서 읽어 menu_seen 에 채운다 (NEW 판단 기준)
// GET  ?k=<MENU_KEY>&api=photos → PlanEAT 에서 사진 경로를 받아 menu_item.photo 에 채운다 (메뉴 갱신 직후 cron 이 부른다)
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import postgres from "npm:postgres@3.4.4";

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "content-type" };
const json = (v: unknown, status = 200) =>
  new Response(JSON.stringify(v), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...CORS } });
const PC = "https://m.planeatchoice.net/v2/portal/dailyMenu";
const RESTS = [
  { id: "REST000007", storCd: "CAF36", orgTreeId: "0:0:6" },
  { id: "CAF04", storCd: "CAF04", orgTreeId: "0:0:10" },
  { id: "CAF05", storCd: "CAF05", orgTreeId: "0:0:9" },   // 투게더홀
  { id: "CAF38", storCd: "CAF38", orgTreeId: "0:0:11" },  // 폴라리스홀
];
const addDays = (ymd: string, n: number) =>
  new Date(Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8)) + n * 864e5).toISOString().slice(0, 10).replace(/-/g, "");
const today = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10).replace(/-/g, "");

const SHELF: Record<string, string> = { FRUIT: "과일", "RICE CAKE": "떡", FROZEN: "냉동", CUPFOOD: "컵푸드", RICE: "밥·죽", BAKERY: "베이커리", NOODLE: "누들", SIDE: "사이드", BEVERAGE: "음료", SALAD: "샐러드", SANDWICH: "샌드위치" };
const SHELF_RE = /\[(FRUIT|RICE CAKE|FROZEN|CUPFOOD|RICE|BAKERY|NOODLE|SIDE|BEVERAGE|SALAD|SANDWICH)\]/i;
// PlanEAT 사진 경로를 menu_item.photo 에, 원래 진열 구분을 shelf 에 채운다
async function fillPhotos(sql: any): Promise<number> {
  let set = 0;
  for (const r of RESTS) for (let i = 0; i < 3; i++) for (const meal of ["1", "3"]) {
    const d = addDays(today(), i);
    const qs = new URLSearchParams({ itemFg: "", packFg: "", saleDt: `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`, listType: "card", orderType: "new",
      busiCd: "RH3_K_001", compCd: "K_KR_017", storCd: r.storCd, orgTreeId: r.orgTreeId, mealCd: meal });
    const res = await fetch(`${PC}?${qs}`, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!res.ok) continue;
    for (const x of ((await res.json()).ds ?? []) as any[]) {
      if (String(x.packFg) !== "2") continue;
      // 원래 진열 구분([CUPFOOD] 같은 표기)을 묶음 전체에 적어 둔다 — 현장에서 찾을 때 쓰는 이름
      const sh = `${x.mainNm ?? ""} ${x.itemNmDp ?? ""}`.match(SHELF_RE);
      if (sh) await sql`update welstory.menu_item set shelf = ${SHELF[sh[1].toUpperCase()]}
        where menu_dt = ${d} and meal = ${meal} and restaurant_code = ${r.id} and hall_no = ${String(x.cnrCd ?? "")} and course_type = ${String(x.itemCd ?? "")}`;
      // 패밀리홀 포케(아침)·밸런스(저녁) 코너는 5코인 — Welstory 데이터엔 코인 표기가 없어 2코인 DELI 로 짐작되던 것을 바로잡는다
      const sp = String(x.itemNmDp ?? "").match(/\[(포케|밸런스)\]/);
      if (sp && r.id === "CAF04") await sql`update welstory.menu_item set coin = 5, tag = ${sp[1]}
        where menu_dt = ${d} and meal = ${meal} and restaurant_code = ${r.id} and welstory.menu_key(name) = welstory.menu_key(${String(x.itemNmDp).replace(/\[[^\]]*\]/g, "")})`;
      const f = x.fileUpload?.[0];
      if (!f?.savePath || /준비중/.test(f.fileNm ?? "")) continue;
      const u = await sql`update welstory.menu_item set photo = ${String(f.savePath)}
        where menu_dt = ${d} and meal = ${meal} and restaurant_code = ${r.id} and hall_no = ${String(x.cnrCd ?? "")} and course_type = ${String(x.itemCd ?? "")} and seq = 0`;
      set += u.count;
    }
  }
  return set;
}

// 메뉴가 처음 나온 날: 지금 메뉴를 menu_seen 에 반영 (NEW 표시용)
async function seenUpdate(sql: any) {
  await sql`insert into welstory.menu_seen (key, name, first_dt, last_dt)
    select welstory.menu_key(name), min(name), min(menu_dt), max(menu_dt) from welstory.menu_item where takeout and menu_dt >= ${addDays(today(), -1)} group by 1
    on conflict (key) do update set first_dt = least(welstory.menu_seen.first_dt, excluded.first_dt), last_dt = greatest(welstory.menu_seen.last_dt, excluded.last_dt)`;
}
// 지난 메뉴를 PlanEAT 에서 읽어 menu_seen 에 채운다 (처음 한 번, 날짜 범위를 나눠서 부른다)
async function backfill(sql: any, from: string, days: number, only: string[] = []): Promise<number> {
  const seen = new Map<string, string>();
  for (let i = 0; i < days; i++) { const d = addDays(from, i);
    for (const r of RESTS.filter((x) => !only.length || only.includes(x.id))) for (const meal of ["1", "3"]) {
      const qs = new URLSearchParams({ itemFg: "", packFg: "", saleDt: `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`, listType: "card", orderType: "new",
        busiCd: "RH3_K_001", compCd: "K_KR_017", storCd: r.storCd, orgTreeId: r.orgTreeId, mealCd: meal });
      const res = await fetch(`${PC}?${qs}`, { headers: { "User-Agent": "Mozilla/5.0" } });
      if (!res.ok) continue;
      for (const x of ((await res.json()).ds ?? []) as any[]) {
        if (String(x.packFg) !== "2") continue;
        const subs = (x.dailySubMenuDtos ?? []) as any[];
        const names = [String(x.itemNmDp ?? ""), ...subs.map((y) => String(y.subItemNmDp ?? ""))]; // 대표 메뉴 + 묶음의 나머지
        for (const n of names) if (n.trim()) { const k = `${n}`; if (!seen.has(k) || seen.get(k)! > d) seen.set(k, d); }
      }
    }
  }
  const rows = [...seen].map(([name, d]) => ({ name: name.replace(/\[[^\]]*\]|\*?\s*품절/g, "").trim(), d }));
  for (const r of rows) await sql`insert into welstory.menu_seen (key, name, first_dt, last_dt) values (welstory.menu_key(${r.name}), ${r.name}, ${r.d}, ${r.d})
    on conflict (key) do update set first_dt = least(welstory.menu_seen.first_dt, excluded.first_dt), last_dt = greatest(welstory.menu_seen.last_dt, excluded.last_dt)`;
  return rows.length;
}

// 시중가 채우기는 takeout-price 함수가 한다
async function fillPrices(key: string, n: number): Promise<unknown> {
  try {
    const res = await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/takeout-price?k=${encodeURIComponent(key)}&api=fill&n=${n}`);
    return res.ok ? await res.json() : { error: res.status };
  } catch (e) { return { error: (e as Error).message }; }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  const p = new URL(req.url).searchParams;
  const key = Deno.env.get("MENU_KEY");
  if (!key || p.get("k") !== key) return json({ error: "forbidden" }, 403);
  const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { prepare: false, max: 1 });
  try {
    if (p.get("api") === "menu") {
      const rows = await sql`
        select mi.restaurant_code r, mi.restaurant_name rn, mi.menu_dt d, mi.meal m, mi.course c, mi.course_type ct, mi.name n, mi.coin, round(mi.kcal)::int k,
               mi.handmade hm, mi.tag tg, mi.photo p, mi.shelf sh, to_char(mi.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI"Z"') u,
               pr.price pr, pr.src ps, pr.cat pc, pr.title pt, pr.link pl, ms.first_dt fs
        from welstory.menu_item mi
        left join welstory.menu_seen ms on ms.key = welstory.menu_key(mi.name)
        left join welstory.menu_price pr on pr.name = regexp_replace(mi.name, '^[*[:space:]]*품절[[:space:]]*', '')
        where mi.takeout and mi.meal in ('1','3') and mi.menu_dt >= ${today()}
        order by mi.menu_dt, mi.meal, mi.course, mi.course_type, mi.seq`;
      return json(rows);
    }
    // 메뉴 하나의 시중가와 출처 — 지난 기록(REPORT)에서 가격 창을 열 때
    if (p.get("api") === "price") {
      const r = await sql`select price pr, src ps, title pt, link pl from welstory.menu_price where name = ${p.get("name") ?? ""}`;
      return json(r[0] ?? null);
    }
    if (p.get("api") === "state") {
      if (req.method === "POST") {
        const body = await req.text();
        if (body.length > 1_000_000) return json({ error: "too large" }, 413);
        const data = JSON.parse(body);
        await sql`insert into welstory.app_state (id, data, updated_at) values ('shared', ${sql.json(data)}, now())
                  on conflict (id) do update set data = excluded.data, updated_at = now()`;
        return json({ ok: true });
      }
      const r = await sql`select data from welstory.app_state where id = 'shared'`;
      return json({ data: r[0]?.data ?? null });
    }
    if (p.get("api") === "backfill") {
      const n = await backfill(sql, p.get("from") ?? addDays(today(), -10), Math.min(15, +(p.get("days") ?? 10)), (p.get("r") ?? "").split(",").filter(Boolean));
      return json({ ok: true, names: n });
    }
    if (p.get("api") === "photos") {
      const set = await fillPhotos(sql);
      await seenUpdate(sql);
      const price = await fillPrices(key, 40); // 새로 들어온 메뉴의 시중가도 이때 채운다(열쇠가 없으면 아무 일도 안 한다)
      console.log("photos", set, "price", JSON.stringify(price));
      return json({ ok: true, set, price });
    }
    // 페이지의 새로고침 버튼: 메뉴를 지금 다시 가져오고 사진까지 채운다. 2분 안에 또 누르면 건너뛴다.
    if (p.get("api") === "sync") {
      const r = await sql`select extract(epoch from now() - max(updated_at))::int age from welstory.menu_item where menu_dt >= ${today()}`;
      if (r[0]?.age != null && r[0].age < 120) return json({ ok: true, skipped: true });
      const res = await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/welstory-menu?k=${encodeURIComponent(key)}&sync=1&days=3`);
      if (!res.ok) return json({ error: `sync ${res.status}` }, 502);
      const set = await fillPhotos(sql);
      await seenUpdate(sql);
      const bg = fillPrices(key, 30); // 가격은 기다리지 않고 뒤에서 채운다
      (globalThis as any).EdgeRuntime?.waitUntil?.(bg);
      console.log("manual sync, photos", set);
      return json({ ok: true, set });
    }
    // 동시 접속 표시: 열려 있는 기기가 20초마다 알린다. 50초 안에 알린 다른 기기 수를 돌려준다.
    if (p.get("api") === "ping") {
      const id = (p.get("id") || "").slice(0, 40);
      if (!id) return json({ error: "id" }, 400);
      const now = Date.now();
      const r = await sql`
        insert into welstory.app_state (id, data, updated_at) values ('presence', jsonb_build_object(${id}::text, ${now}::bigint), now())
        on conflict (id) do update set updated_at = now(), data = coalesce(
          (select jsonb_object_agg(key, value) from jsonb_each(welstory.app_state.data) where (value #>> '{}')::bigint > ${now - 50_000}::bigint), '{}'::jsonb) || excluded.data
        returning data`;
      return json({ others: Object.keys(r[0].data).length - 1 });
    }
    return json({ error: "unknown api" }, 400);
  } catch (e) {
    console.error(e);
    return json({ error: (e as Error).message }, 500);
  } finally {
    await sql.end();
  }
});
