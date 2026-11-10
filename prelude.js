// 독립 페이지용 연결부: 아티팩트의 claude.use(...) 자리에 Supabase 함수(takeout-api)를 직접 부르는 구현을 끼운다.
// 열쇠는 코드에 없다 — 주소 끝의 #k=... 에서 읽고, 이 기기에 기억해 둔다.
(() => {
  const API = "https://omigzdxdxywtjsfzimks.supabase.co/functions/v1/takeout-api";
  let k = (location.hash.match(/k=([^&]+)/) || [])[1] || "";
  try { if (k) localStorage.setItem("takeout-key", k); else k = localStorage.getItem("takeout-key") || ""; } catch (_) {}
  const url = (api) => `${API}?k=${encodeURIComponent(k)}&api=${api}`;
  const j = async (r) => {
    if (!r.ok) { const e = new Error(`HTTP ${r.status}`); e.code = r.status === 403 ? "열쇠가 맞지 않아요" : `HTTP ${r.status}`; throw e; }
    return r.json();
  };
  const ns = {
    mcp: { callTool: async () => ({ payload: [{ j: await j(await fetch(url("menu"), { cache: "no-store" })) }] }),
      sync: async () => j(await fetch(url("sync"), { cache: "no-store" })),
      setPrice: async (name, price) => j(await fetch(`${API.replace("takeout-api", "takeout-price")}?k=${encodeURIComponent(k)}&api=set`, { method: "POST", body: JSON.stringify({ name, price }) })),
      ping: async (id) => j(await fetch(`${url("ping")}&id=${encodeURIComponent(id)}`, { cache: "no-store" })) }, // 새로고침 버튼: 식당 메뉴를 지금 다시 받아 온다
    user: { id: async () => "shared" },
    db: { doc: () => ({
      get: async () => { const d = (await j(await fetch(url("state"), { cache: "no-store" }))).data; return { exists: !!d, data: () => d }; },
      set: async (v) => { await j(await fetch(url("state"), { method: "POST", body: JSON.stringify(v) })); }, // 글자 본문 = 사전 요청 없는 단순 POST
    }) },
    // 이미지는 iPhone 공유 시트로 바로 넘긴다
    downloads: { save: async ({ filename, data }) => {
      const f = new File([data], filename, { type: "image/png" });
      const err = (code) => Object.assign(new Error(code), { code });
      if (!navigator.canShare || !navigator.canShare({ files: [f] })) throw err("unavailable");
      try { await navigator.share({ files: [f] }); return { status: "saved" }; }
      catch (e) { throw err(e && e.name === "AbortError" ? "declined" : "unavailable"); }
    } },
  };
  window.claude = { use: async (n) => (k ? ns[n] || null : null) };

  // 열쇠 없이 열렸을 때: 열쇠(또는 열쇠가 붙은 주소)를 한 번 붙여 넣게 한다
  if (!k) addEventListener("DOMContentLoaded", () => {
    const box = document.createElement("div");
    box.style.cssText = "position:fixed;inset:0;z-index:99;background:#fff;display:grid;place-content:center;gap:12px;padding:24px;font:400 15px -apple-system,system-ui,sans-serif;color:#1D1B14;text-align:center";
    box.innerHTML = `<b style="font-size:17px">열쇠가 필요해요</b><span style="color:rgba(29,27,20,.5);font-size:13px">받은 주소 전체나 열쇠를 붙여 넣어 주세요</span>
      <input id="kin" autocomplete="off" autocapitalize="off" style="font:inherit;padding:12px 14px;border-radius:12px;border:0;background:rgba(29,27,20,.06);width:min(280px,80vw);text-align:center">
      <button id="kgo" style="font:600 15px inherit;padding:12px;border-radius:999px;border:0;background:#5B5121;color:#fff">열기</button>`;
    document.body.appendChild(box);
    box.querySelector("#kgo").addEventListener("click", () => {
      const v = box.querySelector("#kin").value.trim(), m = v.match(/k=([^&\s]+)/);
      const key = m ? m[1] : v; if (!key) return;
      try { localStorage.setItem("takeout-key", key); } catch (_) {}
      location.hash = `k=${key}`; location.reload();
    });
  });

  // 다시 앞으로 꺼냈을 때 오래됐으면 새로 읽는다 — 상대가 고른 것과 새 메뉴가 보이게
  let hiddenAt = 0;
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) hiddenAt = Date.now();
    else if (hiddenAt && Date.now() - hiddenAt > 60_000) location.reload();
  });
})();
