"""크롭 결과를 그림 창고(R2 버킷 mock-exam-items)에 올린다. wrangler 로그인 세션을 쓰므로 키가 필요 없다.

파일 5,800개를 하나씩 올리면 한 개에 4초라 너무 느려서, 회차 폴더마다 무압축 zip 한 개로 묶어 올린다:
  <폴더>.zip        그림 전부(ZIP_STORED, 압축 안 함 → Worker가 바이트 범위만 잘라 꺼냄)
  <폴더>/index.json  { "q01.png": [zip 안 시작 위치, 길이], ... }
  <폴더>/manifest.json
사용: python tools/upload_r2.py [폴더이름 패턴...]   (없으면 오답노트_크롭/* 전부). 이미 올린 폴더(.r2_uploaded 기록, 내용 변경 없음)는 건너뜀.
"""
import os, sys, glob, json, zipfile, hashlib, subprocess, tempfile

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
ROOT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "오답노트_크롭")
BUCKET = "mock-exam-items"
pats = [a for a in sys.argv[1:] if not a.startswith("--")] or ["*"]
LOCAL = "--local" in sys.argv   # 로컬 개발 서버(wrangler dev --local)의 R2 흉내에 넣을 때
dirs = sorted({d for p in pats for d in glob.glob(os.path.join(ROOT, p)) if os.path.exists(os.path.join(d, "manifest.json"))})
done_path = os.path.join(ROOT, ".r2_uploaded" + ("_local" if "--local" in sys.argv else ""))
done = dict(l.split("\t") for l in open(done_path, encoding="utf-8").read().split("\n") if "\t" in l) if os.path.exists(done_path) else {}
npx = "npx.cmd" if os.name == "nt" else "npx"


def put(key, path):
    r = subprocess.run([npx, "wrangler", "r2", "object", "put", f"{BUCKET}/{key}", "--file", path, "--local" if LOCAL else "--remote"], capture_output=True)
    if r.returncode: raise RuntimeError(r.stderr.decode("utf-8", "replace")[-300:])


def files_of(d):
    out = sorted(f for f in os.listdir(d) if f.endswith(".png"))
    for sub in ("flow", "sol"):
        if os.path.isdir(os.path.join(d, sub)): out += [sub + "/" + f for f in sorted(os.listdir(os.path.join(d, sub))) if f.endswith(".png")]
    return out


tmp = tempfile.mkdtemp()
for d in dirs:
    name, files = os.path.basename(d), files_of(d)
    sig = hashlib.md5("\n".join(f"{f}:{os.path.getsize(os.path.join(d, f))}" for f in files + ["manifest.json"]).encode()).hexdigest()
    if done.get(name) == sig:
        print(f"{name}: 변경 없음, 건너뜀"); continue
    zp = os.path.join(tmp, name + ".zip")
    with zipfile.ZipFile(zp, "w", zipfile.ZIP_STORED) as z:
        for f in files: z.write(os.path.join(d, f), f)
    index = {}
    with zipfile.ZipFile(zp) as z:
        for info in z.infolist():
            with open(zp, "rb") as fh:   # 로컬 헤더: 30바이트 + 이름 길이 + 추가 필드 길이 → 그 뒤가 데이터
                fh.seek(info.header_offset + 26); n, e = int.from_bytes(fh.read(2), "little"), int.from_bytes(fh.read(2), "little")
            index[info.filename] = [info.header_offset + 30 + n + e, info.file_size]
    ip = os.path.join(tmp, "index.json"); json.dump(index, open(ip, "w", encoding="utf-8"), ensure_ascii=False)
    try:
        put(f"{name}.zip", zp); put(f"{name}/index.json", ip); put(f"{name}/manifest.json", os.path.join(d, "manifest.json"))
    except RuntimeError as e:
        print(f"{name}: 실패 {e}"); continue
    done[name] = sig
    open(done_path, "w", encoding="utf-8").write("\n".join(f"{k}\t{v}" for k, v in done.items()))
    print(f"{name}: 그림 {len(files)}개 ({os.path.getsize(zp) / 1e6:.1f} MB) 올림")
    os.remove(zp)
print("끝")
