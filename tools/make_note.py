"""크롭 결과(manifest.json) + 오답 번호 → 학생용 오답노트 HTML (A4 인쇄용)

사용: python tools/make_note.py <크롭폴더> 4,10,15,30 [--answers 4=②,10=④] [--mine 4=③] [--out 파일명.html]
정답·학생 답은 아직 정답표 연동 전이라 인자로 받는다. 없으면 빈칸.
"""
import json, os, sys, html

PAGE = """<!doctype html><html lang=ko><meta charset=utf-8><title>{title}</title>
<style>
 @page{{size:A4;margin:12mm 12mm 14mm}}
 *{{box-sizing:border-box}} body{{font-family:"Malgun Gothic",system-ui,sans-serif;color:#222;margin:0;background:#f3f4f6}}
 .sheet{{max-width:186mm;margin:16px auto;background:#fff;padding:10mm 8mm;box-shadow:0 2px 8px #0002}}
 @media print{{body{{background:#fff}} .sheet{{max-width:none;margin:0;padding:0;box-shadow:none}} .noprint{{display:none}}}}
 header{{border-bottom:3px solid #1e3a5f;padding-bottom:8px;margin-bottom:10px;display:flex;justify-content:space-between;align-items:flex-end}}
 header h1{{font-size:20px;margin:0;color:#1e3a5f}} header .sub{{font-size:12px;color:#555;margin-top:3px}}
 .who{{font-size:13px;display:flex;gap:14px;white-space:nowrap}} .who span{{border-bottom:1px solid #888;min-width:70px;display:inline-block;padding:0 4px}}
 table.sum{{border-collapse:collapse;width:100%;font-size:12px;margin-bottom:14px}} .sum th,.sum td{{border:1px solid #cbd5e1;padding:4px 6px;text-align:center}} .sum th{{background:#e8eef6}}
 .q{{break-inside:avoid;page-break-inside:avoid;border:1px solid #cbd5e1;border-radius:6px;margin-bottom:14px;overflow:hidden}}
 .q h2{{margin:0;background:#1e3a5f;color:#fff;font-size:14px;padding:6px 10px;display:flex;gap:12px;align-items:center}}
 .q h2 .tag{{font-size:11px;font-weight:normal;opacity:.85}} .q h2 .ans{{margin-left:auto;font-weight:normal;font-size:12px}}
 .q h2 .ans b{{background:#fff;color:#1e3a5f;padding:1px 7px;border-radius:10px;margin-left:3px}}
 .psg{{background:#f8fafc;border-bottom:1px dashed #cbd5e1;padding:8px}} .psg .lbl{{font-size:11px;color:#64748b;margin-bottom:4px}}
 .pieces{{display:grid;grid-template-columns:repeat(auto-fill,minmax(78mm,1fr));gap:8px;align-items:start}} .pieces img{{width:100%;display:block}}
 .body{{padding:8px 10px}} .body img.qi{{width:100%;max-width:120mm;display:block}}
 .note{{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:8px}} .note div{{border:1px solid #cbd5e1;border-radius:4px;min-height:28mm;padding:4px 6px;font-size:11px;color:#64748b}}
 .note div.wide{{grid-column:1/3;min-height:22mm}}
 .chk{{font-size:11px;color:#475569;margin-top:6px}} .chk label{{margin-right:12px}}
 .psg.same{{padding:4px 8px;font-size:11px;color:#64748b}}
 .noprint{{text-align:center;margin:10px;font-size:13px}} .noprint button{{padding:6px 14px}}
</style><body>
<div class=noprint><button onclick="print()">🖨 인쇄 / PDF 저장</button> &nbsp; <label><input type=checkbox checked onchange="document.querySelectorAll('.psg').forEach(e=>e.style.display=this.checked?'':'none')"> 지문 함께 보기</label></div>
<div class=sheet>
<header><div><h1>{title} 오답노트</h1><div class=sub>오답 {n}문항 · 틀린 문제를 다시 풀고, 왜 틀렸는지 한 줄로 적어 보세요.</div></div>
<div class=who>학년/반/번호 <span>{sid}</span> 이름 <span>{name}</span></div></header>
<table class=sum><tr><th>번호</th><th>지문</th><th>내 답</th><th>정답</th><th>다시 풀기</th><th>원인</th></tr>{rows}</table>
{cards}
</div></body></html>"""

CARD = """<section class=q><h2>{no}번 <span class=tag>{tag}</span><span class=ans>내 답<b>{mine}</b> 정답<b>{ans}</b></span></h2>
{psg}<div class=body><img class=qi src="{img}">{more}
<div class=note><div>✏️ 틀린 이유 (개념 부족 / 지문 오독 / 선지 오독 / 시간 부족 / 실수)</div><div>💡 핵심 개념·근거 문장</div><div class=wide>🔁 다시 풀이</div></div>
<div class=chk><label>☐ 다시 풀어 맞힘</label><label>☐ 해설 확인</label><label>☐ 1주 뒤 재점검</label></div></div></section>"""


def build(folder, wrong, answers=None, mine=None, out=None, sid="", name=""):
    mf = json.load(open(os.path.join(folder, "manifest.json"), encoding="utf-8"))
    e = mf["exam"]
    title = f"{e['year']}학년도 {e['month']}월 고{e['grade']} 전국연합학력평가 {e['subject']}" if "year" in e else e.get("title", "")
    qs = {q["no"]: q for q in mf["questions"]}
    ps = {p["range"]: p for p in mf["passages"]}
    answers, mine = answers or {q['no']: q['answer'] for q in mf['questions'] if 'answer' in q}, mine or {}  # 정답은 manifest(해설지 파싱)에서
    rows, cards, shown = [], [], {}  # 지문범위 → 처음 보인 문항 번호
    for no in wrong:
        q = qs[no]
        tag = f"[{q['passage']}] 세트" if q["passage"] else "단독 문항"
        rows.append(f"<tr><td>{no}</td><td>{html.escape(tag)}</td><td>{mine.get(no, '')}</td><td>{answers.get(no, '')}</td><td>☐</td><td></td></tr>")
        psg = ""
        if q["passage"]:
            if q["passage"] in shown:
                psg = f'<div class="psg same">지문 [{q["passage"]}]은 위 {shown[q["passage"]]}번에 있음</div>'
            else:
                shown[q["passage"]] = no
                imgs = "".join(f'<img src="{f}">' for f in ps[q["passage"]]["images"])
                psg = f'<div class=psg><div class=lbl>지문 [{q["passage"]}]</div><div class=pieces>{imgs}</div></div>'
        more = "".join(f'<img class=qi src="{f}">' for f in q["images"][1:])
        cards.append(CARD.format(no=no, tag=html.escape(tag), mine=mine.get(no, "&nbsp;"), ans=answers.get(no, "&nbsp;"), psg=psg, img=q["images"][0], more=more))
    out = out or os.path.join(folder, f"오답노트_{sid or '샘플'}.html")
    open(out, "w", encoding="utf-8").write(PAGE.format(title=title, n=len(wrong), sid=sid, name=name, rows="".join(rows), cards="".join(cards)))
    return out


def kv(s):
    """"4=2,10=4" → {4:'②',10:'④'} (숫자는 동그라미 숫자로, 콘솔 인코딩 문제 회피)"""
    circ = {str(i + 1): c for i, c in enumerate("①②③④⑤")}
    return {int(k): circ.get(v, v) for k, v in (x.split("=") for x in s.split(","))} if s else {}


if __name__ == "__main__":
    a = sys.argv[1:]
    opt = lambda k: a[a.index(k) + 1] if k in a else None
    print(build(a[0], [int(x) for x in a[1].split(",")], kv(opt("--answers")), kv(opt("--mine")), opt("--out"), opt("--sid") or "", opt("--name") or ""))
