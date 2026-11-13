"""크롭 결과(manifest.json)의 정답·배점을 정답 DB 서버(official_items)에 채운다. 없는 행은 만들고, 있는 행은 answer·points만 갱신(정답률 difficulty는 그대로).

사용:  set SUPABASE_SERVICE_KEY=<쓰기 키>   (한 번만, 같은 창에서)
       python tools/fill_official.py 2025-03_고1_국어 2025-06_고1_*   (폴더 이름, * 가능. 없으면 2025* 전부)
올리기 전에 서버에 이미 있는 정답과 대조해서 하나라도 다르면 올리지 않는다.
"""
import os, re, sys, json, glob, urllib.request

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(os.path.dirname(HERE), "오답노트_크롭")
cfg = open(os.path.join(os.path.dirname(HERE), "wrangler.jsonc"), encoding="utf-8").read()
URL = re.search(r'"SUPABASE_URL":\s*"([^"]+)"', cfg)[1] + "/rest/v1/official_items"
KEY = os.environ.get("SUPABASE_SERVICE_KEY") or sys.exit("환경변수 SUPABASE_SERVICE_KEY 가 없습니다 (정답 DB 서버 쓰기 키)")
H = {"apikey": KEY, "Authorization": "Bearer " + KEY, "user-agent": "fill_official.py", "content-type": "application/json"}
circ = {"①": "1", "②": "2", "③": "3", "④": "4", "⑤": "5"}
norm = lambda a: circ.get(str(a).strip(), str(a).strip())

pats = sys.argv[1:] or ["2025*"]
dirs = sorted({d for p in pats for d in glob.glob(os.path.join(ROOT, p)) if os.path.exists(os.path.join(d, "manifest.json"))})
rows = []
for d in dirs:
    m = re.match(r"(\d{4})-(\d{2})_고(\d)_(\S+)", os.path.basename(d))
    mf = json.load(open(os.path.join(d, "manifest.json"), encoding="utf-8"))
    for q in mf["questions"]:
        if "answer" in q:
            rows.append({"exam": f"{int(m[1])}_{int(m[2])}", "grade": int(m[3]), "subject": m[4], "q_no": q["no"], "answer": q["answer"], "points": q["points"]})
print(f"폴더 {len(dirs)}개 → {len(rows)}행")

exams = sorted({r["exam"] for r in rows})
cur = []
for ex in exams:
    cur += json.load(urllib.request.urlopen(urllib.request.Request(f"{URL}?select=exam,grade,subject,q_no,answer,points&exam=eq.{ex}&limit=2000", headers=H)))
old = {(r["exam"], r["grade"], r["subject"], r["q_no"]): r for r in cur}
key = lambda r: (r["exam"], r["grade"], r["subject"], r["q_no"])
bad = [(key(r), r["answer"], old[key(r)]["answer"]) for r in rows if key(r) in old and old[key(r)]["answer"] and norm(r["answer"]) != norm(old[key(r)]["answer"])]
print(f"서버 기존 행 {sum(key(r) in old for r in rows)}건과 정답 대조 → 불일치 {bad or '없음'}")
if bad:
    sys.exit("불일치가 있어 올리지 않습니다. 해설지 정답표와 서버 값을 확인하세요.")
for i in range(0, len(rows), 500):
    chunk = rows[i:i + 500]
    r = urllib.request.urlopen(urllib.request.Request(URL, data=json.dumps(chunk).encode(), headers={**H, "Prefer": "resolution=merge-duplicates"}, method="POST"))
    print(f"올림 {i + 1}~{i + len(chunk)} HTTP {r.status}")
chk = []
for ex in exams:
    chk += json.load(urllib.request.urlopen(urllib.request.Request(f"{URL}?select=exam,grade,subject,points,answer,difficulty&exam=eq.{ex}&limit=2000", headers=H)))
agg = {}
for r in chk:
    a = agg.setdefault((r["exam"], r["grade"], r["subject"]), [0, 0, 0, 0]); a[0] += 1; a[1] += r["points"] or 0; a[2] += bool(r["answer"]); a[3] += bool(r["difficulty"])
for k in sorted(agg):
    n, p, a, d = agg[k]
    print(f"{k[0]:<8}고{k[1]} {k[2]:<4} 행 {n:>2} 배점합 {p:>5g} 정답 {a:>2} 정답률 {d:>2}")
