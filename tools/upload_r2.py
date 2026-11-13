"""크롭 결과를 그림 창고(R2 버킷 mock-exam-items)에 올린다. wrangler 로그인 세션을 쓰므로 키가 필요 없다.
사용: python tools/upload_r2.py [폴더이름 패턴...] [--sol]   (없으면 오답노트_크롭/* 전부. --sol 이면 해설 그림도)
키 = "<회차폴더>/<파일>" 예: 2026-10_고2_국어/q03.png, 2026-10_고2_국어/flow/set1-3_1.png, 2026-10_고2_국어/manifest.json
이미 올린 파일은 .r2_uploaded 목록으로 건너뛴다(파일 크기·수정시각이 같을 때).
"""
import os, sys, glob, json, subprocess

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
ROOT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "오답노트_크롭")
BUCKET = "mock-exam-items"
args = [a for a in sys.argv[1:] if not a.startswith("--")]
with_sol = "--sol" in sys.argv
pats = args or ["*"]
dirs = sorted({d for p in pats for d in glob.glob(os.path.join(ROOT, p)) if os.path.exists(os.path.join(d, "manifest.json"))})
done_path = os.path.join(ROOT, ".r2_uploaded")
done = set(open(done_path, encoding="utf-8").read().split("\n")) if os.path.exists(done_path) else set()
npx = "npx.cmd" if os.name == "nt" else "npx"
total = ok = skip = 0
for d in dirs:
    name = os.path.basename(d)
    files = ["manifest.json"] + sorted(f for f in os.listdir(d) if f.endswith(".png"))
    if os.path.isdir(os.path.join(d, "flow")): files += ["flow/" + f for f in sorted(os.listdir(os.path.join(d, "flow")))]
    if with_sol and os.path.isdir(os.path.join(d, "sol")): files += ["sol/" + f for f in sorted(os.listdir(os.path.join(d, "sol")))]
    for f in files:
        path = os.path.join(d, f); st = os.stat(path); tag = f"{name}/{f}\t{st.st_size}\t{int(st.st_mtime)}"
        total += 1
        if tag in done: skip += 1; continue
        r = subprocess.run([npx, "wrangler", "r2", "object", "put", f"{BUCKET}/{name}/{f}", "--file", path, "--remote"], capture_output=True)
        if r.returncode == 0:
            ok += 1; done.add(tag)
            open(done_path, "a", encoding="utf-8").write(tag + "\n")
        else:
            print("실패:", name, f, r.stderr.decode("utf-8", "replace")[-200:].strip())
    print(f"{name}: {len(files)}개 처리 (누적 올림 {ok}, 건너뜀 {skip})")
print(f"끝: 대상 {total}, 올림 {ok}, 건너뜀 {skip}")
