"""영어 문제지 PDF에서 지문을 한 문장씩 떼어 manifest에 넣는다 (OCR 없음 — PDF의 글자층을 그대로 읽음).

questions[].sentences : 그 문항에 딸린 지문 문장 목록 (18~40번처럼 문항마다 지문이 있는 것)
passages[].sentences  : 세트 지문 문장 목록 (41~45 장문)
사용: python tools/en_sentences.py <문제 PDF> <크롭 폴더>      (crop_batch가 영어 회차마다 부른다)
규칙: 문항 번호·한글 발문·[3점]을 떼고, 선지(①~) 앞·각주(* word: 뜻) 앞에서 자르고, 삽입 문제의 "( ① )" 표시를 지우고,
     줄 끝 하이픈을 잇고, 마침표·물음표·느낌표(닫는 따옴표 포함) 뒤 대문자 앞에서 끊는다. Mr./Dr./U.S./e.g. 같은 약어 뒤는 안 끊음.
"""
import json, os, re, sys
import pymupdf
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from crop_exam import RE_Q, detect_margins, segment, tight

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
ABBR = re.compile(r"\b(?:Mr|Mrs|Ms|Dr|Prof|St|Jr|Sr|vs|etc|e\.g|i\.e|No|U\.S|U\.K|Inc|Co|Ltd|a\.m|p\.m)\.$", re.I)


def clean(text, inline=False):
    """inline=True: 어법·어휘·무관한 문장·도표처럼 ①~⑤가 본문 안에 있는 문항 — 표시만 지우고 자르지 않는다."""
    t = " ".join(text.replace("\xad", "-").split())   # 소프트 하이픈(twenty-nine) → 보이는 하이픈
    t = re.sub(r"(\w)- (\w)", r"\1\2", t)                       # 줄 끝 하이픈 잇기
    t = re.sub(r"^\d{1,2}\s*[.．]\s*", "", t)                       # 문항 번호
    m = re.match(r"((?:[^?]*?[가-힣][^?]*?\?|.*?고르시오\.)\s*(?:\[\d점\])?)\s*", t)
    if m and re.search(r"[가-힣]", m[1]) and not re.search(r"[A-Z][a-z]+ [a-z]+ [a-z]+", m[1]):   # 한글 발문(영어 문장이 들어 있지 않을 때만)
        inline = inline or any(k in m[1] for k in ("어법", "낱말", "어휘", "흐름", "도표", "무관"))   # 발문으로도 판정(출제의도 문구가 회차마다 다름)
        t = t[m.end():]
    t = re.sub(r"\(\s*[①②③④⑤]\s*\)", "", t)                       # 삽입 문제의 자리 표시
    if inline: t = re.sub(r"\s*[①②③④⑤]\s*", " ", t)
    t = re.sub(r"\*+\s?[A-Za-z][\w\s’'()-]*?:\s*[^A-Za-z*①②③④⑤↓]*", " ", t)        # 각주 "* sage: 현자"는 어디에 있든 지운다(단 아래에 올 수 있음)
    for cut in (r"\s[①②③④⑤]", r"\s↓", r"\[\d점\]"):   # 선지·요약 상자·배점 앞에서 끝
        c = re.search(cut, t)
        if c: t = t[:c.start()]
    return t.strip()


def split(t):
    out, buf = [], ""
    for piece in re.split(r"(?:(?<=[.!?])|(?<=[.!?][\"”’)]))\s+(?=[\"“(\[]?[A-Z0-9])", t):
        buf = (buf + " " + piece).strip()
        if ABBR.search(buf) or re.search(r"\b[A-Z]\.$", buf):     # 약어·이니셜 뒤: 다음 조각과 잇기
            continue
        out.append(buf); buf = ""
    if buf: out.append(buf)
    # 순서 문제 (A)(B)(C) 표시가 홀로 남으면 다음 문장 앞에 붙인다
    res = []
    for s in out:
        if res and re.fullmatch(r"\([A-D]\)", res[-1]): res[-1] += " " + s
        else: res.append(s)
    return [s for s in res if len(s) > 1]


def run(pdf, folder):
    mf_path = os.path.join(folder, "manifest.json")
    mf = json.load(open(mf_path, encoding="utf-8"))
    doc = pymupdf.open(pdf)
    segs = segment(doc, detect_margins(doc, RE_Q, 2))
    texts = {}
    for seg in segs:
        t = ""
        for pno, rect in seg["pieces"]:
            r = tight(doc[pno], rect)
            if r and r.height >= 12: t += doc[pno].get_text(clip=r, sort=True) + "\n"
        texts[(seg["kind"], seg["label"])] = t
    for p in mf["passages"]:
        t = texts.get(("set", p["range"]), "")
        p["sentences"] = split(clean(re.sub(r"^\[\d+\s*[~～∼]\s*\d+\][^\n]*\n", "", t.strip())))   # "[41~42] 다음 글을 읽고…" 지시문 제거
    has_set = {p["range"] for p in mf["passages"] if p["sentences"]}
    for q in mf["questions"]:
        t = texts.get(("q", q["no"]), "")
        inline = any(k in q.get("intent", "") for k in ("어법", "어휘", "무관한", "도표"))
        q["sentences"] = split(clean(t, inline)) if q["no"] >= 18 and q.get("passage") not in has_set else []   # 장문은 세트 지문 문장을 쓴다
    json.dump(mf, open(mf_path, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    return mf


if __name__ == "__main__":
    mf = run(sys.argv[1], sys.argv[2])
    for q in mf["questions"]:
        if q["sentences"]: print(q["no"], len(q["sentences"]), "|", q["sentences"][0][:60], "…", q["sentences"][-1][-40:])
    for p in mf["passages"]:
        if p["sentences"]: print("set", p["range"], len(p["sentences"]), "|", p["sentences"][0][:60])
