# 실행: python -m uvicorn backend.main:app --reload --port 8000
# 접속: http://localhost:8000
"""무리없이 부산 — FastAPI 메인 앱."""

from __future__ import annotations

import json
import logging
import os
import sys
import time
from collections import defaultdict
from pathlib import Path

from dotenv import load_dotenv
load_dotenv()  # 반드시 라우터 import 전에 호출해야 모듈 레벨 os.getenv가 정상 동작

from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from fastapi.staticfiles import StaticFiles

from backend.routers import analytics, courses, meta, recommend, report, search, share, spot_detail, weather


_REQUIRED_ENV_VARS = ["TOUR_API_KEY"]


@asynccontextmanager
async def lifespan(app: FastAPI):
    missing = [k for k in _REQUIRED_ENV_VARS if not os.getenv(k)]
    if missing:
        for k in missing:
            logger.error("필수 환경변수 누락: %s — .env 파일 또는 배포 환경을 확인하세요.", k)
        # lifespan 내부에서 sys.exit()는 비정상 종료를 유발하므로 RuntimeError로 전환
        raise RuntimeError(f"필수 환경변수 누락: {', '.join(missing)}")
    share.init_share_db()
    share.cleanup_expired_shares()
    report.init_report_db()
    # 만료된 코스 캐시 정리
    from backend.store import course_store
    course_store.cleanup_expired()

    # TourAPI areaCode2/categoryCode2 1회 예열 (실패해도 서비스는 정상 구동)
    import asyncio as _asyncio
    from backend.services.tourapi import fetch_area_codes, fetch_category_codes
    try:
        area_codes, category_codes = await _asyncio.gather(
            fetch_area_codes("6"),
            fetch_category_codes(),
            return_exceptions=True,
        )
        area_count = len(area_codes) if isinstance(area_codes, list) else 0
        cat_count = len(category_codes) if isinstance(category_codes, list) else 0
        logger.info("메타 코드 예열: 부산 시군구 %d개 · 관광 분류 %d개", area_count, cat_count)
    except Exception as e:
        logger.warning("메타 코드 예열 실패: %s", e)

    logger.info("앱 시작 완료")
    yield

# ── 로깅 설정 ──────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)

app = FastAPI(
    title="무리없이 부산",
    description="이동약자 맞춤 부산 관광 코스 추천 서비스",
    version="1.0.0",
    lifespan=lifespan,
)

# ── CORS 화이트리스트 ──────────────────────────────────────────────
_default_origins = "http://localhost:8000,http://127.0.0.1:8000"
_origins = [
    o.strip()
    for o in os.getenv("ALLOWED_ORIGINS", _default_origins).split(",")
    if o.strip()
]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_origins,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Content-Type", "Accept"],
)


# ── 보안 헤더 미들웨어 ──────────────────────────────────────────────
# CSP: Kakao Map SDK·Google Fonts·QR CDN·Unsplash/TourAPI 이미지 허용
# inline script/style이 다수 존재하여 'unsafe-inline'은 유지, eval은 차단
_CSP_POLICY = (
    "default-src 'self'; "
    "script-src 'self' 'unsafe-inline' https://dapi.kakao.com https://t1.daumcdn.net "
    "https://cdnjs.cloudflare.com https://developers.kakao.com; "
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
    "font-src 'self' https://fonts.gstatic.com data:; "
    "img-src 'self' data: blob: https:; "
    "connect-src 'self' https://apis.data.go.kr https://dapi.kakao.com "
    "https://router.project-osrm.org https://*.supabase.co https://generativelanguage.googleapis.com; "
    "frame-ancestors 'none'; "
    "base-uri 'self'; "
    "form-action 'self'"
)


@app.middleware("http")
async def security_headers_middleware(request: Request, call_next):
    response = await call_next(request)
    response.headers.setdefault("Content-Security-Policy", _CSP_POLICY)
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("X-Frame-Options", "DENY")
    response.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
    response.headers.setdefault("Permissions-Policy", "geolocation=(self), microphone=()")
    return response

# ── Rate Limiting (경량 미들웨어) ──────────────────────────────────
# 경로별 제한: (최대 요청 수, 윈도우 초)
_RATE_LIMITS: dict[str, tuple[int, int]] = {
    "/api/recommend": (10, 60),      # IP당 분당 10회
    "/api/share": (20, 60),          # IP당 분당 20회
    "/api/log/recommend": (30, 60),  # IP당 분당 30회
    "/api/log/survey": (10, 60),     # IP당 분당 10회
}
# GET 엔드포인트별 분당 제한 (동적 경로는 prefix 매칭)
_RATE_LIMITS_GET_PREFIXES: list[tuple[str, int, int]] = [
    ("/api/share/", 60, 60),    # 공유 링크 조회: 분당 60회
    ("/api/courses/", 60, 60),  # 코스 상세 조회: 분당 60회
    ("/api/reports/", 30, 60),  # 신고 목록 조회: 분당 30회
]
_rate_buckets: dict[str, list[float]] = defaultdict(list)
# 주기적 전체 청소용 카운터 (빈 bucket이 무제한으로 쌓이는 것 방지)
_rate_gc_counter = 0
_RATE_GC_INTERVAL = 500  # 요청 500회마다 만료 bucket 전수 청소


def _gc_rate_buckets(now: float) -> None:
    """모든 bucket을 훑어 최신 윈도우보다 오래된 타임스탬프만 남기고, 비어 있으면 삭제."""
    max_window = max(window for _, window in _RATE_LIMITS.values())
    stale_keys = []
    for key, timestamps in _rate_buckets.items():
        fresh = [t for t in timestamps if now - t < max_window]
        if fresh:
            _rate_buckets[key] = fresh
        else:
            stale_keys.append(key)
    for key in stale_keys:
        _rate_buckets.pop(key, None)


@app.middleware("http")
async def rate_limit_middleware(request: Request, call_next):
    global _rate_gc_counter
    path = request.url.path

    # POST 엔드포인트 정확 매칭
    limit_config = _RATE_LIMITS.get(path) if request.method == "POST" else None
    # GET 엔드포인트 prefix 매칭 (동적 경로 대응)
    if limit_config is None and request.method == "GET":
        for prefix, max_req, win in _RATE_LIMITS_GET_PREFIXES:
            if path.startswith(prefix):
                limit_config = (max_req, win)
                break

    if limit_config:
        max_requests, window_sec = limit_config
        # X-Forwarded-For 헤더로 실제 클라이언트 IP 추출 (CDN/프록시 환경 대응)
        forwarded = request.headers.get("X-Forwarded-For")
        client_ip = forwarded.split(",")[0].strip() if forwarded else (request.client.host if request.client else "unknown")
        bucket_key = f"{client_ip}:{path}"
        now = time.time()

        # 주기적 전체 청소 — 비활성 IP의 빈 bucket을 제거해 메모리 누수 방지
        _rate_gc_counter += 1
        if _rate_gc_counter >= _RATE_GC_INTERVAL:
            _rate_gc_counter = 0
            _gc_rate_buckets(now)

        # 해당 bucket의 만료 타임스탬프 제거
        fresh = [t for t in _rate_buckets.get(bucket_key, []) if now - t < window_sec]

        if len(fresh) >= max_requests:
            logger.warning("Rate limit 초과: %s %s", client_ip, path)
            # 카운트만 갱신하고 새 요청은 기록하지 않음 (메모리 증가 방지)
            _rate_buckets[bucket_key] = fresh
            return JSONResponse(
                status_code=429,
                content={"detail": "요청이 너무 많습니다. 잠시 후 다시 시도해주세요."},
            )
        fresh.append(now)
        _rate_buckets[bucket_key] = fresh

    return await call_next(request)


# 라우터 등록
app.include_router(recommend.router)
app.include_router(courses.router)
app.include_router(share.router)
app.include_router(weather.router)
app.include_router(search.router)
app.include_router(spot_detail.router)
app.include_router(meta.router)
app.include_router(report.router)
app.include_router(analytics.router)




@app.get("/runtime-config.js")
async def runtime_config():
    kakao_map_key = os.getenv("KAKAO_MAP_KEY", "").strip()
    javascript = (
        "window.RUNTIME_CONFIG = window.RUNTIME_CONFIG || {};\n"
        f"window.RUNTIME_CONFIG.kakaoMapKey = {json.dumps(kakao_map_key or None)};\n"
        "window.KAKAO_MAP_KEY = window.RUNTIME_CONFIG.kakaoMapKey;\n"
    )
    return Response(
        content=javascript,
        media_type="application/javascript",
        headers={"Cache-Control": "no-store, max-age=0"},
    )

# 정적 파일 서빙 (frontend/)
FRONTEND_DIR = Path(__file__).resolve().parent.parent / "frontend"
app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="frontend")
