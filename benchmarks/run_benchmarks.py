"""
Performance benchmark for Muri-eopsi Busan project.
Before/After comparison (time.perf_counter, unit: ms)
"""
from __future__ import annotations
import sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

import asyncio
import json
import math
import time
from pathlib import Path

# ── 공통 유틸 ──────────────────────────────────────────────────────
def _ms(start: float) -> float:
    return (time.perf_counter() - start) * 1000

def _avg(times: list[float]) -> float:
    return sum(times) / len(times)

SEP = "-" * 56

# ══════════════════════════════════════════════════════════════════
# [1] Gemini 병렬화 — 순차 vs asyncio.gather
# ══════════════════════════════════════════════════════════════════
async def _mock_gemini_call(delay: float = 0.5):
    await asyncio.sleep(delay)
    return {"ai_description": "mock"}

async def bench_gemini_sequential(n: int = 9, delay: float = 0.5) -> float:
    t = time.perf_counter()
    for _ in range(n):
        await _mock_gemini_call(delay)
    return _ms(t)

async def bench_gemini_parallel(n: int = 9, delay: float = 0.5) -> float:
    t = time.perf_counter()
    await asyncio.gather(*[_mock_gemini_call(delay) for _ in range(n)])
    return _ms(t)

# ══════════════════════════════════════════════════════════════════
# [2] 날씨 API 병렬화 — 순차 vs asyncio.gather
# ══════════════════════════════════════════════════════════════════
async def _mock_weather_call(delay: float = 1.0) -> list:
    await asyncio.sleep(delay)
    return []  # 실패 시뮬레이션

async def bench_weather_sequential(delay: float = 1.0) -> float:
    t = time.perf_counter()
    candidates = [delay, delay, delay]
    for d in candidates:
        result = await _mock_weather_call(d)
        if result:
            break
    return _ms(t)

async def bench_weather_parallel(delay: float = 1.0) -> float:
    t = time.perf_counter()
    results = await asyncio.gather(
        *[_mock_weather_call(delay) for _ in range(3)],
        return_exceptions=True,
    )
    for r in results:
        if isinstance(r, list) and r:
            break
    return _ms(t)

# ══════════════════════════════════════════════════════════════════
# [3] 알고리즘 거리 행렬 최적화
# ══════════════════════════════════════════════════════════════════
DATA_PATH = Path(__file__).resolve().parent.parent / "backend" / "data" / "busan_spots.json"

def _distance_between(a: dict, b: dict) -> float:
    radius = 6_371_000
    lat1, lat2 = math.radians(a["lat"]), math.radians(b["lat"])
    dlat = lat2 - lat1
    dlng = math.radians(b["lng"] - a["lng"])
    h = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlng / 2) ** 2
    return 2 * radius * math.asin(math.sqrt(h))

def _build_dist_matrix_naive(spots: list[dict]) -> float:
    """수정 전: O(N²) 매번 재계산 시뮬레이션 — 각 (a,b) 쌍을 중복 계산"""
    t = time.perf_counter()
    for a in spots:
        for b in spots:
            if a["id"] != b["id"]:
                _distance_between(a, b)
    return _ms(t)

def _build_dist_matrix_precomputed(spots: list[dict]) -> float:
    """수정 후: 사전 계산 — 각 쌍 1회만 계산"""
    t = time.perf_counter()
    dist: dict[tuple[str, str], float] = {}
    for i, a in enumerate(spots):
        for b in spots[i + 1:]:
            d = _distance_between(a, b)
            dist[(a["id"], b["id"])] = d
            dist[(b["id"], a["id"])] = d
    return _ms(t)

def bench_algorithm(spots: list[dict], repeat: int = 5) -> tuple[float, float]:
    naive_times = [_build_dist_matrix_naive(spots) for _ in range(repeat)]
    precomp_times = [_build_dist_matrix_precomputed(spots) for _ in range(repeat)]
    return _avg(naive_times), _avg(precomp_times)

# ══════════════════════════════════════════════════════════════════
# [4] 파일 I/O 캐싱 효과
# ══════════════════════════════════════════════════════════════════
def _read_from_file() -> list:
    with open(DATA_PATH, encoding="utf-8") as f:
        return json.load(f)

def bench_file_io(repeat: int = 100) -> tuple[float, float, float, float]:
    """(before_total, after_total, before_avg, after_avg) 모두 ms"""
    # 수정 전: 매번 파일에서 읽기
    t = time.perf_counter()
    for _ in range(repeat):
        _read_from_file()
    before_total = _ms(t)

    # 수정 후: 첫 번째 cold, 이후 캐시
    cache: list | None = None

    def _cached_read() -> list:
        nonlocal cache
        if cache is None:
            cache = _read_from_file()
        return cache

    # cold 1회
    t_cold = time.perf_counter()
    _cached_read()
    cold_ms = _ms(t_cold)

    # warm 나머지
    t = time.perf_counter()
    for _ in range(repeat - 1):
        _cached_read()
    warm_total = _ms(t)

    after_total = cold_ms + warm_total
    return before_total, after_total, before_total / repeat, after_total / repeat

# ══════════════════════════════════════════════════════════════════
# 메인 실행
# ══════════════════════════════════════════════════════════════════
async def main():
    REPEAT = 3
    print("\n" + "=" * 56)
    print("  무리없이 부산 — 성능 개선 벤치마크 결과")
    print("=" * 56)

    # ── [1] Gemini 병렬화 ──────────────────────────────────────
    print(f"\n[1] Gemini 호출 병렬화 (9코스 × 500ms)")
    print(SEP)
    seq_times = [await bench_gemini_sequential(9, 0.5) for _ in range(REPEAT)]
    par_times = [await bench_gemini_parallel(9, 0.5) for _ in range(REPEAT)]
    seq_avg = _avg(seq_times)
    par_avg = _avg(par_times)
    saved = seq_avg - par_avg
    pct = saved / seq_avg * 100
    print(f"  수정 전 (순차, for+await):    {seq_avg:>8.1f} ms")
    print(f"  수정 후 (asyncio.gather):     {par_avg:>8.1f} ms")
    print(f"  단축: {pct:.1f}%  ({saved:.1f} ms 절약)")

    # ── [2] 날씨 API 병렬화 ────────────────────────────────────
    print(f"\n[2] 날씨 API 재시도 병렬화 (3회 × 1000ms)")
    print(SEP)
    seq_times = [await bench_weather_sequential(1.0) for _ in range(REPEAT)]
    par_times = [await bench_weather_parallel(1.0) for _ in range(REPEAT)]
    seq_avg = _avg(seq_times)
    par_avg = _avg(par_times)
    saved = seq_avg - par_avg
    pct = saved / seq_avg * 100
    print(f"  수정 전 (순차 재시도 3회):    {seq_avg:>8.1f} ms")
    print(f"  수정 후 (gather 병렬):        {par_avg:>8.1f} ms")
    print(f"  단축: {pct:.1f}%  ({saved:.1f} ms 절약)")

    # ── [3] 알고리즘 거리 행렬 ─────────────────────────────────
    print(f"\n[3] 알고리즘 거리 행렬 최적화")
    print(SEP)
    all_spots = json.loads(DATA_PATH.read_text(encoding="utf-8"))
    cases = [
        ("      10", all_spots[:10]),
        ("      30", all_spots[:30]),
        (f"  전체({len(all_spots):2d})", all_spots),
    ]
    print(f"  {'스팟 수':>8} | {'수정 전 (ms)':>12} | {'수정 후 (ms)':>12} | {'단축 (%)':>8}")
    print(f"  {'-'*8}-+-{'-'*12}-+-{'-'*12}-+-{'-'*8}")
    for label, spots in cases:
        before, after = bench_algorithm(spots, repeat=5)
        pct = (before - after) / before * 100 if before > 0 else 0
        print(f"  {label:>8} | {before:>12.3f} | {after:>12.3f} | {pct:>7.1f}%")

    # ── [4] 파일 I/O 캐싱 ──────────────────────────────────────
    print(f"\n[4] 파일 I/O 캐싱 효과 (100회 호출)")
    print(SEP)
    before_total, after_total, before_avg, after_avg = bench_file_io(100)
    saved = before_total - after_total
    pct = saved / before_total * 100
    print(f"  수정 전 (매번 파일 읽기): {before_total:>8.1f} ms  (평균 {before_avg:>5.2f} ms/call)")
    print(f"  수정 후 (모듈 캐시):      {after_total:>8.1f} ms  (평균 {after_avg:>5.2f} ms/call)")
    print(f"  단축: {pct:.1f}%  ({saved:.1f} ms 절약)")

    print("\n" + "=" * 56)
    print("  벤치마크 완료")
    print("=" * 56 + "\n")

if __name__ == "__main__":
    asyncio.run(main())
