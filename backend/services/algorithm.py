"""피로도 계산 및 코스 추천 알고리즘."""

from __future__ import annotations

import math
import uuid
from typing import Any

# ── 유형별 가중치 (차별화 완료) ──────────────────────────────────
# CTO/CEO/CDO 합의: 4유형 모두 실질 차이가 나도록 재조정
WEIGHTS: dict[str, dict[str, float]] = {
    "wheelchair": {"distance": 0.4, "slope": 8.0, "wait": 0.8},   # 경사로·엘리베이터 필수
    "stroller":   {"distance": 0.35, "slope": 7.0, "wait": 1.0},  # 유아차 접근로 필수 (아이 동반 대기 피로 반영)
    "senior":     {"distance": 0.35, "slope": 5.0, "wait": 1.2},  # 경사 덜 민감, 대기·체력에 민감
    "carrier":    {"distance": 0.3, "slope": 10.0, "wait": 0.5},  # 평탄 노면 최우선, 단차 매우 민감
}

# 시니어: 쉼터 있는 관광지 가산점 (score가 낮을수록 우선)
SENIOR_REST_BONUS_M = -400.0
# 행사/축제: 코스에 반드시 포함되도록 강한 가산점 (거리 단위=미터 기준)
FESTIVAL_BONUS_M = -6000.0

# 시니어: 경사도 상한 (이 이상이면 필터 아웃)
SENIOR_MAX_SLOPE_PCT = 8.0
# 보행보조기: 경사도 상한 (이 이상이면 필터 아웃)
CARRIER_MAX_SLOPE_PCT = 5.0

MODE_LABELS = {"walk": "도보", "transit": "대중교통", "car": "차량"}

MAX_DAILY_MINUTES = 300       # 5시간 — UI "5h 하루 이내 저피로" 카피와 일치
MAX_DAILY_FATIGUE = 150.0     # 실제 필터로 작동하도록 재튜닝 (하루 중간 피로도 + 경사·대기 반영 시 150 근처 도달)
CATEGORY_REPEAT_PENALTY_M = 700.0
AREA_REPEAT_PENALTY_M = 250.0
NUM_ALTERNATIVES = 3  # 하루 당 대안 코스 수
MIN_SPOTS_PER_DAY = 4  # 멀티데이 스팟 재사용 임계치 계산 기준

# ── 날씨 연동 ─────────────────────────────────────────────────────
# 비 오는 날: 실외 스팟 페널티, 실내 스팟 보너스
RAIN_OUTDOOR_PENALTY_M = 800.0   # 실외 스팟 점수 악화 (큰 값 = 낮은 우선순위)
RAIN_INDOOR_BONUS_M = -600.0     # 실내 스팟 점수 개선 (음수 = 높은 우선순위)
OUTDOOR_CATEGORIES = {"해수욕장", "자연", "공원", "산책", "거리", "마을", "사찰"}


def _is_indoor(spot: dict) -> bool:
    """실내 스팟 여부: 태그에 '실내' 포함 또는 카테고리가 실내 중심인 경우."""
    tags = spot.get("tags", [])
    if "실내" in tags:
        return True
    return spot.get("category") in {"쇼핑", "문화"} and "실외" not in tags


def _is_outdoor(spot: dict) -> bool:
    return spot.get("category") in OUTDOOR_CATEGORIES


def _worst_case_weights(mobility_types: list[str]) -> dict[str, float]:
    if not mobility_types:
        mobility_types = ["carrier"]
    result = {"distance": 0.0, "slope": 0.0, "wait": 0.0}
    for mt in mobility_types:
        w = WEIGHTS.get(mt, WEIGHTS["carrier"])
        for key in result:
            result[key] = max(result[key], w[key])
    return result


def calc_fatigue(distance_m: float, slope_pct: float, wait_min: float, weights: dict[str, float]) -> float:
    return (distance_m / 1000.0) * weights["distance"] + slope_pct * weights["slope"] + wait_min * weights["wait"]


def _distance_between(a: dict, b: dict) -> float:
    radius = 6_371_000
    lat1, lat2 = math.radians(a["lat"]), math.radians(b["lat"])
    dlat = lat2 - lat1
    dlng = math.radians(b["lng"] - a["lng"])
    h = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlng / 2) ** 2
    return 2 * radius * math.asin(min(1.0, math.sqrt(h)))


def _filter_spots(spots: list[dict], mobility_types: list[str], areas: list[str]) -> list[dict]:
    """유형별 차별화 필터링. 다중 선택 시 AND — 모든 유형을 동시 충족해야 통과."""
    filtered = []
    for spot in spots:
        if areas and spot["area"] not in areas:
            continue
        accessible = True
        for mt in mobility_types:
            if mt == "wheelchair":
                # 휠체어: wheelchair_accessible boolean 필수
                if not spot.get("wheelchair_accessible", False):
                    accessible = False
                    break
            elif mt == "stroller":
                # 유아차: stroller_accessible boolean 필수
                if not spot.get("stroller_accessible", False):
                    accessible = False
                    break
            elif mt == "senior":
                # 시니어: 등급 3 이상 + 경사 8% 이하 (급경사 코스 차단)
                if spot.get("accessibility_grade", 0) < 3:
                    accessible = False
                    break
                if spot.get("slope_pct", 0) > SENIOR_MAX_SLOPE_PCT:
                    accessible = False
                    break
            elif mt == "carrier":
                # 보행보조기: 등급 3 이상 + 경사 5% 이하 (가장 엄격)
                if spot.get("accessibility_grade", 0) < 3:
                    accessible = False
                    break
                if spot.get("slope_pct", 0) > CARRIER_MAX_SLOPE_PCT:
                    accessible = False
                    break
        if accessible:
            filtered.append(spot)
    return filtered


def _estimate_leg(distance_m: float, mobility_types: list[str]) -> dict[str, Any]:
    # 유형별 도보·대중교통 임계값 차별화
    walk_thresholds = {"wheelchair": 600, "carrier": 500, "senior": 800, "stroller": 700}
    transit_thresholds = {"wheelchair": 2000, "carrier": 1800, "senior": 2500, "stroller": 2200}

    walk_threshold = min((walk_thresholds.get(mt, 1000) for mt in mobility_types), default=1000)
    transit_threshold = min((transit_thresholds.get(mt, 4500) for mt in mobility_types), default=4500)

    walk_distance_m = distance_m * 1.18
    transit_distance_m = distance_m * 1.33
    car_distance_m = distance_m * 1.24
    walk_time_min = max(3, round(walk_distance_m / 3000 * 60))
    transit_time_min = max(10, round(transit_distance_m / 18000 * 60 + 8))
    car_time_min = max(6, round(car_distance_m / 26000 * 60 + 5))

    if distance_m <= walk_threshold:
        mode, rec_dist, rec_time = "walk", walk_distance_m, walk_time_min
    elif distance_m <= transit_threshold:
        mode, rec_dist, rec_time = "transit", transit_distance_m, transit_time_min
    else:
        mode, rec_dist, rec_time = "car", car_distance_m, car_time_min

    return {
        "straight_distance_m": round(distance_m),
        "recommended_mode": mode,
        "recommended_label": MODE_LABELS[mode],
        "recommended_distance_m": round(rec_dist),
        "recommended_time_min": rec_time,
        "walk_time_min": walk_time_min,
        "transit_time_min": transit_time_min,
        "car_time_min": car_time_min,
    }


def _candidate_penalty(route_spots: list[dict], spot: dict) -> float:
    used_categories = {s["category"] for s in route_spots}
    used_areas = {s["area"] for s in route_spots}
    penalty = 0.0
    if spot["category"] in used_categories:
        penalty += CATEGORY_REPEAT_PENALTY_M
    if spot["area"] in used_areas:
        penalty += AREA_REPEAT_PENALTY_M
    return penalty


def _build_day_course(
    start: dict,
    pool: list[dict],
    weights: dict[str, float],
    mobility_types: list[str],
    day: int,
    total_days: int,
    alt_idx: int,
    is_rainy: bool = False,
    dist_matrix: dict[tuple[str, str], float] | None = None,
) -> dict[str, Any] | None:
    """단일 시작점에서 그리디로 하루 코스를 구성한다."""
    day_spots: list[dict] = [start]
    legs: list[dict] = []
    used_ids: set[str] = {start["id"]}
    total_time = float(start["visit_time_min"])
    total_fatigue = calc_fatigue(0, start["slope_pct"], start["wait_time_min"], weights)
    total_distance = 0.0

    while True:
        current = day_spots[-1]
        candidates = [s for s in pool if s["id"] not in used_ids]
        if not candidates:
            break

        has_senior = "senior" in mobility_types
        ranked = []
        for spot in candidates:
            key = (current["id"], spot["id"])
            dist_m = dist_matrix.get(key) if dist_matrix else None
            if dist_m is None:
                dist_m = _distance_between(current, spot)
            leg = _estimate_leg(dist_m, mobility_types)
            seg_fatigue = calc_fatigue(leg["recommended_distance_m"], spot["slope_pct"], spot["wait_time_min"], weights)
            seg_time = leg["recommended_time_min"] + spot["visit_time_min"]
            score = leg["recommended_distance_m"] + _candidate_penalty(day_spots, spot)
            # 시니어: 쉼터(화장실) 있는 곳 우선 선택
            if has_senior and spot.get("restroom_accessible"):
                score += SENIOR_REST_BONUS_M
            # 행사/축제: 강한 우선순위로 코스에 포함
            if spot.get("_festival"):
                score += FESTIVAL_BONUS_M
            # 날씨: 비 오는 날 실외 페널티, 실내 보너스
            if is_rainy:
                if _is_outdoor(spot):
                    score += RAIN_OUTDOOR_PENALTY_M
                elif _is_indoor(spot):
                    score += RAIN_INDOOR_BONUS_M
            ranked.append((score, spot, leg, seg_fatigue, seg_time))

        ranked.sort(key=lambda x: x[0])

        added = False
        for _, spot, leg, seg_fatigue, seg_time in ranked:
            if total_time + seg_time > MAX_DAILY_MINUTES:
                continue
            if total_fatigue + seg_fatigue > MAX_DAILY_FATIGUE:
                continue
            day_spots.append(spot)
            legs.append({
                "from_id": current["id"],
                "to_id": spot["id"],
                "recommended_mode": leg["recommended_mode"],
                "recommended_label": leg["recommended_label"],
                "recommended_distance_m": leg["recommended_distance_m"],
                "route_distance_km": round(leg["recommended_distance_m"] / 1000, 1),
                "recommended_time_min": leg["recommended_time_min"],
                "walk_time_min": leg["walk_time_min"],
                "transit_time_min": leg["transit_time_min"],
                "car_time_min": leg["car_time_min"],
                "straight_distance_m": leg["straight_distance_m"],
            })
            used_ids.add(spot["id"])
            total_time += seg_time
            total_fatigue += seg_fatigue
            total_distance += leg["recommended_distance_m"]
            added = True
            break

        if not added:
            break

    if len(day_spots) < 2:
        return None

    rest_spots = sum(1 for s in day_spots if s.get("restroom_accessible"))
    areas_in_course = list(dict.fromkeys(s["area"] for s in day_spots))
    area_name = " · ".join(areas_in_course[:2]) if len(areas_in_course) > 1 else areas_in_course[0]
    grade_avg = sum(s.get("accessibility_grade", 3) for s in day_spots) / len(day_spots)

    categories = [s["category"] for s in day_spots]
    if any(c in ("해수욕장",) for c in categories) and any(c in ("공원", "산책") for c in categories):
        theme = "해변 힐링"
    elif any(c in ("시장", "거리") for c in categories):
        theme = "먹거리 탐방"
    elif any(c in ("문화", "전망") for c in categories):
        theme = "문화 산책"
    elif len(areas_in_course) >= 3:
        theme = "부산 투어"
    elif grade_avg >= 4.5:
        theme = "평지 힐링"
    elif grade_avg >= 3.5:
        theme = "무장애 탐방"
    else:
        theme = "접근 가능"

    alt_suffix = ["", " (B코스)", " (C코스)"]
    day_label = f" Day {day}" if total_days > 1 else ""
    suffix = alt_suffix[alt_idx] if alt_idx < len(alt_suffix) else f" ({alt_idx + 1}번)"

    return {
        "id": f"c{day:03d}_{uuid.uuid4().hex[:6]}",
        "name": f"{area_name} {theme} 코스{day_label}{suffix}",
        "day": day,
        "spots": day_spots,
        "legs": legs,
        "total_time_min": round(total_time),
        "total_fatigue": round(total_fatigue, 1),
        "distance_km": round(total_distance / 1000, 1),
        "rest_spots": rest_spots,
        "accessibility_avg": round(grade_avg, 1),
    }


# 페르소나별 Day1 시작 선호 권역 (접근성 기준 충족 스팟 중에서 앞으로 배치)
_PERSONA_PREFERRED_AREA: dict[str, str] = {
    "wheelchair": "수영",   # 광안리권 — 평지·해변 산책로
    "stroller":   "해운대", # 해운대권 — 유아 친화 시설 밀집
    "senior":     "중구",   # 남포권 — 대중교통 접근성 우수
    "carrier":    "기장",   # 기장권 — 평탄 노면·한적한 환경
}


def _reorder_pool_for_persona(
    pool: list[dict], mobility_types: list[str]
) -> list[dict]:
    """페르소나별 선호 권역 스팟을 풀 앞으로 배치해 Day1 출발 권역을 다양화한다.
    단일 페르소나가 선택됐을 때만 적용하며, 접근성 기준은 변경하지 않는다."""
    if len(mobility_types) != 1:
        return pool
    preferred = _PERSONA_PREFERRED_AREA.get(mobility_types[0])
    if not preferred:
        return pool
    preferred_spots = [s for s in pool if s["area"] == preferred]
    other_spots = [s for s in pool if s["area"] != preferred]
    return preferred_spots + other_spots


def recommend_courses(
    spots: list[dict],
    mobility_types: list[str],
    days: int,
    areas: list[str],
    is_rainy: bool = False,
) -> list[dict[str, Any]]:
    """피로도·접근성 기반 코스 추천. 하루 당 최대 3개 대안 코스를 반환한다."""
    weights = _worst_case_weights(mobility_types)
    filtered = _filter_spots(spots, mobility_types, areas)
    if not filtered:
        return []

    # 피로도 오름차순 정렬 후 페르소나별 선호 권역 스팟을 앞으로 배치
    pool = sorted(filtered, key=lambda s: calc_fatigue(0, s["slope_pct"], s["wait_time_min"], weights))
    # areas 지정이 없는 경우에만 다양성 재정렬 적용 (특정 권역 요청 시 덮어쓰지 않음)
    if not areas:
        pool = _reorder_pool_for_persona(pool, mobility_types)

    # 거리 행렬 사전 계산 (O(N²) 중복 제거)
    dist_matrix: dict[tuple[str, str], float] = {}
    for i, a in enumerate(pool):
        for b in pool[i+1:]:
            d = _distance_between(a, b)
            dist_matrix[(a["id"], b["id"])] = d
            dist_matrix[(b["id"], a["id"])] = d

    all_courses: list[dict[str, Any]] = []
    global_used_ids: set[str] = set()  # 이전 day에서 이미 사용한 스팟 추적

    # 멀티데이 요청인데 풀이 너무 작을 때: 스팟 재사용 임계치 계산
    reuse_threshold = MIN_SPOTS_PER_DAY * max(1, days)

    for day in range(1, days + 1):
        # 풀이 너무 작으면 재사용 허용 (좁은 권역에서 멀티데이 가능하도록)
        if len(pool) < reuse_threshold:
            day_pool = pool  # 전체 풀 재사용
        else:
            day_pool = [s for s in pool if s["id"] not in global_used_ids]

        if not day_pool:
            # 그래도 비면 강제로 전체 풀 사용
            day_pool = pool
            if not day_pool:
                break

        # 서로 다른 권역 시작점으로 NUM_ALTERNATIVES개 대안 코스 생성
        used_start_areas: list[str] = []
        alt_idx = 0
        primary_spot_ids: set[str] = set()  # 이 day의 primary 코스 스팟 (다음 day에 제외)

        # 재사용 모드에서는 day별로 다른 시작점부터 시작하여 코스를 변화시킴
        start_offset = (day - 1) * 2 if len(pool) < reuse_threshold else 0
        ordered_pool = day_pool[start_offset:] + day_pool[:start_offset]

        # 단일 권역 필터 시(혹은 풀 전체가 동일 권역)에는 권역 다양성 제약을 완화한다.
        pool_areas = {s["area"] for s in day_pool}
        multi_area_pool = len(pool_areas) > 1

        for start in ordered_pool:
            if alt_idx >= NUM_ALTERNATIVES:
                break
            # 다른 코스와 다른 시작 권역 선호 (앞 2개는 강제, 나머지는 허용)
            # 단일 권역 풀에서는 이 제약이 대안 코스 생성을 막으므로 완화한다.
            if multi_area_pool and start["area"] in used_start_areas and alt_idx < 2:
                continue

            course = _build_day_course(start, day_pool, weights, mobility_types, day, days, alt_idx, is_rainy, dist_matrix)
            if course and len(course["spots"]) >= 2:
                all_courses.append(course)
                used_start_areas.append(start["area"])
                # primary 코스(alt_idx==0)의 스팟만 global에서 제외 (풀이 충분할 때만)
                if alt_idx == 0 and len(pool) >= reuse_threshold:
                    primary_spot_ids = {s["id"] for s in course["spots"]}
                alt_idx += 1

        global_used_ids.update(primary_spot_ids)

    return all_courses
