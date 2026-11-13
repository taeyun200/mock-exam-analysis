"""오답노트 v2 — 메타인지 분석형 (docs/오답노트_양식_제안.md 설계)

사용: python tools/note_v2.py <크롭폴더> 3,4,7 [--mine 3=4,4=4] [--sid 2-1-1] [--name 홍길동] [--out 파일.html]
구성: 표지(오답 요약) → 세트 지문은 "지문 페이지"로 따로(국어·영어) → 문항 카드(그림 + 확신도·다시 풀기·원인 태그·한 줄 원인·근거·다음에·복습) → 시험 성찰(exam wrapper)
원인 태그는 문항의 영역(EBSi 분류)별로 다르다. 영역 정보는 manifest 에 없으므로 --units <json> 으로 {번호: 영역} 을 주거나, 없으면 과목 공통 태그.
"""
import json, os, sys, html

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

TAGS = {
    "독서": ["정보 못 찾음(사실)", "추론 과잉·부족", "선지 덫: 주체 바꿈", "선지 덫: 범위·정도", "선지 덫: 인과 역전", "지문에 없는 내용", "<보기> 적용 실패", "시간 부족"],
    "문학": ["화자·인물·상황 파악", "표현·서술 특징 오판", "<보기> 관점으로 못 읽음", "시어·구절 의미 오해", "갈래 지식 부족", "선지 과잉 해석"],
    "화법·작문": ["조건 누락", "자료 활용 방식 오해", "발화 의도 오독", "고쳐쓰기 기준 혼동", "시간 부족"],
    "문법": ["개념 모름", "개념 혼동(둘을 바꿈)", "예시 적용 실패", "<보기> 설명 오독"],
    "국어": ["지문 오독", "선지 오독", "<보기> 적용", "개념 부족", "시간 부족", "찍음"],
    "수학": ["문제 읽기(조건 누락)", "무엇을 구하는지 오해", "식 세우기", "계산·절차", "답 표기(단답형)", "개념 모름", "공식 혼동", "시간 부족"],
    "영어": ["어휘", "구문", "글의 논리(주제·흐름)", "선지 덫(부분 일치)", "유형 전략 없음", "시간 부족"],
    "사회": ["개념 혼동", "사례→개념 연결 실패", "자료(표·그래프) 해석", "보기 ㄱㄴㄷ 하나 오판", "사상가·관점 혼동", "시간 부족"],
    "과학": ["개념 모름", "개념 혼동", "자료·실험 해석", "계산·단위", "보기 ㄱㄴㄷ 하나 오판", "조건 누락"],
    "한국사": ["시기 혼동", "인물·사건 연결 실패", "사료 해석", "선지 키워드 함정", "지도·자료 읽기"],
}
EVIDENCE = {  # 영역별 근거 칸
    "독서": "정답 근거 문장 [&nbsp;&nbsp;]문단 [&nbsp;&nbsp;]번째 &nbsp;·&nbsp; 내가 고른 선지에서 틀린 말: <u>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</u>",
    "문학": "내 선지의 틀린 곳: ○앞(상황·대상) ○뒤(효과·의미) &nbsp;·&nbsp; 근거 구절: <u>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</u>",
    "화법·작문": "문제의 조건을 번호로: ①____ ②____ ③____ &nbsp;·&nbsp; 놓친 조건: [&nbsp;&nbsp;]",
    "문법": "규칙을 내 말로 한 줄: <u>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</u>",
}
NAT = {"A": "80%↑", "B": "60~80", "C": "40~60", "D": "20~40", "E": "20%↓"}
CIRC = {str(i + 1): c for i, c in enumerate("①②③④⑤")}

CSS = """
@page{size:A4;margin:12mm 12mm 14mm}
*{box-sizing:border-box} body{font-family:"Malgun Gothic",system-ui,sans-serif;color:#1f2937;margin:0;background:#f3f4f6;font-size:12px}
.pg{width:186mm;min-height:270mm;margin:14px auto;background:#fff;padding:9mm 8mm;box-shadow:0 2px 8px #0002;page-break-after:always;break-after:page}
@media print{body{background:#fff}.pg{margin:0;box-shadow:none;min-height:0;padding:0}.noprint{display:none}}
h1{font-size:19px;color:#1e3a5f;margin:0 0 2px} .sub{color:#6b7280;margin-bottom:10px}
table{border-collapse:collapse;width:100%} th,td{border:1px solid #cbd5e1;padding:4px 6px;text-align:center;font-size:11.5px} th{background:#eef2f7} td.l,th.l{text-align:left}
.who{font-size:12px;text-align:right;margin-bottom:4px} .who span{display:inline-block;min-width:60px;border-bottom:1px solid #777;padding:0 4px}
.psg h2{font-size:14px;margin:0 0 6px;color:#1e3a5f;border-left:4px solid #1e3a5f;padding-left:8px}
.psg .pieces{display:flex;flex-wrap:wrap;gap:5mm;align-items:flex-start} .psg img{width:87mm;max-height:238mm;object-fit:contain;object-position:top;display:block;break-inside:avoid}
.psg .note{margin-top:6px;color:#6b7280;font-size:11px}
.card{border:1px solid #cbd5e1;border-radius:6px;margin-bottom:5mm;break-inside:avoid;page-break-inside:avoid;overflow:hidden}
.card .hd{background:#1e3a5f;color:#fff;padding:4px 9px;display:flex;gap:10px;align-items:center;font-size:12.5px} .hd .tag{opacity:.85;font-weight:normal;font-size:11px} .hd .ans{margin-left:auto;font-size:11.5px} .hd b{background:#fff;color:#1e3a5f;border-radius:10px;padding:0 7px;margin-left:3px}
.card .bd{display:grid;grid-template-columns:58% 42%;gap:0} .card .q{padding:6px 8px;border-right:1px dashed #cbd5e1} .card .q img{width:100%;display:block;margin-bottom:4px}
.card .f{padding:6px 8px;font-size:11px} .f .row{margin:0 0 5px} .f .k{font-weight:700;color:#1e3a5f;margin-right:4px} .f .tags span{display:inline-block;border:1px solid #cbd5e1;border-radius:9px;padding:0 6px;margin:1px 2px 1px 0;font-size:10.5px}
.f .line{border-bottom:1px solid #9ca3af;height:16px} .f .line2{border-bottom:1px solid #9ca3af;height:16px;margin-top:4px}
.meta{font-size:10.5px;color:#6b7280;padding:0 8px 4px}
.wrap h2{font-size:14px;color:#1e3a5f;margin:14px 0 6px} .wrap .box{border:1px solid #cbd5e1;border-radius:4px;min-height:22mm;padding:6px;color:#6b7280;font-size:11px;margin-bottom:6px}
.noprint{text-align:center;margin:10px;font-size:13px}
"""


def build(folder, wrong, mine=None, sid="", name="", out=None, units=None):
    mf = json.load(open(os.path.join(folder, "manifest.json"), encoding="utf-8"))
    e, qs = mf["exam"], {q["no"]: q for q in mf["questions"]}
    ps = {p["range"]: p for p in mf["passages"]}
    subj = e.get("subject", "")
    title = f"{e['year']}학년도 {e['month']}월 고{e['grade']} 전국연합학력평가 {subj}"
    mine, units = mine or {}, units or {}
    # --units 값은 "영역" 또는 {"area": "영역", "nat": "C"} (전국 정답률 구간). nat 는 manifest 에 없으면 여기서 채운다
    U = {int(k): (v if isinstance(v, dict) else {"area": v}) for k, v in units.items()}
    area_of = lambda no: U.get(no, {}).get("area") or subj
    for no, u in U.items():
        if no in qs and u.get("nat"): qs[no]["nat"] = u["nat"]
    tags_of = lambda no: TAGS.get(area_of(no)) or TAGS.get(subj) or []
    sep_passage = subj in ("국어", "영어")

    # 표지
    rows = "".join(f"<tr><td>{no}</td><td class=l>{html.escape(area_of(no))}</td><td>{num(qs[no].get('points'))}</td><td>{NAT.get(qs[no].get('nat', ''), '')}</td>"
                   f"<td>{mine.get(no, '')}</td><td>{qs[no].get('answer', '')}</td><td>○확신 ○반반 ○찍음</td><td></td></tr>" for no in wrong)
    cover = (f"<div class=pg><div class=who>학년/반/번호 <span>{html.escape(sid)}</span> 이름 <span>{html.escape(name)}</span></div>"
             f"<h1>{title} 오답노트</h1><div class=sub>오답 {len(wrong)}문항 · 문항마다 ①그때 확신도 ②답 가리고 다시 풀기 ③원인 태그(최대 2개) ④한 줄 원인 ⑤근거 ⑥다음에 할 것 ⑦복습 체크</div>"
             f"<table><tr><th>번호</th><th class=l>영역</th><th>배점</th><th>전국 정답률</th><th>내 답</th><th>정답</th><th>그때 확신도</th><th>원인 태그</th></tr>{rows}</table>"
             f"<p class=meta style='margin-top:8px'>전국 정답률은 성적통지표 구간(A 80% 이상 … E 20% 미만). '확신'인데 틀린 문항부터 복습하면 효과가 크다.</p></div>")

    # 본문: 세트별로 지문 페이지 → 문항 카드
    body, done = [], set()
    def card(no):
        q = qs[no]; area = area_of(no)
        meta = f"{html.escape(area)}" + (f" · {html.escape(q['intent'])}" if q.get("intent") else "")
        nat = f" · 전국 {q['nat']} {NAT[q['nat']]}" if q.get("nat") in NAT else ""
        imgs = "".join(f'<img src="{f}">' for f in q["images"])
        tags = "".join(f"<span>□ {html.escape(t)}</span>" for t in tags_of(no))
        ev = EVIDENCE.get(area, "정답 근거: <u>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</u> · 내 답이 틀린 이유: <u>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</u>")
        psg = f" <span class=tag>지문 [{q['passage']}] 페이지 참고</span>" if q.get("passage") and sep_passage else ""
        return (f"<section class=card><div class=hd>{no}번 <span class=tag>{num(q.get('points'))}점 · {meta}{nat}</span>{psg}"
                f"<span class=ans>내 답<b>{mine.get(no, '&nbsp;')}</b> 정답<b>{q.get('answer', '&nbsp;')}</b></span></div>"
                f"<div class=bd><div class=q>{imgs}</div><div class=f>"
                f"<div class=row><span class=k>① 그때 확신도</span> ○ 확신 &nbsp;○ 반반 &nbsp;○ 찍음</div>"
                f"<div class=row><span class=k>② 다시 풀기</span> 답 가리고 → ○ 맞음 &nbsp;○ 틀림 &nbsp;<span style='color:#6b7280'>(맞으면 실수형)</span></div>"
                f"<div class='row tags'><span class=k>③ 원인</span>{tags}</div>"
                f"<div class=row><span class=k>④ 한 줄 원인</span><span style='color:#9ca3af'>어디서 어떻게 ('실수' 금지)</span><div class=line></div></div>"
                f"<div class=row><span class=k>⑤ 근거</span><div style='margin-top:3px'>{ev}</div></div>"
                f"<div class=row><span class=k>⑥ 다음에</span><div class=line></div></div>"
                f"<div class=row><span class=k>⑦ 복습</span> □ 당일(맞/틀) &nbsp;□ 3일(맞/틀) &nbsp;□ 7일(맞/틀)</div>"
                f"</div></div></section>")
    cards_in_page = []
    def flush():
        if cards_in_page:
            body.append("<div class=pg>" + "".join(cards_in_page) + "</div>"); cards_in_page.clear()
    for no in wrong:
        q = qs[no]
        if sep_passage and q.get("passage") and q["passage"] not in done:
            done.add(q["passage"]); flush()
            in_set = [n for n in wrong if qs[n].get("passage") == q["passage"]]
            pieces = "".join(f'<img src="{f}">' for f in ps[q["passage"]]["images"])
            body.append(f"<div class='pg psg'><h2>지문 [{q['passage']}]</h2><div class=note>이 지문에서 틀린 문항: {', '.join(map(str, in_set))}번 · 근거 문장에 번호를 매기며 다시 읽기</div><div class=pieces>{pieces}</div></div>")
        cards_in_page.append(card(no))
        if len(cards_in_page) == 2: flush()
    flush()

    # 시험 성찰
    wrap = ("<div class='pg wrap'><h1>시험 성찰</h1><div class=sub>이 회차 전체를 돌아보는 반 쪽. 오답노트를 다 쓴 뒤에 적는다.</div>"
            "<h2>1. 준비</h2><div class=box>이 과목을 어떻게, 얼마나 준비했나 (방법 · 시간)</div>"
            "<h2>2. 시험 중</h2><div class=box>시간 배분은 어땠나 · 찍은 문항 수 ___ · '확신'인데 틀린 문항 수 ___ · 끝까지 못 푼 문항 ___</div>"
            "<h2>3. 원인 집계</h2><div class=box>위 카드의 ③원인 태그를 세어 가장 많은 것 두 개: 1) ________ 2) ________ · 지난 회차와 같은 태그가 있나? ○예 ○아니오</div>"
            "<h2>4. 다음 시험까지 바꿀 것 두 가지</h2><div class=box>1)<br><br>2)</div></div>")
    page = (f"<!doctype html><html lang=ko><meta charset=utf-8><title>{title} 오답노트</title><style>{CSS}</style><body>"
            f"<div class=noprint><button onclick=print()>🖨 인쇄 / PDF 저장</button></div>{cover}{''.join(body)}{wrap}</body></html>")
    out = out or os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(folder))) if os.path.basename(os.path.dirname(os.path.abspath(folder))) == "오답노트_크롭" else os.path.dirname(os.path.abspath(folder)), "오답노트_샘플", f"{os.path.basename(os.path.normpath(folder))}_{sid or '샘플'}.html")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    rel = os.path.relpath(os.path.abspath(folder), os.path.dirname(os.path.abspath(out))).replace("\\", "/")   # 그림은 크롭 폴더에 그대로, HTML 만 샘플 폴더로
    page = page.replace('src="', f'src="{rel}/')
    open(out, "w", encoding="utf-8").write(page)
    return out


def num(v):
    return "" if v is None else (f"{v:g}" if isinstance(v, (int, float)) else str(v))


def kv(s):
    return {int(k): CIRC.get(v, v) for k, v in (x.split("=") for x in s.split(","))} if s else {}


if __name__ == "__main__":
    a = sys.argv[1:]
    opt = lambda k: a[a.index(k) + 1] if k in a else None
    units = json.load(open(opt("--units"), encoding="utf-8")) if opt("--units") else None
    print(build(a[0], [int(x) for x in a[1].split(",")], kv(opt("--mine")), opt("--sid") or "", opt("--name") or "", opt("--out"), units))
