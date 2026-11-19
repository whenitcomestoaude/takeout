// takeout-price — 메뉴 이름별 시중가를 채운다 (welstory.menu_price). Claude API 사용.
// GET ?k=<MENU_KEY>&api=fill[&mode=search|est][&n=6][&part=0&parts=1][&secs=100][&model=…][&redo=<ISO 시각: 이보다 전에 채운 것을 다시>]
//      search: 기성품을 웹 검색으로 찾는다(한 번에 n개씩, secs 초 동안 되풀이).  est: 수제 메뉴를 검색 없이 어림한다.
//      mode 를 빼면 search 한 묶음 뒤 est 한 묶음.
// GET ?k=<MENU_KEY>&api=status        → 열쇠가 들어 있는지와 채워진 수
// POST ?k=<MENU_KEY>&api=set  {name, price|null} → 직접 고침(manual)
// 필요한 비밀 값: ANTHROPIC_API_KEY  (선택: PRICE_MODEL)
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import postgres from "npm:postgres@3.4.4";

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "content-type" };
const json = (v: unknown, status = 200) =>
  new Response(JSON.stringify(v), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...CORS } });
const today = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10).replace(/-/g, "");
const CATS = ["샌드위치", "샐러드", "핫밀", "밥·죽", "라이스", "컵라면", "누들", "빵", "냉동", "간식·요거트", "과일", "떡", "사이드", "음료"];
const MODEL = Deno.env.get("PRICE_MODEL") || "claude-haiku-5-5";
const CLEAN = "regexp_replace(name, '^[*[:space:]]*품절[[:space:]]*', '')";

type Item = { name: string; coin: number | null; course: string; hm: boolean };
type Ans = { price: number | null; found: boolean; title: string | null; url: string | null; cat: string | null };
type Use = { in: number; out: number; searches: number; calls: number };

let MODEL_NOW = MODEL;
async function claude(key: string, body: Record<string, unknown>, use: Use): Promise<string> {
  let messages = body.messages as any[];
  let text = "";
  for (let turn = 0; turn < 4; turn++) {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ ...body, messages }),
    });
    if (!res.ok) throw new Error(`claude ${res.status} ${(await res.text()).slice(0, 300)}`);
    const r = await res.json();
    use.calls++; use.in += r.usage?.input_tokens ?? 0; use.out += r.usage?.output_tokens ?? 0; use.searches += r.usage?.server_tool_use?.web_search_requests ?? 0;
    text = (r.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
    if (r.stop_reason !== "pause_turn") break;
    messages = [...messages, { role: "assistant", content: r.content }]; // 긴 검색은 받은 그대로 돌려보내 이어 간다
  }
  return text;
}
function parse(text: string, items: Item[]): Record<string, Ans> {
  // 답 안의 {"i": …} 객체를 하나씩 읽는다(앞뒤 설명, 코드 울타리, 잘린 끝에도 견디게)
  const out: Record<string, Ans> = {};
  for (const m of text.match(/\{[^{}]*"i"\s*:\s*\d+[^{}]*\}/g) ?? []) {
    let r: any; try { r = JSON.parse(m); } catch (_) { continue; }
    const it = items[r?.i]; if (!it) continue;
    const price = Number.isFinite(r.price) && r.price > 0 ? Math.round(r.price) : null;
    out[it.name] = { price, found: !!r.found && price != null, title: typeof r.title === "string" ? r.title.slice(0, 200) : null,
      url: typeof r.url === "string" && /^https?:\/\//.test(r.url) ? r.url.slice(0, 500) : null, cat: CATS.includes(r.cat) ? r.cat : null };
  }
  if (!Object.keys(out).length) console.log("unparsed:", text.slice(0, 300), "…", text.slice(-300));
  return out;
}
const RULES = `- price: 이 메뉴 한 개(식당에서 한 사람에게 나가는 1회 제공 단위)를 편의점·마트·매장에서 "낱개로" 살 때의 소비자 가격, 원 단위 정수.
  · 온라인 묶음·박스 최저가를 개수로 나눈 값은 낱개 가격보다 훨씬 싸므로 쓰지 않는다. 편의점(CU·GS25·세븐일레븐) 정가나 마트 낱개 가격을 우선한다. 묶음 가격밖에 없으면 편의점 낱개 가격 수준으로 올려 잡는다.
  · 용량은 1회 제공 단위로 본다: 음료는 캔·팩·컵 소용량(대개 180~300ml, 생수·탄산 500ml)이고 1L·1.5L 대용량이 아니다. 우유·두유는 190~200ml 팩.
  · 과일은 통째가 아니라 손질해 담은 1회분(자몽·오렌지·사과는 반 개쯤, 컵과일)이다. 편의점 컵과일·조각과일 가격을 참고한다.
  · 빵·베이커리는 파리바게뜨·뚜레쥬르 같은 프랜차이즈 베이커리의 비슷한 제품 가격을 참고한다.
  · 샌드위치·샐러드·김밥·도시락은 편의점·카페의 비슷한 제품 가격을 참고한다(Half·½ 는 그 절반쯤).
- 소스·드레싱처럼 값이 없는 곁들임(coin 이 null 이고 음료가 아님)은 price null.
- cat: 다음 중 가장 맞는 하나 — ${CATS.join(", ")}. 확신이 없으면 null.
- 설명이나 과정은 쓰지 말고, JSON 배열 하나만 출력(한 메뉴에 한 줄): [{"i": 번호, "price": 정수|null, "found": true|false, "title": 상품명|null, "url": 출처 주소|null, "cat": 분류|null}]`;

// 기성품: 웹 검색으로 실제 판매가를 찾는다. 못 찾으면 어림값(found=false).
async function searchBatch(items: Item[], key: string, use: Use) {
  const list = items.map((it, i) => ({ i, name: it.name, coin: it.coin, course: it.course }));
  const prompt = `한국 사내식당 테이크아웃 메뉴입니다. 대부분 편의점·마트에서 파는 기성품입니다. 각 메뉴의 시중 가격을 웹 검색으로 찾아 주세요.
- 메뉴마다 검색은 한 번(예: "상품명 편의점 가격"), 꼭 필요할 때만 한 번 더. 값이 없는 곁들임은 검색하지 않습니다.
- found: 검색 결과에서 같은 상품·같은 용량의 낱개 가격을 실제로 확인했으면 true. 묶음 가격에서 미루어 잡았거나 비슷한 상품으로 어림했으면 false (그래도 price 는 어림값으로 채움. 근거가 전혀 없으면 null).
- title, url: found 가 true 일 때 그 가격이 나온 상품명과 주소.
${RULES}
메뉴:
${JSON.stringify(list)}`;
  const text = await claude(key, { model: MODEL_NOW, max_tokens: 8000, messages: [{ role: "user", content: prompt }],
    tools: [{ type: "web_search_20250305", name: "web_search", max_uses: items.length + 3, user_location: { type: "approximate", country: "KR", timezone: "Asia/Seoul" } }] }, use);
  return parse(text, items);
}
// 수제: 검색 없이 편의점 기준으로 어림한다.
async function estBatch(items: Item[], key: string, use: Use) {
  const list = items.map((it, i) => ({ i, name: it.name, coin: it.coin, course: it.course }));
  const prompt = `한국 사내식당에서 직접 만든 테이크아웃 메뉴입니다. 편의점·카페·마트에서 비슷한 것을 살 때의 대략적인 가격을 어림해 주세요(100원 단위).
- found 는 항상 false, title 과 url 은 null.
${RULES}
메뉴:
${JSON.stringify(list)}`;
  return parse(await claude(key, { model: MODEL_NOW, max_tokens: 8000, messages: [{ role: "user", content: prompt }] }, use), items);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  const p = new URL(req.url).searchParams;
  const key = Deno.env.get("MENU_KEY");
  if (!key || p.get("k") !== key) return json({ error: "forbidden" }, 403);
  const ckey = Deno.env.get("ANTHROPIC_API_KEY");
  const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { prepare: false, max: 1 });
  try {
    const api = p.get("api");
    if (api === "status") {
      const r = await sql`select src, count(*)::int n from welstory.menu_price group by 1`;
      return json({ claude: !!ckey, model: MODEL, rows: Object.fromEntries(r.map((x) => [x.src, x.n])) });
    }
    if (api === "set" && req.method === "POST") {
      const b = JSON.parse(await req.text());
      const name = String(b.name ?? "").slice(0, 200); if (!name) return json({ error: "name" }, 400);
      const price = Number.isFinite(b.price) && b.price > 0 ? Math.round(b.price) : null;
      await sql`insert into welstory.menu_price (name, price, src, updated_at) values (${name}, ${price}, 'manual', now())
                on conflict (name) do update set price = excluded.price, src = 'manual', title = null, mall = null, link = null, updated_at = now()`;
      return json({ ok: true });
    }
    if (api === "fill") {
      if (!ckey) return json({ ok: false, need: ["ANTHROPIC_API_KEY"] });
      const t0 = Date.now(), secs = Math.min(125, Math.max(5, Number(p.get("secs")) || 100));
      const part = Math.max(0, Number(p.get("part")) || 0), parts = Math.max(1, Number(p.get("parts")) || 1);
      const modes = p.get("mode") ? [p.get("mode")!] : ["search", "est"];
      MODEL_NOW = p.get("model") || MODEL;
      const redo = p.get("redo") && !isNaN(Date.parse(p.get("redo")!)) ? new Date(p.get("redo")!).toISOString() : null;
      const use: Use = { in: 0, out: 0, searches: 0, calls: 0 };
      let done = 0, left = 0; const errs: string[] = [];
      const pick = (hm: boolean, n: number) => sql.unsafe(`
        select t.name, t.coin, t.course, t.hm from (
          select ${CLEAN} as name, max(coin) coin, max(course) course, bool_or(handmade) hm
          from welstory.menu_item where takeout and meal in ('1','3') and menu_dt >= $1 group by 1) t
        left join welstory.menu_price pr on pr.name = t.name
        where (pr.name is null or ($6::timestamptz is not null and pr.src <> 'manual' and pr.updated_at < $6::timestamptz)) and t.hm = $2 and abs(hashtext(t.name)) % $3 = $4
        order by t.name limit $5`, [today(), hm, parts, part, n, redo]);
      const store = async (items: Item[], ans: Record<string, Ans>) => {
        for (const it of items) {
          const a = ans[it.name]; if (!a) continue; // 답이 없으면 다음에 다시
          const src = a.price == null ? "none" : a.found ? "web" : "est";
          await sql`insert into welstory.menu_price (name, price, src, title, link, cat, updated_at)
            values (${it.name}, ${a.price}, ${src}, ${a.found ? a.title : null}, ${a.found ? a.url : null}, ${a.cat}, now())
            on conflict (name) do update set price = excluded.price, src = excluded.src, title = excluded.title, link = excluded.link,
              cat = coalesce(excluded.cat, welstory.menu_price.cat), updated_at = now()
            where welstory.menu_price.src <> 'manual'`;
          done++;
        }
      };
      for (const mode of modes) {
        const hm = mode === "est", n = Math.min(hm ? 40 : 10, Math.max(1, Number(p.get("n")) || (hm ? 30 : 6)));
        const once = modes.length > 1; // mode 를 안 줬으면 한 묶음씩만
        while ((Date.now() - t0) / 1000 < secs) {
          const rows = await pick(hm, n);
          if (!rows.length) break;
          const items: Item[] = rows.map((r: any) => ({ name: r.name, coin: r.coin, course: r.course ?? "", hm: !!r.hm }));
          const before = done;
          try { await store(items, hm ? await estBatch(items, ckey, use) : await searchBatch(items, ckey, use)); }
          catch (e) { errs.push((e as Error).message); break; }
          if (done === before) { errs.push("no answers parsed"); break; } // 같은 묶음을 헛돌지 않게
          if (once) break;
        }
      }
      const l = await sql.unsafe(`select count(*)::int n from (select ${CLEAN} as name from welstory.menu_item where takeout and meal in ('1','3') and menu_dt >= $1 group by 1) t
        left join welstory.menu_price pr on pr.name = t.name where pr.name is null or ($2::timestamptz is not null and pr.src <> 'manual' and pr.updated_at < $2::timestamptz)`, [today(), redo]);
      left = l[0].n;
      console.log("price fill", done, "left", left, JSON.stringify(use), errs.join(" | "));
      return json({ ok: !errs.length, model: MODEL_NOW, done, left, use, errs, secs: Math.round((Date.now() - t0) / 1000) });
    }
    return json({ error: "unknown api" }, 400);
  } catch (e) {
    console.error(e);
    return json({ error: (e as Error).message }, 500);
  } finally {
    await sql.end();
  }
});
