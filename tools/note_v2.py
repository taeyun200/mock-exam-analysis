"""오답노트 v2 — 메타인지 분석형 (docs/오답노트_양식_제안.md + 2026-11-13 피드백 반영)

사용: python tools/note_v2.py <크롭폴더> 3,4,7 [--mine 3=4,4=4] [--sid 2-1-1] [--name 홍길동] [--units <json>] [--out 파일.html]
      python tools/note_v2.py <크롭폴더> --api <GET /api/note 응답 json> [--name 홍길동]   ← 사이트에서 받은 재료로(틀린 문항 전부 / 1등급 업)
구성: 표지 → 세트 지문 페이지(국어·영어) → 문항 1개 = 1쪽(문항 그림 · 선지별 정리 · 확신도 · 원인 목록 · 해설 정리 · EBS 강의 정리) → 시험 성찰
인쇄: 모든 쪽이 A4 고정 크기(186×270mm, 넘치면 잘림)라 PDF 저장 시 밀리지 않는다. 브라우저 인쇄 여백은 '기본'으로 둘 것.
"""
import json, os, sys, html
from PIL import Image
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from reflow import reflow

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

TAGS = {
    "독서": ["지문에서 정보를 못 찾음 (사실적 이해)", "추론을 과하게 했거나 못 함", "선지 덫: 주체·대상을 바꿈", "선지 덫: 범위·정도를 과장", "선지 덫: 인과·순서를 뒤집음", "지문에 없는 내용을 맞다고 봄", "<보기>를 지문에 적용 못 함", "시간이 부족해 대충 읽음"],
    "문학": ["화자·인물·상황 파악 실패", "표현·서술상 특징 오판", "<보기>의 관점으로 못 읽음", "시어·구절 의미 오해", "갈래 지식 부족", "선지를 과하게 해석"],
    "화법·작문": ["문제의 조건을 빠뜨림", "자료 활용 방식 오해", "발화 의도·맥락 오독", "고쳐쓰기 기준 혼동", "시간 부족"],
    "문법": ["개념을 모름", "개념 둘을 혼동", "개념은 아는데 예시 적용 실패", "<보기> 설명을 잘못 읽음"],
    "국어": ["지문 오독", "선지 오독", "<보기> 적용 실패", "개념 부족", "시간 부족", "찍음"],
    "수학": ["문제 읽기(조건 누락)", "무엇을 구하는지 오해", "식 세우기 실패", "계산·절차 실수", "답 표기(단답형)", "개념 모름", "공식 혼동", "시간 부족"],
    "영어": ["어휘: 핵심 단어 뜻을 모름", "구문: 긴 문장 구조를 못 봄", "논리: 주제·흐름을 놓침", "선지 덫: 부분 일치·과장", "유형 전략 없음(빈칸·순서·삽입·어법)", "시간 부족·대충 읽음"],
    "사회": ["개념 혼동", "사례→개념 연결 실패", "자료(표·그래프) 해석 실패", "보기 ㄱㄴㄷ 중 하나 오판", "사상가·관점 혼동", "시간 부족"],
    "과학": ["개념 모름", "개념 혼동", "자료·실험 해석 실패", "계산·단위 실수", "보기 ㄱㄴㄷ 중 하나 오판", "조건(단, ~) 누락"],
    "한국사": ["시기 혼동", "인물·사건 연결 실패", "사료 해석 실패", "선지 키워드 함정", "지도·자료 읽기 실패"],
}
NAT = {"A": "80%↑", "B": "60~80", "C": "40~60", "D": "20~40", "E": "20%↓"}
CIRC = {str(i + 1): c for i, c in enumerate("①②③④⑤")}

CSS = """
@page{size:A4;margin:12mm}
*{box-sizing:border-box} html,body{margin:0;padding:0}
body{font-family:"Malgun Gothic",system-ui,sans-serif;color:#1f2937;background:#f3f4f6;font-size:12px;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.pg{width:186mm;height:270mm;overflow:hidden;margin:14px auto;background:#fff;padding:0;box-shadow:0 2px 8px #0002;page-break-after:always;break-after:page;display:flex;flex-direction:column}
.pg:last-child{page-break-after:auto;break-after:auto}
@media print{body{background:#fff}.pg{margin:0;box-shadow:none}.noprint{display:none}}
h1{font-size:18px;color:#1e3a5f;margin:0 0 2px} .sub{color:#6b7280;margin-bottom:8px;font-size:11px}
table{border-collapse:collapse;width:100%} th,td{border:1px solid #cbd5e1;padding:3px 5px;text-align:center;font-size:11px} th{background:#eef2f7} td.l,th.l{text-align:left}
.who{font-size:12px;text-align:right;margin-bottom:4px} .who span{display:inline-block;min-width:60px;border-bottom:1px solid #777;padding:0 4px}
.psg h2{font-size:14px;margin:0 0 4px;color:#1e3a5f;border-left:4px solid #1e3a5f;padding-left:8px} .psg .note{color:#6b7280;font-size:11px;margin-bottom:5px}
.psg .pieces{display:flex;gap:4mm;align-items:flex-start} .psg img{width:91mm;max-height:248mm;object-fit:contain;object-position:top left;display:block}
.hd{background:#1e3a5f;color:#fff;padding:5px 9px;display:flex;gap:10px;align-items:center;font-size:12.5px;border-radius:4px}
.hd .tag{opacity:.85;font-weight:normal;font-size:11px} .hd .ans{margin-left:auto;font-size:11.5px} .hd b{background:#fff;color:#1e3a5f;border-radius:10px;padding:0 7px;margin-left:3px}
.top{display:flex;gap:4mm;margin:5px 0 3px;min-height:92mm;align-items:stretch}
.top .qimg{width:101mm;flex:none} .top .qimg img{width:101mm;max-height:128mm;object-fit:contain;object-position:top left;display:block}   /* 문항은 항상 같은 배율(원본 단 폭=101mm). 아주 긴 문항만 128mm에서 축소 */
.top .box{flex:1}
.sec{font-weight:700;color:#1e3a5f;font-size:12px;margin:5px 0 3px} .sec small{font-weight:normal;color:#6b7280;margin-left:6px}
table.ch td{height:9mm;vertical-align:middle} table.ch td.w{text-align:left} table.ch .me{background:#fdecec} table.ch .ok{background:#e8f5ec;font-weight:700}
.conf{font-size:12px;margin:4px 0 2px} .conf span{display:inline-block;margin-right:14px}
ol.cause{columns:2;column-gap:8mm;margin:0;padding-left:0;list-style:none;font-size:11.5px} ol.cause li{break-inside:avoid;margin:1px 0}
.boxes{display:flex;gap:4mm;flex:1;min-height:0;margin-top:3px} .box{flex:1;border:1px solid #cbd5e1;border-radius:4px;padding:5px 7px;display:flex;flex-direction:column}
.box .t{font-weight:700;color:#1e3a5f;font-size:11.5px;margin-bottom:2px} .box .t small{font-weight:normal;color:#6b7280;margin-left:4px}
.box .lines{flex:1;display:flex;flex-direction:column;justify-content:space-between} .box .lines i{display:block;border-bottom:1px solid #cbd5e1;height:0}
.wrap h2{font-size:14px;color:#1e3a5f;margin:12px 0 5px} .wrap .box2{border:1px solid #cbd5e1;border-radius:4px;min-height:34mm;padding:6px;color:#6b7280;font-size:11px}
.noprint{text-align:center;margin:10px;font-size:13px}
.chk{font-size:11.5px;line-height:1.7} .chk div{border-bottom:1px dotted #cbd5e1} .chk u{display:inline-block;min-width:9mm;border-bottom:1px solid #777;text-decoration:none}
table.voc td{height:9mm} .box ol.cause{columns:1} .box .sec{margin:4px 0 2px}
"""


def build(folder, wrong, mine=None, sid="", name="", out=None, units=None, leap=None):
    mf = json.load(open(os.path.join(folder, "manifest.json"), encoding="utf-8"))
    e, qs = mf["exam"], {q["no"]: q for q in mf["questions"]}
    ps = {p["range"]: p for p in mf["passages"]}
    subj = e.get("subject", "")
    title = f"{e['year']}학년도 {e['month']}월 고{e['grade']} 전국연합학력평가 {subj}"
    mine, units = mine or {}, units or {}
    U = {int(k): (v if isinstance(v, dict) else {"area": v}) for k, v in units.items()}   # --units: "영역" 또는 {"area","nat"}
    area_of = lambda no: U.get(no, {}).get("area") or subj
    for no, u in U.items():
        if no in qs and u.get("nat"): qs[no]["nat"] = u["nat"]
    tags_of = lambda no: TAGS.get(area_of(no)) or TAGS.get(subj) or []
    if subj == "영어": wrong = [n for n in wrong if n > 17]   # 듣기(1~17)는 오답노트에서 뺀다
    sep_passage = subj in ("국어", "영어")
    is_mc = lambda q: str(q.get("answer", "")) in CIRC.values()

    # 표지. leap = {my_score, my_grade, target_grade, ref_n, ref_rate:{번호: 기준 집단 정답률}} 이면 "1등급 업" 모드
    rr = (leap or {}).get("ref_rate", {})
    refcol = "<th>위 등급 정답률</th>" if leap else ""
    rows = "".join(f"<tr><td>{no}</td><td class=l>{html.escape(area_of(no))}</td><td>{num(qs[no].get('points'))}</td><td>{NAT.get(qs[no].get('nat', ''), '')}</td>"
                   + (f"<td>{'' if rr.get(no) is None else f'{rr[no] * 100:.0f}%'}</td>" if leap else "")
                   + f"<td>{mine.get(no, '')}</td><td>{qs[no].get('answer', '')}</td><td>○확신 ○반반 ○찍음</td><td></td></tr>" for no in wrong)
    if leap:
        head = (f"<h1>{title} 오답노트 — 1등급 업</h1><div class=sub>내 원점수 {num(leap['my_score'])}점 · <b>{leap['my_grade']}등급</b> → 목표 <b>{leap['target_grade']}등급</b> (기준 집단 {leap['ref_n']}명). "
                f"기준 집단은 대부분 맞히는데 내가 틀린 문항 {len(wrong)}개를 그 정답률 순으로 모았다. 이 문항들을 잡으면 한 등급이 오른다.</div>")
    else:
        what = '읽기가 끊긴 곳을 찾고, 지문을 해석하고, 단어를 정리하고' if subj == '영어' else '선지별로 왜 맞고 틀리는지 적고'
        head = f"<h1>{title} 오답노트</h1><div class=sub>오답 {len(wrong)}문항{' (듣기 제외)' if subj == '영어' else ''} · 문항마다 한 쪽: {what}, 원인 유형을 고르고, 해설과 EBS 강의 내용을 내 말로 정리한다.</div>"
    sheet = subj == "영어"   # 한 문항 = 한 장(양면). 표지·지문 쪽은 짝수로 맞춰 문항이 늘 앞면에서 시작하게 한다
    BLANK = "<div class=pg><div class=sub>메모</div></div>"
    cover = (f"<div class=pg><div class=who>학년/반/번호 <span>{html.escape(sid)}</span> 이름 <span>{html.escape(name)}</span></div>{head}"
             f"<table><tr><th>번호</th><th class=l>영역</th><th>배점</th><th>전국 정답률</th>{refcol}<th>내 답</th><th>정답</th><th>그때 확신도</th><th>원인 번호</th></tr>{rows}</table>"
             f"<p class=sub style='margin-top:8px'>전국 정답률은 성적통지표 구간(A 80% 이상 … E 20% 미만). '확신'인데 틀린 문항부터 정리한다.</p></div>" + (BLANK if sheet else ""))

    def card(no):
        q = qs[no]; area = area_of(no)
        meta = html.escape(area) + (f" · {html.escape(q['intent'])}" if q.get("intent") else "")
        nat = (f" · 전국 {q['nat']} {NAT[q['nat']]}" if q.get("nat") in NAT else "") + (f" · 위 등급 정답률 {rr[no] * 100:.0f}%" if rr.get(no) is not None else "")
        psg = f" <span class=tag>지문 [{q['passage']}] 쪽 참고</span>" if q.get("passage") in done else ""
        imgs = "".join(f'<img src="{f}">' for f in q["images"])
        ans, my = str(q.get("answer", "")), str(mine.get(no, ""))
        if is_mc(q):
            kind = "가장 적절한 것 (나머지 4개가 왜 틀렸는지)" if "않은" not in q.get("text", "") else "적절하지 않은 것 (정답 1개가 왜 틀렸고 나머지는 왜 맞는지)"
            ch = "".join(f"<tr class='{'ok' if c == ans else ''} {'me' if c == my and c != ans else ''}'><td>{c}</td><td>{'정답' if c == ans else ('내 답' if c == my else '')}</td><td class=w></td></tr>" for c in "①②③④⑤")
            choices = f"<div class=sec>선지별 정리 <small>{kind}</small></div><table class=ch><tr><th style='width:9mm'>선지</th><th style='width:14mm'></th><th class=l>이 선지가 맞는/틀린 이유 (지문·조건의 근거)</th></tr>{ch}</table>"
        else:
            choices = "<div class=sec>풀이 정리 <small>어디까지 맞았고 어디서 틀렸는지</small></div><table class=ch><tr><td class=w style='height:30mm'></td></tr></table>"
        cause = "".join(f"<li>□ {i + 1}. {html.escape(t)}</li>" for i, t in enumerate(tags_of(no)))
        if subj == "영어":
            return card_en(no, q, meta, nat, psg, imgs, ans, my, choices, cause)
        return (f"<div class=pg><div class=hd>{no}번 <span class=tag>{num(q.get('points'))}점 · {meta}{nat}</span>{psg}"
                f"<span class=ans>내 답<b>{my or '&nbsp;'}</b> 정답<b>{ans or '&nbsp;'}</b></span></div>"
                f"<div class=top><div class=qimg>{imgs}</div><div class=box><div class=t>해설 정리<small>해설지를 읽고 핵심 근거·개념을 내 말로</small></div><div class=lines>{'<i></i>' * 12}</div></div></div>{choices}"
                f"<div class=conf><b style='color:#1e3a5f'>그때 확신도</b> &nbsp;<span>○ 확신</span><span>○ 반반</span><span>○ 찍음</span></div>"
                f"<div class=sec>원인 유형 <small>해당 번호에 ✓ (2개까지) · 표지의 '원인 번호' 칸에 옮겨 적기</small></div><ol class=cause>{cause}</ol>"
                f"<div class=boxes><div class=box><div class=t>EBS 오답 강의 정리<small>강의에서 짚은 포인트·내가 몰랐던 것</small></div><div class=lines>{'<i></i>' * 6}</div></div></div></div>")

    def card_en(no, q, meta, nat, psg, imgs, ans, my, choices, cause):
        """영어 독해: 읽기 점검(끊긴 지점·한 줄 요약·근거 문장·유형 전략) + 지문 해석 + 단어(추측→사전) + 원인·EBS. 듣기는 제외.
        근거: 이해 점검(comprehension monitoring)·MARSI 문제해결 전략 — docs/오답노트_양식_제안.md 4-3"""
        chk = ("<div class=chk><div>① 이해가 끊긴 문장: <u></u>번째 → 이유 ○단어 ○구조 ○앞뒤 연결</div>"
               "<div>② 이 글을 우리말 한 문장으로</div><div>&nbsp;</div><div>&nbsp;</div>"
               "<div>③ 정답 근거 문장: <u></u>번째 · 내 답과 충돌하는 문장: <u></u>번째</div>"
               "<div>④ 이 유형을 푸는 순서(내 전략)</div><div>&nbsp;</div><div>&nbsp;</div></div>")
        voc = ("<table class=voc><tr><th class=l style='width:30%'>단어·관용어</th><th class=l style='width:30%'>사전 뜻</th><th class=l>지문 속 구절 (예시 문장)</th></tr>" + "<tr><td></td><td></td><td></td></tr>" * 6 + "</table>")
        return (f"<div class=pg><div class=hd>{no}번 <span class=tag>{num(q.get('points'))}점 · {meta}{nat}</span>{psg}"
                f"<span class=ans>내 답<b>{my or '&nbsp;'}</b> 정답<b>{ans or '&nbsp;'}</b></span></div>"
                f"<div class=top><div class=qimg>{imgs}</div><div class=box><div class=t>읽기 점검<small>어디서 막혔고, 글이 무엇을 말하는지</small></div>{chk}"
                f"<div class=conf><b style='color:#1e3a5f'>그때 확신도</b> &nbsp;<span>○ 확신</span><span>○ 반반</span><span>○ 찍음</span></div>"
                f"<div class=sec>원인 유형 <small>✓ 2개까지 · 표지에 옮겨 적기</small></div><ol class=cause>{cause}</ol></div></div>"
                f"<div class=boxes><div class=box><div class=t>지문 해석<small>끊긴 문장부터 — 사전 없이 먼저 쓰고, 해설지 해석과 비교해 틀린 곳에 표시</small></div><div class=lines>" + "<i></i>" * 9 + "</div></div></div>"
                f"<div class=sec>단어·관용어 <small>사전 뜻과 지문 속 예시 문장을 함께</small></div>{voc}</div>"
                # 뒷면: EBS 오답 강의 정리 한 쪽 (한 문항 = 한 장 양면)
                f"<div class=pg><div class=hd>{no}번 <span class=tag>EBS 오답 강의 정리</span><span class=ans>강의에서 짚은 포인트 · 내가 몰랐던 것 · 다시 풀어 본 결과</span></div>"
                f"<div class=boxes style='margin-top:5px'><div class=box><div class=lines>" + "<i></i>" * 28 + "</div></div></div></div>")

    body, done = [], set()
    for no in wrong:
        q = qs[no]
        pieces = [os.path.join(folder, f) for f in ps[q["passage"]]["images"]] if sep_passage and q.get("passage") and q["passage"] not in done else []
        if pieces and not (len(pieces) == 1 and Image.open(pieces[0]).height < 150):   # 지시문 한 줄뿐인 세트(영어 [31~34] 등)는 쪽을 만들지 않음
            done.add(q["passage"])
            in_set = [n for n in wrong if qs[n].get("passage") == q["passage"]]
            if len(pieces) > 1:   # 왼쪽 단을 끝까지 채우고 오른쪽으로 다시 흘려 넣기(줄 단위, 되도록 문단 앞에서 끊음)
                os.makedirs(os.path.join(folder, "flow"), exist_ok=True)
                W = max(Image.open(x).width for x in pieces)
                pieces = reflow(pieces, os.path.join(folder, "flow", f"set{q['passage']}"), col_h=int(W * 238 / 91))   # 단 폭 91mm ↔ 높이 238mm
            pieces = [os.path.relpath(x, folder).replace("\\", "/") for x in pieces]
            for i in range(0, len(pieces), 2):   # 한 쪽에 조각 2개(세로 2단), 넘치면 다음 쪽
                imgs = "".join(f'<img src="{f}">' for f in pieces[i:i + 2])
                more = f" ({i // 2 + 1}/{(len(pieces) + 1) // 2})" if len(pieces) > 2 else ""
                body.append(f"<div class='pg psg'><h2>지문 [{q['passage']}]{more}</h2><div class=note>이 지문에서 틀린 문항: {', '.join(map(str, in_set))}번</div><div class=pieces>{imgs}</div></div>")
            if sheet and (len(pieces) + 1) // 2 % 2: body.append(BLANK)   # 지문 쪽이 홀수면 뒷면을 빈 쪽으로 채워 짝수로
        body.append(card(no))

    wrap = ("<div class='pg wrap'><h1>시험 성찰</h1><div class=sub>이 회차 전체를 돌아보는 한 쪽. 오답노트를 다 쓴 뒤에 적는다.</div>"
            "<h2>1. 준비</h2><div class=box2>이 과목을 어떻게, 얼마나 준비했나 (방법 · 시간)</div>"
            "<h2>2. 시험 중</h2><div class=box2>시간 배분 · 찍은 문항 수 ___ · '확신'인데 틀린 문항 수 ___ · 끝까지 못 푼 문항 ___</div>"
            "<h2>3. 원인 집계</h2><div class=box2>표지의 '원인 번호'를 세어 가장 많은 유형 두 개: 1) ________ 2) ________ · 지난 회차와 같은 유형이 있나? ○예 ○아니오</div>"
            "<h2>4. 다음 시험까지 바꿀 것 두 가지</h2><div class=box2>1)<br><br>2)</div></div>")
    page = (f"<!doctype html><html lang=ko><meta charset=utf-8><title>{title} 오답노트</title><style>{CSS}</style><body>"
            f"<div class=noprint><button onclick=print()>🖨 인쇄 / PDF 저장</button> &nbsp;<span style='color:#6b7280'>인쇄 대화상자에서 용지 A4 · 여백 '기본' · 배율 100%</span></div>{cover}{''.join(body)}{wrap}</body></html>")

    root = os.path.dirname(os.path.dirname(os.path.abspath(folder)))
    out = out or os.path.join(root, "오답노트_샘플", f"{os.path.basename(os.path.normpath(folder))}_{sid or '샘플'}.html")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    rel = os.path.relpath(os.path.abspath(folder), os.path.dirname(os.path.abspath(out))).replace("\\", "/")   # 그림은 크롭 폴더에 그대로
    open(out, "w", encoding="utf-8").write(page.replace('src="', f'src="{rel}/'))
    return out


def num(v):
    return "" if v is None else (f"{v:g}" if isinstance(v, (int, float)) else str(v))


def kv(s):
    return {int(k): CIRC.get(v, v) for k, v in (x.split("=") for x in s.split(","))} if s else {}


if __name__ == "__main__":
    a = sys.argv[1:]
    opt = lambda k: a[a.index(k) + 1] if k in a else None
    if opt("--api"):   # 사이트 GET /api/note 응답(json 파일)으로
        d = json.load(open(opt("--api"), encoding="utf-8"))
        wrong = [i["q_no"] for i in d["items"]]
        mine = {i["q_no"]: CIRC.get(str(i["marked"]), str(i["marked"] or "")) for i in d["items"]}
        units = {str(i["q_no"]): {"area": i.get("area"), "nat": i.get("nat")} for i in d["items"]}
        leap = {k: d[k] for k in ("my_score", "my_grade", "target_grade", "ref_n")} | {"ref_rate": {i["q_no"]: i.get("ref_rate") for i in d["items"]}} if d.get("mode") == "leap" else None
        sid = f"{d['grade']}-{d['class_no']}-{d['student_no']}"
        out = opt("--out") or os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(a[0]))), "오답노트_샘플", f"{os.path.basename(os.path.normpath(a[0]))}_{sid}_{d['mode']}.html")
        print(build(a[0], wrong, mine, sid, opt("--name") or "", out, units, leap))
    else:
        units = json.load(open(opt("--units"), encoding="utf-8")) if opt("--units") else None
        print(build(a[0], [int(x) for x in a[1].split(",")], kv(opt("--mine")), opt("--sid") or "", opt("--name") or "", opt("--out"), units))
