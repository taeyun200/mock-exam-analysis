"""학평 해설지 PDF → 정답표 + 문항별 해설(이미지·글·출제의도) → 크롭 폴더의 manifest.json에 합치기

사용: python tools/crop_sol.py <해설.pdf> <크롭폴더(문제지 crop_exam 결과)>
규칙(EBSi 해설지 기준): 1쪽 상단 정답표("1 ② 2 ④ …", 단답형은 숫자), 본문은 3단, 문항 시작 = 단 여백의 "12. [출제의도] …",
  "[화법]" 같은 영역 제목 줄은 구분선. 해설 그림은 sol/q12.png(여러 조각이면 _2…), 글은 manifest에 저장.
"""
import json, os, re, sys, io
import pymupdf
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))  # python -I 로 실행해도 같은 폴더의 crop_exam을 찾도록
from crop_exam import tight, PAD, MARGIN_TOL

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
COLS, HEADER_Y = ((78, 304), (310, 530), (537, 765)), 165  # 경계선 x=307, 534 제외
RE_Q = re.compile(r"^(\d{1,2})\.\s*\[출제의도\]\s*(.*)")
RE_SECTION = re.compile(r"^\[[^\]]+\]\s*$")


def answers(page):
    """1쪽 정답표 블록 → {번호: 정답}. '①'은 선택형, 숫자는 단답형."""
    for b in page.get_text("blocks"):
        toks = b[4].replace("　", " ").split()
        if len(toks) >= 4 and toks[0] == "1" and toks[2] == "2":
            return {int(toks[i]): toks[i + 1] for i in range(0, len(toks) - 1, 2) if toks[i].isdigit()}
    return {}


def columns(page):
    blocks = [b for b in page.get_text("blocks") if b[6] == 0]
    footer = min((b[1] for b in blocks if re.fullmatch(r"\d+\n?", b[4])), default=page.rect.height - 100)
    body = [b for b in blocks if HEADER_Y <= b[1] < footer - 1 and b[4].strip()]
    out = []
    for x0, x1 in COLS:
        col = sorted([b for b in body if x0 <= b[0] < x1], key=lambda b: b[1])
        if col:
            out.append((pymupdf.Rect(x0, col[0][1] - PAD, x1, footer - PAD), col, min(b[0] for b in col)))
    return out


def crop(pdf, folder, zoom=2.5):
    doc = pymupdf.open(pdf)
    ans = answers(doc[0])
    mf_path = os.path.join(folder, "manifest.json")
    mf = json.load(open(mf_path, encoding="utf-8"))
    os.makedirs(os.path.join(folder, "sol"), exist_ok=True)

    segments, cur, expect = [], None, 1
    for pno, page in enumerate(doc):
        for rect, col, margin in columns(page):
            y = rect.y0
            for b in col:
                t = b[4].lstrip()
                m = RE_Q.match(t)
                if m and int(m[1]) == expect and abs(b[0] - margin) <= MARGIN_TOL:
                    if cur:
                        cur["pieces"].append((pno, pymupdf.Rect(rect.x0, y, rect.x1, b[1] - 2)))
                    cur = {"no": expect, "intent": m[2].strip(), "pieces": []}
                    segments.append(cur)
                    expect += 1
                    y = b[1] - 2
                elif RE_SECTION.match(t):  # 영역 제목: 직전 해설 끝
                    if cur:
                        cur["pieces"].append((pno, pymupdf.Rect(rect.x0, y, rect.x1, b[1] - 2)))
                    cur, y = None, b[3] + 2
            if cur:
                cur["pieces"].append((pno, pymupdf.Rect(rect.x0, y, rect.x1, rect.y1)))

    mat, by_no = pymupdf.Matrix(zoom, zoom), {q["no"]: q for q in mf["questions"]}
    for seg in segments:
        files, text = [], ""
        for pno, rect in seg["pieces"]:
            t = tight(doc[pno], rect)
            if not t or t.height < 12:
                continue
            name = f"q{seg['no']:02d}" + (f"_{len(files) + 1}" if files else "") + ".png"
            doc[pno].get_pixmap(matrix=mat, clip=t).save(os.path.join(folder, "sol", name))
            files.append("sol/" + name)
            text += doc[pno].get_text(clip=t)
        q = by_no.get(seg["no"])
        if q:
            q.update({"intent": seg["intent"], "sol_images": files, "sol_text": " ".join(text.split())})
    for no, a in ans.items():
        if no in by_no:
            by_no[no]["answer"] = a
    json.dump(mf, open(mf_path, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    missing = [q["no"] for q in mf["questions"] if "answer" not in q or not q.get("sol_images")]
    return ans, segments, missing


if __name__ == "__main__":
    ans, segs, missing = crop(sys.argv[1], sys.argv[2])
    print(f"정답 {len(ans)}개, 해설 {len(segs)}개, 누락: {missing or '없음'}")
    print(" ".join(f"{k}:{v}" for k, v in ans.items()))
