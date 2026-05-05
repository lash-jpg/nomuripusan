"""POST /api/log/recommend, /api/log/survey, /api/log/interaction — 사용 로그 및 만족도 조사 저장."""
from __future__ import annotations

import logging
from typing import Any, Optional

from fastapi import APIRouter, HTTPException  # HTTPException: interaction 400에 사용
from pydantic import BaseModel, Field

from backend.services.supabase_client import get_client

logger = logging.getLogger(__name__)
router = APIRouter()


class RecommendLogRequest(BaseModel):
    session_id: str = Field(..., min_length=1, max_length=128)
    days: int = Field(..., ge=1, le=5)
    mobility_types: list[str] = Field(default_factory=list)
    areas: list[str] = Field(default_factory=list)
    start_date: Optional[str] = None
    course_ids: list[str] = Field(default_factory=list)
    course_count: int = 0
    fallback_used: bool = False
    ai_enabled: bool = False


class RecommendLogResponse(BaseModel):
    ok: bool
    log_id: Optional[str] = None


class SurveyRequest(BaseModel):
    session_id: str = Field(..., min_length=1, max_length=128)
    log_id: Optional[str] = None
    score: int = Field(..., ge=1, le=5)
    reason_categories: list[str] = Field(default_factory=list)
    reason_text: Optional[str] = Field(default=None, max_length=500)


class SurveyResponse(BaseModel):
    ok: bool
    survey_id: Optional[str] = None


@router.post("/api/log/recommend", response_model=RecommendLogResponse)
async def log_recommendation(req: RecommendLogRequest):
    """추천 요청 로그 저장. Supabase 미설정이면 no-op으로 OK 반환."""
    client = get_client()
    if not client:
        return RecommendLogResponse(ok=True, log_id=None)

    try:
        data = {
            "session_id": req.session_id,
            "days": req.days,
            "mobility_types": req.mobility_types,
            "areas": req.areas,
            "start_date": req.start_date,
            "course_ids": req.course_ids[:50],
            "course_count": req.course_count,
            "fallback_used": req.fallback_used,
            "ai_enabled": req.ai_enabled,
        }
        result = client.table("recommendation_logs").insert(data).execute()
        rows = getattr(result, "data", None) or []
        log_id = rows[0].get("id") if rows else None
        return RecommendLogResponse(ok=True, log_id=log_id)
    except Exception as e:
        logger.warning("추천 로그 저장 실패: %s", e)
        return RecommendLogResponse(ok=False, log_id=None)


@router.post("/api/log/survey", response_model=SurveyResponse)
async def log_survey(req: SurveyRequest):
    """만족도 조사 저장."""
    client = get_client()
    if not client:
        return SurveyResponse(ok=True, survey_id=None)

    try:
        data = {
            "session_id": req.session_id,
            "log_id": req.log_id,
            "score": req.score,
            "reason_categories": req.reason_categories[:10],
            "reason_text": (req.reason_text or "").strip() or None,
        }
        result = client.table("satisfaction_surveys").insert(data).execute()
        rows = getattr(result, "data", None) or []
        survey_id = rows[0].get("id") if rows else None
        return SurveyResponse(ok=True, survey_id=survey_id)
    except Exception as e:
        logger.warning("만족도 저장 실패: %s", e)
        return SurveyResponse(ok=False, survey_id=None)


# ── 사용자 인터랙션 로그 ────────────────────────────────────────────────

ALLOWED_EVENT_TYPES = {
    "course_view",        # 코스 카드 클릭 → 상세 진입
    "favorite_toggle",    # 즐겨찾기 추가/제거
    "filter_change",      # 필터 탭 변경 (전체/저피로순/관광지많은순/즐겨찾기)
    "day_tab_change",     # Day 탭 전환 (멀티데이)
    "refresh_click",      # "다시 분석" 클릭
    "edit_conditions",    # "조건 수정" 클릭
    "share_click",        # 공유 버튼 클릭
    "onboarding_step",    # 온보딩 단계 전환
    "onboarding_complete", # 온보딩 완료 (추천 요청 직전)
    "survey_skip",        # 만족도 조사 건너뜀
}


class InteractionLogRequest(BaseModel):
    session_id: str = Field(..., min_length=1, max_length=128)
    log_id: Optional[str] = None
    event_type: str = Field(..., min_length=1, max_length=64)
    event_data: dict[str, Any] = Field(default_factory=dict, max_length=20)  # 키 20개 이하


class InteractionLogResponse(BaseModel):
    ok: bool


@router.post("/api/log/interaction", response_model=InteractionLogResponse)
async def log_interaction(req: InteractionLogRequest):
    """사용자 인터랙션 이벤트 저장 (코스 선택, 필터 변경, 즐겨찾기 등)."""
    if req.event_type not in ALLOWED_EVENT_TYPES:
        raise HTTPException(status_code=400, detail=f"알 수 없는 이벤트 타입: {req.event_type}")

    client = get_client()
    if not client:
        return InteractionLogResponse(ok=True)

    try:
        data = {
            "session_id": req.session_id,
            "log_id": req.log_id,
            "event_type": req.event_type,
            "event_data": req.event_data,
        }
        client.table("user_interactions").insert(data).execute()
        return InteractionLogResponse(ok=True)
    except Exception as e:
        logger.warning("인터랙션 로그 저장 실패 [%s]: %s", req.event_type, e)
        return InteractionLogResponse(ok=True)  # fire-and-forget: 실패해도 UX 영향 없음
