"""학평 문제지 PDF → 문항/세트지문 단위 PNG 크롭 + manifest.json + 검수용 preview.html

사용: python tools/crop_exam.py <문제지.pdf> <출력폴더> [--zoom 2.5] [--exam 2025-09 --grade 1 --subject 사회]
규칙(EBSi 학평 PDF, 2단 편집. 쪽 크기(A3/A4/Letter)·여백은 회차마다 달라서 줄 위치에서 알아낸다):
  - 단 여백: "12. …" 문항 줄의 x0 를 모아 가장 많은 두 값 = 왼쪽·오른쪽 단 여백. 읽는 순서 = 왼쪽 위→아래, 오른쪽 위→아래, 다음 쪽.
  - 마커: 단 여백에서 시작하는 "[1 ~ 3] …"(세트) 또는 "12. …"(문항, 번호가 직전+1 ~ +3일 때만 → 한두 개 놓쳐도 이어감).
  - 머리글(제목·"N 국어 영역" 띠·교시·수험번호)·쪽번호·마지막 쪽 "확인 사항"·수학 "단답형" 제목은 뺀다.
  - 조각: 마커 ~ 다음 마커 직전. 단/쪽을 넘어가면 여러 장(…_2.png). 각 조각은 글자·그림·선의 테두리로 여백을 잘라냄.
"""
import json, re, sys, os
from collections import Counter
import pymupdf

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
PAD, MARGIN_TOL, SKIP = 6, 3, 2
RE_SET = re.compile(r"^\[(\d+)\s*[~～∼]\s*(\d+)\]")
RE_Q = re.compile(r"^(\d{1,2})\s*[.．](\s|$)")  # "36." 처럼 번호만 있는 줄도 문항 시작
RE_END = re.compile(r"^[※*\s]*확인\s*사항|^(단답형|주관식|서답형)\s*$")
RE_HEAD = re.compile(r"학년도\s*\d+\s*월|학력평가|^제\s*\d\s*교시|영역\s*(\(\S+\))?\s*\d*$|^(성명|수험번호)|^고\d\s*$|정답\s*및\s*해설|^•.*•\s*$")
RE_PAGENO = re.compile(r"^\d+(\s*[/|]\s*\d+)?$")
SUBJECTS = ("국어", "수학", "영어", "한국사", "사회", "과학")


def lines(page):
    """텍스트 줄 목록 [(x0, y0, x1, y1, text)] — 블록이 합쳐져도 줄 단위로 마커를 잡기 위해. 글자 크기는 BIG 에 따로 모은다."""
    out = []
    for b in page.get_text("dict")["blocks"]:
        for l in b.get("lines", []):
            t = "".join(s["text"] for s in l["spans"])
            if t.strip():
                x0, y0, x1, y1 = l["bbox"]
                out.append((x0, y0, x1, y1, t))
                if max(s["size"] for s in l["spans"]) >= 18: BIG.add((round(x0, 1), round(y0, 1)))
    return sorted(out, key=lambda l: (l[1], l[0]))


BIG = set()   # 큰 글자 줄(머리글 띠의 "국어 영역"·쪽번호 "7"): 위치로 기억해 frame 에서 머리글로 친다


def frame(page, ls, x0=None, x1=None):
    """(머리글 아래 y, 쪽번호 위 y). x0~x1 을 주면 그 단에 든 머리글 줄만 본다(해설지 1쪽은 제목이 1단에만 있고 2·3단은 위에서부터 본문)."""
    H = page.rect.height
    foot = min((l[1] for l in ls if l[1] > H * 0.85 and RE_PAGENO.match(l[4].strip())), default=H * 0.93)
    col = [l for l in ls if x0 is None or x0 <= l[0] < x1]
    # 머리글: 위쪽 15% 안의 제목·"N 국어 영역" 띠·교시·쪽번호(표 안 숫자가 걸리지 않게 쪽번호는 위 8%만)
    head = max((l[3] for l in col if l[3] < H * 0.2 and (RE_HEAD.search(l[4].strip()) or (l[3] < H * 0.08 and RE_PAGENO.match(l[4].strip()))
                or ((round(l[0], 1), round(l[1], 1)) in BIG and RE_PAGENO.match(l[4].strip())))), default=0)   # 큰 글자 쪽번호(홀수 쪽 오른쪽 위 "7")도 머리글
    return head + 1, foot - 1


def detect_margins(doc, rx, n):
    """rx 에 맞는 줄들의 x0 를 모아 가장 흔한 n개(=단 여백)를 오름차순으로."""
    c = Counter()
    for page in doc:
        for l in lines(page):
            if rx.match(l[4].lstrip()):
                c[round(l[0] / 4) * 4] += 1
    tops = sorted(x for x, _ in c.most_common(n))
    return [min((l[0] for p in doc for l in lines(p) if abs(l[0] - x) <= 4 and rx.match(l[4].lstrip())), default=x) for x in tops]


def col_rects(W, margins):
    """단 여백 → 단 사각형 x범위. 경계선(다음 단 여백 10pt 왼쪽)은 제외."""
    out = []
    for i, m in enumerate(margins):
        x1 = margins[i + 1] - 14 if i + 1 < len(margins) else W - (margins[0] - 12)
        out.append((m - 12, x1))
    return out


def columns(page, margins):
    """[(단 사각형, 그 단의 줄 목록, 여백 x)]"""
    ls = lines(page)
    out = []
    for (x0, x1), m in zip(col_rects(page.rect.width, margins), margins):
        top, bottom = frame(page, ls, x0, x1)
        col = [l for l in ls if x0 <= l[0] < x1 and top - 3 <= l[1] < bottom]   # 머리글 띠와 본문이 1~2pt 겹치는 회차(2025-10 수학 14번)가 있어 3pt 여유
        if col:
            out.append((pymupdf.Rect(x0, min(l[1] for l in col) - PAD, x1, bottom - PAD), col, m))
    return out


def markers(col, margin, expect):
    """단 안의 마커 [(y0, kind, label)]. kind = set | q | end. expect 는 [다음 문항 번호] (갱신됨)."""
    res = []
    for x0, y0, x1, y1, t in col:
        t = t.lstrip()
        if RE_END.match(t):
            res.append((y0 - 8, "end", None))
        elif abs(x0 - margin) > 12:
            continue
        elif (m := RE_SET.match(t)) and abs(x0 - margin) <= MARGIN_TOL:
            res.append((y0, "set", f"{m[1]}-{m[2]}"))
        elif (m := RE_Q.match(t)) and expect[0] <= int(m[1]) <= expect[0] + (SKIP if abs(x0 - margin) <= MARGIN_TOL else 0):
            # 여백에 딱 붙은 번호는 한두 개 건너뛰어도 받고, 살짝 들여쓴 번호("37. "가 11pt 안쪽인 회차가 있음)는 정확히 다음 번호일 때만
            res.append((y0, "q", int(m[1])))
            expect[0] = int(m[1]) + 1
    return res


def tight(page, rect):
    """rect 안의 실제 내용 테두리(글자·그림·선)만 남기고 여백 제거."""
    r = pymupdf.Rect()
    for b in page.get_text("blocks", clip=rect):
        if rect.y0 <= (b[1] + b[3]) / 2 <= rect.y1:   # 세로 중심이 조각 안에 있는 블록만(경계에 걸친 머리글·쪽번호 제외)
            r |= pymupdf.Rect(b[:4])
    for d in page.get_drawings():
        if d["rect"].intersects(rect) and d["rect"].width < rect.width * 1.2:
            r |= d["rect"] & rect
    for info in page.get_image_info():
        ir = pymupdf.Rect(info["bbox"])
        if ir.intersects(rect):
            r |= ir & rect
    if r.is_empty:
        return None
    return pymupdf.Rect(rect.x0, max(rect.y0, r.y0 - PAD), rect.x1, min(rect.y1, r.y1 + PAD))


def identify(doc, override):
    """회차·학년·과목: 인자로 받은 값 우선, 없으면 1쪽 제목에서."""
    head = doc[0].get_text()
    m = re.search(r"(\d{4})\s*학년도\s*(\d{1,2})\s*월\s*고\s*(\d)", head)
    area = next((l for l in head.split("\n") if "영역" in l), "")
    s = next((k for k in SUBJECTS if k in area), None)
    e = {"year": int(m[1]), "month": int(m[2]), "grade": int(m[3])} if m else {}
    if s: e["subject"] = s
    if override.get("exam"):
        y, mo = override["exam"].split("-"); e.update(year=int(y), month=int(mo))
    if override.get("grade"): e["grade"] = int(override["grade"])
    if override.get("subject"): e["subject"] = override["subject"]
    return e


def crop(pdf, outdir, zoom=2.5, override={}):
    os.makedirs(outdir, exist_ok=True)
    doc = pymupdf.open(pdf)
    exam = identify(doc, override)
    title = f"{exam.get('year', '?')}학년도 {exam.get('month', '?')}월 고{exam.get('grade', '?')} 전국연합학력평가 {exam.get('subject', '?')}"
    margins = detect_margins(doc, RE_Q, 2)
    if len(margins) < 2:
        raise SystemExit("문항 줄을 찾지 못해 단 여백을 정할 수 없습니다: " + pdf)

    # 1) 읽는 순서대로 조각 생성
    segments, cur, expect = [], None, [1]
    for pno, page in enumerate(doc):
        for rect, col, margin in columns(page, margins):
            y = rect.y0
            for my, kind, label in markers(col, margin, expect):
                if cur:
                    cur["pieces"].append((pno, pymupdf.Rect(rect.x0, y, rect.x1, my - 2)))
                cur = {"kind": kind, "label": label, "pieces": []} if kind != "end" else None
                if cur:
                    segments.append(cur)
                y = my - 2
            if cur:
                cur["pieces"].append((pno, pymupdf.Rect(rect.x0, y, rect.x1, rect.y1)))

    # 2) 렌더링
    mat, manifest, cur_set = pymupdf.Matrix(zoom, zoom), {"exam": exam, "passages": [], "questions": []}, None
    for seg in segments:
        files, text = [], ""
        for pno, rect in seg["pieces"]:
            t = tight(doc[pno], rect)
            if not t or t.height < 12:
                continue
            text += doc[pno].get_text(clip=t)
            name = (f"set{seg['label']}" if seg["kind"] == "set" else f"q{seg['label']:02d}") + (f"_{len(files) + 1}" if files else "") + ".png"
            doc[pno].get_pixmap(matrix=mat, clip=t).save(os.path.join(outdir, name))
            files.append(name)
        if seg["kind"] == "set":
            cur_set = seg["label"]
            manifest["passages"].append({"range": cur_set, "images": files})
        else:
            lo, hi = map(int, cur_set.split("-")) if cur_set else (0, -1)
            pts = re.search(r"\[(\d(?:\.\d)?)점\]", text)  # 배점 표시 없으면 2점(국어·영어·한국사 기본)
            manifest["questions"].append({"no": seg["label"], "passage": cur_set if lo <= seg["label"] <= hi else None, "images": files,
                                          "points": float(pts[1]) if pts else 2, "text": " ".join(text.split())[:120]})
    json.dump(manifest, open(os.path.join(outdir, "manifest.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)

    # 3) 검수용 미리보기
    cards = []
    for p in manifest["passages"]:
        cards.append(f"<div class=c><h3>지문 [{p['range']}]</h3>" + "".join(f"<img src='{f}'>" for f in p["images"]) + "</div>")
    for q in manifest["questions"]:
        cards.append(f"<div class=c><h3>{q['no']}번" + (f" <small>지문 {q['passage']}</small>" if q["passage"] else "") + "</h3>" + "".join(f"<img src='{f}'>" for f in q["images"]) + "</div>")
    open(os.path.join(outdir, "preview.html"), "w", encoding="utf-8").write(
        f"<!doctype html><meta charset=utf-8><title>{title}</title><style>body{{font-family:sans-serif;background:#eee}}"
        ".c{background:#fff;margin:12px auto;padding:10px;max-width:760px;box-shadow:0 1px 3px #0003}img{width:100%;display:block;border:1px dashed #c33;margin-bottom:6px}"
        f"h3{{margin:0 0 6px;font-size:14px}}</style><h2>{title}</h2><p>문항 {len(manifest['questions'])}개 · 지문 {len(manifest['passages'])}개</p>" + "".join(cards))
    return manifest


def opts(a):
    return {k: a[a.index("--" + k) + 1] for k in ("exam", "grade", "subject", "zoom") if "--" + k in a}


if __name__ == "__main__":
    a = sys.argv[1:]
    o = opts(a)
    mf = crop(a[0], a[1], float(o.get("zoom", 2.5)), o)
    print(mf["exam"], "| 문항", len(mf["questions"]), "| 지문", [p["range"] for p in mf["passages"]])
    for q in mf["questions"]:
        print(q["no"], q["passage"] or "-", q["images"])
