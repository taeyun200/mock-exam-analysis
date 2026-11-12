"""학평 문제지 PDF → 문항/세트지문 단위 PNG 크롭 + manifest.json + 검수용 preview.html

사용: python tools/crop_exam.py <문제지.pdf> <출력폴더> [--zoom 2.5]
규칙(2단 편집 EBSi 학평 PDF 기준):
  - 단 구분: x 73~417 왼쪽 단, 425~772 오른쪽 단, 그 외 오른쪽 단. 읽는 순서 = 왼쪽 위→아래, 오른쪽 위→아래, 다음 쪽.
  - 마커: 단 왼쪽 여백(x0 ≈ 85 / 431)에서 시작하는 "[1 ~ 3] …"(세트) 또는 "12. …"(문항, 번호가 직전+1일 때만).
  - 조각: 마커 ~ 다음 마커 직전. 단/쪽을 넘어가면 조각을 여러 장(…_2.png)으로 저장.
  - 각 조각은 실제 내용(글자·그림·선)의 테두리로 여백을 잘라냄.
"""
import json, re, sys, io
import pymupdf

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
COLS, PAD, MARGIN_TOL, HEADER_Y = ((73, 417), (425, 772)), 6, 3, 165  # 단 x범위(경계선 x=421 제외), 머리글("N 국어 영역" 띠) 아래부터 본문
RE_SET = re.compile(r"^\[(\d+)\s*[~～∼]\s*(\d+)\]")
RE_Q = re.compile(r"^(\d{1,2})\.\s")
RE_END = re.compile(r"^[※*\s]*확인\s*사항")  # 마지막 쪽 안내문: 여기서 끝


def columns(page):
    """페이지의 (단 사각형, 그 단의 텍스트 블록) 목록. 머리글·쪽번호 제외."""
    blocks = [b for b in page.get_text("blocks") if b[6] == 0]
    footer = min((b[1] for b in blocks if re.fullmatch(r"\d+\n\d+\n?", b[4])), default=page.rect.height - 100)
    body = [b for b in blocks if HEADER_Y <= b[1] < footer - 1 and b[4].strip()]
    out = []
    for x0, x1 in COLS:
        col = sorted([b for b in body if x0 <= b[0] < x1], key=lambda b: b[1])
        if not col:
            continue
        margin, top = min(b[0] for b in col), col[0][1]
        out.append((pymupdf.Rect(x0, top - PAD, x1, footer - PAD), col, margin))
    return out


def markers(col, margin, expect_q):
    """단 안의 마커 목록 [(y0, kind, label)]. kind = 'set' | 'q'."""
    res = []
    for b in col:
        t = b[4].lstrip()
        if RE_END.match(t):  # 안내문은 상자 안이라 여백 기준 없이 잡는다(상자 윗선 포함해 8pt 위에서 끊음)
            res.append((b[1] - 8, "end", None))
        elif abs(b[0] - margin) > MARGIN_TOL:
            continue
        elif m := RE_SET.match(t):
            res.append((b[1], "set", f"{m[1]}-{m[2]}"))
        elif (m := RE_Q.match(t)) and int(m[1]) == expect_q[0]:
            res.append((b[1], "q", int(m[1])))
            expect_q[0] += 1
    return res


def tight(page, rect):
    """rect 안의 실제 내용 테두리(글자·그림·선)만 남기고 여백 제거."""
    r = pymupdf.Rect()
    for b in page.get_text("blocks", clip=rect):
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


def crop(pdf, outdir, zoom=2.5):
    import os
    os.makedirs(outdir, exist_ok=True)
    doc = pymupdf.open(pdf)
    head = doc[0].get_text()
    m = re.search(r"(\d{4})학년도\s*(\d{1,2})월\s*고(\d)\s*전국연합학력평가", head)
    subj = re.search(r"(\S+)\s*영역", head)
    title = (m[0] + " " + subj[0]) if m and subj else head.split("\n")[0]
    exam = {"year": int(m[1]), "month": int(m[2]), "grade": int(m[3]), "subject": {"사회탐구": "사회", "과학탐구": "과학"}.get(subj[1], subj[1]) if subj else None} if m else {"title": title}

    # 1) 읽는 순서대로 조각 생성: 현재 열린 세그먼트에 (page, rect) 덧붙이기
    segments, cur, expect_q = [], None, [1]
    for pno, page in enumerate(doc):
        for rect, col, margin in columns(page):
            y = rect.y0
            for my, kind, label in markers(col, margin, expect_q):
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
        files = []
        for pno, rect in seg["pieces"]:
            t = tight(doc[pno], rect)
            if not t or t.height < 12:
                continue
            name = (f"set{seg['label']}" if seg["kind"] == "set" else f"q{seg['label']:02d}") + (f"_{len(files) + 1}" if files else "") + ".png"
            doc[pno].get_pixmap(matrix=mat, clip=t).save(os.path.join(outdir, name))
            files.append(name)
        if seg["kind"] == "set":
            cur_set = seg["label"]
            manifest["passages"].append({"range": cur_set, "images": files})
        else:
            lo, hi = map(int, cur_set.split("-")) if cur_set else (0, -1)
            manifest["questions"].append({"no": seg["label"], "passage": cur_set if lo <= seg["label"] <= hi else None, "images": files})
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


if __name__ == "__main__":
    a = sys.argv[1:]
    zoom = float(a[a.index("--zoom") + 1]) if "--zoom" in a else 2.5
    mf = crop(a[0], a[1], zoom)
    print(mf["exam"], "| 문항", len(mf["questions"]), "| 지문", [p["range"] for p in mf["passages"]])
    for q in mf["questions"]:
        print(q["no"], q["passage"] or "-", q["images"])
