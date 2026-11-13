"""폴더째 파싱: <폴더>/**/"N월 과목 문제.pdf" + 같은 자리 "N월 과목 정답.pdf"(해설지) → 오답노트_크롭/<연도-월_고N_과목>/

사용: python tools/crop_batch.py <폴더1> [<폴더2> ...]
회차·학년·과목은 문제지 1쪽 제목에서 읽는다(파일 이름은 짝 맞추기에만 씀). 끝에 점검표를 찍는다:
  문항 수·배점 합이 과목 기준(국45/100 수30/100 영45/100 한20/50 사25/50 과25/50)과 다르거나 정답·해설이 비면 ✗.
"""
import os, re, sys, json, glob, shutil, subprocess

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(os.path.dirname(HERE), "오답노트_크롭")
EXPECT = {"국어": (45, 100), "수학": (30, 100), "영어": (45, 100), "한국사": (20, 50), "사회": (25, 50), "과학": (25, 50)}


def run(script, *args):
    r = subprocess.run([sys.executable, "-I", os.path.join(HERE, script), *args], capture_output=True)
    return r.returncode, (r.stdout + r.stderr).decode("utf-8", "replace").strip()


def fill_answers(name, dst):
    """글자로 안 박힌 정답(수학 단답형 숫자 등)은 정답 DB 서버(official_items)에서 채운다. 서버가 없거나 회차가 없으면 그냥 둔다."""
    import json as _j, re as _r, urllib.request, urllib.parse
    mf = _j.load(open(os.path.join(dst, "manifest.json"), encoding="utf-8"))
    miss = [q for q in mf["questions"] if "answer" not in q]
    if not miss: return 0
    cfg = open(os.path.join(os.path.dirname(HERE), "wrangler.jsonc"), encoding="utf-8").read()
    url, key = _r.search(r'"SUPABASE_URL":\s*"([^"]+)"', cfg), _r.search(r'"SUPABASE_ANON_KEY":\s*"([^"]+)"', cfg)
    if not (url and key): return 0
    m = _r.match(r"(\d{4})-(\d{2})_고(\d)_(\S+)", name)
    q = f"official_items?select=q_no,answer&exam=eq.{int(m[1])}_{int(m[2])}&grade=eq.{m[3]}&subject=eq.{urllib.parse.quote(m[4])}"
    try:
        rows = _j.load(urllib.request.urlopen(urllib.request.Request(f"{url[1]}/rest/v1/{q}", headers={"apikey": key[1], "Authorization": "Bearer " + key[1], "user-agent": "crop_batch.py"}), timeout=20))
    except Exception:
        return 0
    db = {r["q_no"]: r["answer"] for r in rows if r.get("answer")}
    n = 0
    for qq in miss:
        if qq["no"] in db: qq["answer"] = str(db[qq["no"]]).strip(); n += 1
    if n: _j.dump(mf, open(os.path.join(dst, "manifest.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    return n


def main(folders):
    rows = []
    for folder in folders:
        for mun in sorted(glob.glob(os.path.join(folder, "**", "*문제.pdf"), recursive=True)):
            sol = mun.replace("문제.pdf", "정답.pdf")
            tmp = os.path.join(ROOT, "_batch_tmp")
            shutil.rmtree(tmp, ignore_errors=True)
            # 회차·학년·과목은 폴더/파일 이름에서(제목에 다른 연도가 섞인 PDF가 있어 이름이 더 믿을 만함): "2025 고1 학평 …/9월/9월 한국사 문제.pdf"
            top = os.path.basename(os.path.normpath(folder)); fn = os.path.basename(mun)
            ov = []
            if (y := re.search(r"(20\d\d)", top)) and (mo := re.search(r"(\d{1,2})월", fn)): ov += ["--exam", f"{y[1]}-{int(mo[1]):02d}"]
            if g := re.search(r"고(\d)", top): ov += ["--grade", g[1]]
            if sub := next((k for k in ("국어", "수학", "영어", "한국사", "통합사회", "통합과학", "사회", "과학") if k in fn), None):
                ov += ["--subject", {"통합사회": "사회", "통합과학": "과학"}.get(sub, sub)]
            rc, out = run("crop_exam.py", mun, tmp, *ov)
            if rc or not os.path.exists(os.path.join(tmp, "manifest.json")):
                rows.append((os.path.relpath(mun, folder), "✗ 문제지 파싱 실패: " + out[-160:].replace("\n", " "))); continue
            mf = json.load(open(os.path.join(tmp, "manifest.json"), encoding="utf-8"))
            e = mf["exam"]
            if "year" not in e:
                rows.append((os.path.relpath(mun, folder), "✗ 제목에서 회차·학년을 못 읽음: " + str(e))); continue
            name = f"{e['year']}-{e['month']:02d}_고{e['grade']}_{e['subject']}"
            dst = os.path.join(ROOT, name)
            if os.path.isdir(dst):   # 잠긴 폴더 대비: 지우지 않고 덮어쓴다
                for f in os.listdir(tmp):
                    s, d = os.path.join(tmp, f), os.path.join(dst, f)
                    if os.path.isdir(s): shutil.rmtree(d, ignore_errors=True); shutil.copytree(s, d)
                    else: shutil.copy2(s, d)
                shutil.rmtree(tmp, ignore_errors=True)
            else:
                os.rename(tmp, dst)
            note = ""
            if os.path.exists(sol):
                rc, out = run("crop_sol.py", sol, dst)
                if rc: note = " · 해설 실패: " + out[-120:].replace("\n", " ")
            else:
                note = " · 해설지 없음"
            filled = fill_answers(name, dst)
            if filled: note += f" · 정답 {filled}개는 정답 DB에서"
            mf = json.load(open(os.path.join(dst, "manifest.json"), encoding="utf-8"))
            qs = mf["questions"]
            n, pts = len(qs), sum(q.get("points") or 0 for q in qs)
            n_ans, n_sol = sum("answer" in q for q in qs), sum(bool(q.get("sol_images")) for q in qs)
            en, ep = EXPECT.get(e["subject"], (None, None))
            if e["subject"] in ("사회", "과학") and n == 20: en = 20   # 2025 3월 고1 탐구는 20문항 50점
            ok = n == en and abs(pts - ep) < 0.01 and n_ans == n and n_sol == n
            rows.append((name, f"{'✓' if ok else '✗'} 문항 {n}/{en} 배점 {pts:g}/{ep} 정답 {n_ans} 해설 {n_sol} 지문 {len(mf['passages'])}{note}"))
    w = max(len(r[0]) for r in rows)
    for name, msg in rows:
        print(f"{name:<{w}}  {msg}")
    print(f"\n{sum(m.startswith('✓') for _, m in rows)}/{len(rows)} 정상")


if __name__ == "__main__":
    main(sys.argv[1:])
