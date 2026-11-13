"""모든 크롭 폴더의 세트 지문을 미리 재배치(reflow)해 flow/*.png 로 만들고 manifest.json 의 passages[].flow 에 기록한다.
사이트(note.html)는 그림만 쓰므로 여기서 한 번 계산해 두면 브라우저에서 픽셀 분석을 할 필요가 없다.
사용: python tools/prepare_flow.py [폴더이름 패턴...]   (없으면 오답노트_크롭/* 전부)
"""
import os, sys, json, glob
from PIL import Image
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from reflow import reflow

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
ROOT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "오답노트_크롭")
pats = sys.argv[1:] or ["*"]
dirs = sorted({d for p in pats for d in glob.glob(os.path.join(ROOT, p)) if os.path.exists(os.path.join(d, "manifest.json"))})
for d in dirs:
    mp = os.path.join(d, "manifest.json")
    mf = json.load(open(mp, encoding="utf-8"))
    n = 0
    for p in mf["passages"]:
        pieces = [os.path.join(d, f) for f in p["images"]]
        if len(pieces) < 2:
            p["flow"] = p["images"]; continue
        os.makedirs(os.path.join(d, "flow"), exist_ok=True)
        W = max(Image.open(x).width for x in pieces)
        out = reflow(pieces, os.path.join(d, "flow", f"set{p['range']}"), col_h=int(W * 238 / 91))
        p["flow"] = [os.path.relpath(x, d).replace("\\", "/") for x in out]; n += 1
    json.dump(mf, open(mp, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print(f"{os.path.basename(d)}: 지문 {len(mf['passages'])}개 중 재배치 {n}개")
