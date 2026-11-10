#!/usr/bin/env python3
"""아티팩트 페이지(takeout/index.html)에 독립 실행용 머리와 연결부(prelude.js)를 씌워 index.html 을 만든다."""
import pathlib, sys
here = pathlib.Path(__file__).parent
src = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else here.parent / "takeout" / "index.html").read_text()
src = src.replace("이 화면에서는 메뉴를 불러올 수 없습니다. Claude 앱이나 claude.ai에서 열어주세요.", "열쇠가 없어 메뉴를 불러올 수 없어요.")
head = """<!doctype html><html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes"><meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<meta name="apple-mobile-web-app-title" content="happeachne takeout">
<meta name="theme-color" content="#ffffff"><meta name="robots" content="noindex,nofollow">
<link rel="apple-touch-icon" href="icon.png"><link rel="icon" href="icon.png">
<style>:root{color-scheme:light;padding:env(safe-area-inset-top,0px) 0 env(safe-area-inset-bottom,0px)}body{margin:0;font:14px -apple-system,system-ui,sans-serif}img{max-width:100%}[hidden]{display:none!important}</style>
<script>
""" + (here / "prelude.js").read_text() + "</script></head><body>\n"
(here / "index.html").write_text(head + src + "\n</body></html>\n")
print("built", len(head + src))
