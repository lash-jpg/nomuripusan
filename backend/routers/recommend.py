"""POST /api/recommend — 알고리즘 + 저장/Gemini 추천 이유 보강."""
from __future__ import annotations

import asyncio
import logging

from fastapi import APIRouter
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)

from backend.services.algorithm import recommend_courses
from backend.services.tourapi import fetch_spots, fetch_festivals, fetch_stays
from backend.services.gemini import enrich_courses
from backend.routers.courses import cache_courses
from backend.routers.weather import fetch_weather_status

router = APIRouter()


class RecommendRequest(BaseModel):
    mobility_types: list[str] = Field(default=["wheelchair"])
    days: int = Field(default=1, ge=1, le=5)
    areas: list[str] = Field(default=[])
    start_date: str | None = Field(default=None, description="여행 시작일 YYYYMMDD")


class RecommendResponse(BaseModel):
    courses: list[dict]
    summary: dict


@router.post("/api/recommend", response_model=RecommendResponse)
async def recommend(req: RecommendRequest):
    spots, festivals, weather = await asyncio.gather(
        fetch_spots(),
        fetch_festivals(req.start_date),
        fetch_weather_status(req.start_date),
    )

    # 1박 이상 코스일 때만 숙박 후보 조회 (API 호출량 절감)
    stays: list[dict] = []
    if req.days >= 2:
        stays = await fetch_stays()
        if req.areas:
            stays = [s for s in stays if s.get("area") in req.areas]
        stays = stays[:5]

    # 행사/축제 데이터 병합
    if festivals:
        existing_ids = {s["id"] for s in spots}
        spots = spots + [f for f in festivals if f["id"] not in existing_ids]

    is_rainy = weather.get("is_rainy", False)

    courses = recommend_courses(
        spots=spots,
        mobility_types=req.mobility_types,
        days=req.days,
        areas=req.areas,
        is_rainy=is_rainy,
    )

    fallback_used = False
    message = ""

    if not courses and req.areas:
        courses = recommend_courses(
            spots=spots,
            mobility_types=req.mobility_types,
            days=req.days,
            areas=[],
        )
        fallback_used = bool(courses)
        message = (
            "선택한 권역에서 조건에 맞는 코스를 찾지 못해 부산 전역으로 대체 추천했어요."
            if fallback_used
            else "조건에 맞는 코스를 찾지 못했어요."
        )

    # 저장된 경로별 추천 이유 우선 적용, 없으면 Gemini 시도, 실패하면 원본 통과
    courses = await enrich_courses(courses, req.mobility_types, req.days)

    cache_courses(courses)

    applied_areas = sorted({
        spot.get("area")
        for course in courses
        for spot in course.get("spots", [])
        if spot.get("area")
    })

    ai_enabled = any(c.get("ai_description") for c in courses)
    festival_count = sum(
        1 for c in courses for s in c.get("spots", []) if s.get("_festival")
    )

    return {
        "courses": courses,
        "summary": {
            "requested_areas": req.areas,
            "applied_areas": applied_areas,
            "mobility_types": req.mobility_types,
            "requested_days": req.days,
            "start_date": req.start_date,
            "course_count": len(courses),
            "festival_count": festival_count,
            "fallback_used": fallback_used,
            "message": message,
            "ai_enabled": ai_enabled,
            "weather": weather,
            "stay_candidates": stays,
        },
    }
