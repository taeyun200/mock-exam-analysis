"""지문 조각(단 단위 크롭)을 줄 단위로 잘라 다시 흘려 넣기 — 왼쪽 단을 끝까지 채운 뒤 오른쪽 단으로.

원리: 조각 그림을 세로로 이어 붙인 뒤, 글자가 없는 가로 띠(줄 사이)를 찾아 "줄 덩어리"로 나누고, 단 높이에 맞춰 차례로 담는다.
자르는 자리는 되도록 문단 첫 줄(들여쓰기) 앞. 상자 테두리의 세로선은 글자 판정에서 빼서 상자 안에서도 줄 사이를 찾는다.
사용: reflow([조각 경로...], 출력접두어, col_h) → [단 그림 경로...] (왼쪽, 오른쪽, 왼쪽, 오른쪽 … 순)
"""
import os
import numpy as np
from PIL import Image


def _rows_ink(a, band=120):
    """각 행의 글자 유무. 세로선(어느 띠(band행) 안에서 90% 이상 어두운 열)은 무시 — 상자 테두리가 일부 구간에만 있어도 잡히게."""
    dark = a < 200
    for y in range(0, len(dark), band):
        seg = dark[y:y + band]
        vline = seg.mean(axis=0) > 0.9
        seg[:, vline] = False
    return dark.sum(axis=1) > 0, dark


def blocks(a, min_gap=3):
    """(시작행, 끝행, 문단시작여부) 줄 덩어리 목록."""
    ink, dark = _rows_ink(a)
    out, y = [], 0
    H = len(ink)
    while y < H:
        if not ink[y]:
            y += 1; continue
        y0 = y
        while y < H and (ink[y] or (y + min_gap < H and ink[y:y + min_gap].any())):
            y += 1
        out.append([y0, y])
    # 문단 시작: 그 줄의 첫 글자 x가 보통 줄보다 오른쪽(들여쓰기)
    xs = []
    for y0, y1 in out:
        cols = np.where(dark[y0:y1].any(axis=0))[0]
        xs.append(cols[0] if len(cols) else 0)
    base = int(np.median(xs)) if xs else 0
    return [(y0, y1, x > base + 12) for (y0, y1), x in zip(out, xs)]


def reflow(pieces, prefix, col_h, gap=6):
    ims = [Image.open(p).convert("L") for p in pieces]
    W = max(im.width for im in ims)
    canvas = Image.new("L", (W, sum(im.height for im in ims) + gap * (len(ims) - 1)), 255)
    y = 0
    for im in ims:
        canvas.paste(im, (0, y)); y += im.height + gap
    a = np.asarray(canvas)
    bl = blocks(a)
    if not bl:
        return pieces
    # 단에 담기: 넘치기 직전에 끊되, 그 근처(단 높이의 85% 이후)에 문단 시작이 있으면 거기서 끊는다
    cols, cur, cur_h, start = [], [], 0, bl[0][0]
    i = 0
    while i < len(bl):
        y0, y1, para = bl[i]
        h = y1 - start
        if h > col_h and cur:
            # 뒤로 돌아가 문단 시작 찾기(현재 단 높이 85% 이후)
            j = i
            while j > 0 and not bl[j][2] and bl[j - 1][0] - start > col_h * 0.85:
                j -= 1
            if not bl[j][2] or j == 0 or bl[j][0] - start < col_h * 0.6:
                j = i   # 적당한 문단 시작이 없으면 그냥 줄 사이에서 끊음
            cols.append((start, bl[j - 1][1] if j > 0 else bl[j][0]))
            start = bl[j][0]; cur = []; i = j; continue
        cur.append(i); i += 1
    cols.append((start, bl[-1][1]))
    out = []
    for k, (ya, yb) in enumerate(cols):
        fn = f"{prefix}_{k + 1}.png"
        canvas.crop((0, max(0, ya - 4), W, min(canvas.height, yb + 4))).save(fn)
        out.append(fn)
    return out


if __name__ == "__main__":
    import sys
    print(reflow(sys.argv[2:], sys.argv[1], 2400))
