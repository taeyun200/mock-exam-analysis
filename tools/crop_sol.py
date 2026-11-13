"""학평 해설지 PDF → 정답표 + 문항별 해설(이미지·글·출제의도) → 크롭 폴더의 manifest.json에 합치기

사용: python tools/crop_sol.py <해설.pdf> <크롭폴더(문제지 crop_exam 결과)>
규칙(EBSi 해설지): 1쪽 정답표("1 ② 2 ④ …", 단답형은 숫자. 여러 줄/블록으로 나뉘어도 1번부터 차례로 읽음),
  본문 3단(여백은 "12. [출제의도]" 줄 위치에서 알아냄), "16~17. [출제의도]"처럼 묶인 해설은 두 문항에 같이 넣음,
  "[화법]" 같은 영역 제목 줄은 구분선. 해설 그림은 sol/q12.png(여러 조각이면 _2…), 글은 manifest에 저장.
"""
import json, os, re, sys
import pymupdf
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))  # python -I 로 실행해도 같은 폴더의 crop_exam을 찾도록
from crop_exam import tight, lines, frame, detect_margins, col_rects, PAD, MARGIN_TOL, SKIP

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
RE_Q = re.compile(r"^(\d{1,2})(?:\s*[~～∼]\s*(\d{1,2}))?\s*[.．]?\s*\[[출츨]제\s*의도\]\s*(.*)")  # '츨제의도' 오타(2025-03 국어 20번)도 받음
RE_SECTION = re.compile(r"^\[[^\]]*[가-힣][^\]]*\]\s*$")  # 영역 제목 "[화법]": 한글이 들어가고 단 가운데쯤(여백에서 30pt 이상 안쪽). 듣기 지문의 "[Telephone rings.]"는 제외
RE_ANS = re.compile(r"^[①②③④⑤]$|^\d{1,3}$")
# 수학 해설지의 수식 글꼴은 숫자·기호가 사용자 영역 글자(U+E034…)로 박혀 있다. 2026-10 고2 정답표로 대조해 확인한 대응표.
PUA = str.maketrans("", "1234567890=+-()")


def answers(page, n_max=50, numeric_from=None):
    """1쪽 글자를 차례로 훑어 '번호 정답' 쌍을 1번부터 모은다. 표가 몇 줄·몇 블록으로 나뉘어도 된다.
    숫자 정답은 numeric_from(수학 단답형 22번) 이상에서만 받는다 — 쪽번호 "1 16" 같은 숫자 쌍을 정답으로 오인하지 않게."""
    toks = page.get_text().translate(PUA).replace("　", " ").split()
    out, expect, i = {}, 1, 0
    while i < len(toks) - 1:
        if toks[i] == str(expect):
            nxt = toks[i + 1]
            glue = str(expect + 1)   # "24 27025 7" 처럼 정답(270)과 다음 번호(25)가 붙은 경우
            if re.fullmatch(r"\d{4,6}", nxt) and nxt.endswith(glue) and len(nxt) > len(glue):
                toks[i + 1:i + 2] = [nxt[:-len(glue)], glue]
                nxt = toks[i + 1]
            if RE_ANS.match(nxt) and (not nxt.isascii() or (numeric_from and expect >= numeric_from)):  # 동그라미 숫자는 isdigit()가 참이라 isascii로 가른다
                out[expect] = nxt
                expect += 1
                i += 1   # 정답 토큰은 다음 번호 후보에서 뺀다 ("22 23 23 7": 22번 답 23, 23번 답 7)
                if expect > n_max:
                    break
        i += 1
    return out


def crop(pdf, folder, zoom=2.5):
    doc = pymupdf.open(pdf)
    mf_path = os.path.join(folder, "manifest.json")
    mf = json.load(open(mf_path, encoding="utf-8"))
    ans = answers(doc[0], numeric_from=22 if mf["exam"].get("subject") == "수학" else None)
    os.makedirs(os.path.join(folder, "sol"), exist_ok=True)
    margins = detect_margins(doc, RE_Q, 3)
    segments, cur, expect = [], None, 1
    for pno, page in enumerate(doc):
        ls = lines(page)
        for (x0, x1), margin in zip(col_rects(page.rect.width, margins), margins):
            top, bottom = frame(page, ls, x0, x1)
            col = [l for l in ls if x0 <= l[0] < x1 and top <= l[1] < bottom]
            if not col:
                continue
            rect = pymupdf.Rect(x0, min(l[1] for l in col) - PAD, x1, bottom - PAD)
            y = rect.y0
            for lx0, ly0, lx1, ly1, t in col:
                t = t.lstrip()
                m = RE_Q.match(t)
                if m and expect <= int(m[1]) <= expect + (SKIP if abs(lx0 - margin) <= MARGIN_TOL else 0) and abs(lx0 - margin) <= 12:
                    if cur:
                        cur["pieces"].append((pno, pymupdf.Rect(rect.x0, y, rect.x1, ly0 - 2)))
                    nos = list(range(int(m[1]), int(m[2] or m[1]) + 1))
                    cur = {"nos": nos, "intent": m[3].strip(), "pieces": []}
                    segments.append(cur)
                    expect = nos[-1] + 1
                    y = ly0 - 2
                elif RE_SECTION.match(t) and lx0 - margin > 30:  # 영역 제목: 직전 해설 끝
                    if cur:
                        cur["pieces"].append((pno, pymupdf.Rect(rect.x0, y, rect.x1, ly0 - 2)))
                    cur, y = None, ly1 + 2
            if cur:
                cur["pieces"].append((pno, pymupdf.Rect(rect.x0, y, rect.x1, rect.y1)))

    mat, by_no = pymupdf.Matrix(zoom, zoom), {q["no"]: q for q in mf["questions"]}
    for seg in segments:
        files, text = [], ""
        for pno, rect in seg["pieces"]:
            t = tight(doc[pno], rect)
            if not t or t.height < 12:
                continue
            name = f"q{seg['nos'][0]:02d}" + (f"_{len(files) + 1}" if files else "") + ".png"
            doc[pno].get_pixmap(matrix=mat, clip=t).save(os.path.join(folder, "sol", name))
            files.append("sol/" + name)
            text += doc[pno].get_text(clip=t).translate(PUA)
        for no in seg["nos"]:
            if no in by_no:
                by_no[no].update({"intent": seg["intent"], "sol_images": files, "sol_text": " ".join(text.split())})
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
