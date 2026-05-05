"""경로별 추천 이유 보강.

저장된 경로 이유 DB를 우선 사용하고, 미등록 경로만 Gemini로 생성한다.
Gemini 키/쿼터가 없으면 추천 이유 없이 원본 코스를 그대로 반환한다.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
import logging
import time
from pathlib import Path

from backend.services.reason_store import reason_store

logger = logging.getLogger(__name__)
_CACHE_DIR = Path(__file__).resolve().parent.parent / "data" / "ai_cache"

# 우선순위 순으로 시도할 모델 목록 (최신 → 안정)
# 2.0 시리즈와 1.5 시리즈는 무료 쿼터가 독립적이므로 fallback 효과가 있다.
_MODEL_CANDIDATES = [
    "gemini-2.0-flash-lite",
    "gemini-2.0-flash",
    "gemini-1.5-flash",
]
_MODEL_NAME = _MODEL_CANDIDATES[0]
_client = None

def _get_supabase():
    """Supabase 클라이언트 접근 — services/supabase_client 싱글톤에 위임한다.
    환경변수 미설정·초기화 실패 시 None 반환 → 파일 캐시 fallback."""
    from backend.services.supabase_client import get_client
    return get_client()

# Gemini 호출 간격 제한 (동시 요청 방어)
_gemini_lock = asyncio.Lock()
_gemini_last_call = 0.0
_GEMINI_MIN_INTERVAL = 1.0  # 최소 1초 간격


def _get_client():
    global _client
    if _client is None:
        from google import genai
        api_key = os.getenv("GEMINI_API_KEY", "")
        if not api_key:
            logger.info("GEMINI_API_KEY 미설정 — AI 설명 비활성")
            return None
        try:
            _client = genai.Client(api_key=api_key)
            logger.info("Gemini 클라이언트 초기화 성공 (모델: %s 우선)", _MODEL_CANDIDATES[0])
        except Exception as e:
            logger.warning("Gemini 클라이언트 초기화 실패: %s", e)
    return _client


def _mobility_label(types: list[str]) -> str:
    labels = {"wheelchair": "휠체어 이용자", "stroller": "유아차 동반", "senior": "시니어", "carrier": "보행 보조기"}
    return ", ".join(labels.get(t, t) for t in types) or "일반"


def _build_prompt(courses: list[dict], mobility_types: list[str], days: int) -> str:
    mobility = _mobility_label(mobility_types)

    course_blocks = []
    for i, c in enumerate(courses):
        spots_text = "\n".join(
            f"  {j+1}. {s['name']} ({s.get('category','관광지')}, 접근성 {s.get('accessibility_grade',3)}/5, "
            f"관람 {s.get('visit_time_min',50)}분, 경사 {s.get('slope_pct',2)}%)"
            for j, s in enumerate(c.get("spots", []))
        )
        course_blocks.append(
            f"[코스 {i+1}] {c['name']}\n"
            f"총 소요: {c['total_time_min']}분 | 거리: {c['distance_km']}km | 피로도: {c['total_fatigue']}\n"
            f"방문지:\n{spots_text}"
        )

    courses_text = "\n\n".join(course_blocks)

    return f"""당신은 이동약자를 위한 부산 관광 전문 AI 가이드입니다. 간결하고 실용적인 한국어로 답변하세요.

사용자 정보:
- 이동 유형: {mobility}
- 여행 일수: {days}일

알고리즘이 선별한 추천 코스:

{courses_text}

각 코스에 대해 아래 JSON만 출력하세요 (마크다운 코드블록 없이):
{{
  "courses": [
    {{
      "index": 0,
      "ai_description": "이 코스를 왜 이 사용자에게 추천하는지 2문장 설명",
      "ai_highlights": ["핵심 포인트 1 (10자 이내)", "핵심 포인트 2"],
      "ai_tip": "이동약자를 위한 실용적 이동 팁 1문장",
      "spot_guides": [
        {{
          "name": "방문지 이름 (spots 순서대로)",
          "why": "이 장소를 코스에 넣은 이유 1문장",
          "point": "감상 포인트/꿀팁 1문장"
        }}
      ]
    }}
  ]
}}"""


def _build_single_prompt(course: dict, mobility_types: list[str], days: int) -> str:
    """단일 코스에 대한 Gemini 프롬프트."""
    mobility = _mobility_label(mobility_types)
    spots_text = "\n".join(
        f"  {j+1}. {s['name']} ({s.get('category','관광지')}, 접근성 {s.get('accessibility_grade',3)}/5)"
        for j, s in enumerate(course.get("spots", []))
    )
    return f"""이동약자 부산 관광 AI 가이드. 간결한 한국어로.

이동 유형: {mobility} | {days}일 여행
코스: {course['name']} ({course['total_time_min']}분, {course['distance_km']}km)
방문지:
{spots_text}

아래 JSON만 출력 (마크다운 없이):
{{"ai_description":"코스 추천 이유 2문장","ai_highlights":["포인트1","포인트2"],"ai_tip":"이동 팁 1문장","spot_guides":[{{"name":"장소명","why":"추천 이유 1문장","point":"감상 포인트 1문장"}}]}}"""


def _cache_key(course: dict, mobility_types: list[str]) -> str:
    """스팟 ID 조합 + 유형으로 해시 키 생성."""
    spot_ids = "|".join(s["id"] for s in course.get("spots", []))
    types_str = ",".join(sorted(mobility_types))
    return hashlib.md5(f"{spot_ids}:{types_str}".encode()).hexdigest()


def _load_cache_file(key: str) -> dict | None:
    path = _CACHE_DIR / f"{key}.json"
    if path.exists():
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except Exception as e:
            logger.warning("AI 파일 캐시 로드 실패 (%s): %s", key, e)
    return None


def _save_cache_file(key: str, data: dict) -> None:
    try:
        _CACHE_DIR.mkdir(parents=True, exist_ok=True)
        (_CACHE_DIR / f"{key}.json").write_text(
            json.dumps(data, ensure_ascii=False), encoding="utf-8"
        )
    except Exception as e:
        logger.warning("AI 파일 캐시 저장 실패 (%s): %s", key, e)


def _load_cache(key: str) -> dict | None:
    """경로 이유 DB 우선, Supabase/파일 캐시 fallback."""
    stored = reason_store.get(key)
    if stored:
        logger.info("추천 이유 DB 히트: %s", key)
        return stored

    sb = _get_supabase()
    if sb is not None:
        try:
            res = sb.table("ai_cache").select("data").eq("key", key).limit(1).execute()
            rows = getattr(res, "data", None) or []
            if rows:
                logger.info("Supabase 캐시 히트: %s", key)
                return rows[0]["data"]
        except Exception as e:
            logger.warning("Supabase 캐시 조회 실패, 파일 fallback: %s", e)
    return _load_cache_file(key)


def _save_cache(key: str, data: dict) -> None:
    """경로 이유 DB에 저장하고 Supabase/파일 캐시에도 기록한다."""
    reason_store.put(key, data, source="gemini")

    sb = _get_supabase()
    if sb is not None:
        try:
            sb.table("ai_cache").upsert(
                {"key": key, "data": data}, on_conflict="key"
            ).execute()
            logger.info("Supabase 캐시 저장: %s", key)
        except Exception as e:
            logger.warning("Supabase 캐시 저장 실패, 파일 fallback: %s", e)
    _save_cache_file(key, data)


def _call_gemini_sync(client, prompt: str) -> str | None:
    """Gemini API 호출 (동기, to_thread로 래핑하여 사용). 모델 후보 순으로 시도."""
    from google import genai
    config = genai.types.GenerateContentConfig(temperature=0.4, max_output_tokens=1200)
    for model_name in _MODEL_CANDIDATES:
        try:
            response = client.models.generate_content(
                model=model_name,
                contents=prompt,
                config=config,
            )
            logger.info("Gemini 호출 성공: %s", model_name)
            return response.text.strip()
        except Exception as e:
            logger.warning("Gemini 모델 %s 실패, 다음 후보 시도: %s", model_name, e)
    return None


async def _enrich_single(client, course: dict, mobility_types: list[str], days: int) -> dict:
    """단일 코스를 저장 이유 또는 Gemini로 보강한다."""
    key = _cache_key(course, mobility_types)
    cached = _load_cache(key)
    if cached:
        logger.info("추천 이유 캐시 히트: %s", course["name"][:20])
        return _apply_ai(course, cached)

    if client is None:
        return course

    try:
        global _gemini_last_call
        async with _gemini_lock:
            elapsed = time.time() - _gemini_last_call
            if elapsed < _GEMINI_MIN_INTERVAL:
                await asyncio.sleep(_GEMINI_MIN_INTERVAL - elapsed)
            _gemini_last_call = time.time()

        prompt = _build_single_prompt(course, mobility_types, days)
        raw = await asyncio.to_thread(_call_gemini_sync, client, prompt)
        if not raw:
            return course
        json_match = re.search(r'\{.*\}', raw, re.DOTALL)
        if not json_match:
            return course

        ai = json.loads(json_match.group())
        _save_cache(key, ai)
        return _apply_ai(course, ai)
    except Exception as e:
        logger.warning(f"Gemini 단일 코스 실패: {e}")
        return course


def _apply_ai(course: dict, ai: dict) -> dict:
    """AI 데이터를 코스/스팟에 병합."""
    spot_guides = ai.get("spot_guides", [])
    guide_map = {g["name"]: g for g in spot_guides if isinstance(g, dict) and "name" in g}
    enriched_spots = []
    for j, spot in enumerate(course.get("spots", [])):
        guide = guide_map.get(spot["name"], spot_guides[j] if j < len(spot_guides) else {})
        enriched_spots.append({
            **spot,
            "ai_why": guide.get("why", "") if isinstance(guide, dict) else "",
            "ai_point": guide.get("point", "") if isinstance(guide, dict) else "",
        })
    return {
        **course,
        "spots": enriched_spots,
        "ai_description": ai.get("ai_description", ""),
        "ai_highlights": ai.get("ai_highlights", []),
        "ai_tip": ai.get("ai_tip", ""),
    }


async def enrich_courses(
    courses: list[dict],
    mobility_types: list[str],
    days: int,
) -> list[dict]:
    """저장된 추천 이유를 우선 적용하고, 없는 경로만 Gemini로 보강한다."""
    if not courses:
        return courses

    client = _get_client()
    tasks = [_enrich_single(client, c, mobility_types, days) for c in courses]
    return list(await asyncio.gather(*tasks))
