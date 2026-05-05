import asyncio
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from backend import main as main_mod
from backend.services import gemini as gemini_mod
from backend.services.reason_store import RouteReasonStore


class GeminiReasonTests(unittest.TestCase):
    def _course(self) -> dict:
        return {
            "id": "course-reason-1",
            "name": "광안리 저피로 코스",
            "spots": [
                {
                    "id": "spot-gwangalli",
                    "name": "광안리해수욕장",
                    "category": "해수욕장",
                    "accessibility_grade": 5,
                    "visit_time_min": 50,
                    "slope_pct": 1,
                }
            ],
            "total_time_min": 60,
            "total_fatigue": 10.0,
            "distance_km": 1.0,
        }

    def _reason(self) -> dict:
        return {
            "ai_description": "저장된 경로별 추천 이유입니다.",
            "ai_highlights": ["저장 이유", "저피로"],
            "ai_tip": "해변 산책로 중심으로 이동하면 부담이 적습니다.",
            "spot_guides": [
                {
                    "name": "광안리해수욕장",
                    "why": "완만한 해변 산책로로 접근성이 좋습니다.",
                    "point": "광안대교 전망을 보며 쉬어가기 좋습니다.",
                }
            ],
        }

    def test_gemini_api_key_is_not_required_for_startup(self):
        self.assertNotIn("GEMINI_API_KEY", main_mod._REQUIRED_ENV_VARS)

    def test_reason_store_loads_seeded_route_reasons(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            seed_path = tmp_path / "course_reason_seeds.json"
            seed_path.write_text(
                json.dumps(
                    [
                        {
                            "key": "route-key-1",
                            "source": "seed",
                            "data": self._reason(),
                        }
                    ],
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )

            store = RouteReasonStore(
                db_path=tmp_path / "recommendation_reasons.db",
                seed_path=seed_path,
            )

            self.assertEqual(store.get("route-key-1"), self._reason())

    def test_enrich_courses_uses_stored_reason_without_gemini_client(self):
        course = self._course()
        reason = self._reason()

        with patch.object(gemini_mod, "_get_client", return_value=None), \
             patch.object(gemini_mod, "_load_cache", return_value=reason), \
             patch.object(gemini_mod, "_call_gemini_sync") as call_mock:
            result = asyncio.run(
                gemini_mod.enrich_courses([course], ["wheelchair"], 1)
            )

        self.assertEqual(result[0]["ai_description"], "저장된 경로별 추천 이유입니다.")
        self.assertEqual(result[0]["spots"][0]["ai_why"], "완만한 해변 산책로로 접근성이 좋습니다.")
        call_mock.assert_not_called()

    def test_enrich_courses_omits_reason_when_no_store_and_no_gemini_client(self):
        course = self._course()

        with patch.object(gemini_mod, "_get_client", return_value=None), \
             patch.object(gemini_mod, "_load_cache", return_value=None), \
             patch.object(gemini_mod, "_call_gemini_sync") as call_mock:
            result = asyncio.run(
                gemini_mod.enrich_courses([course], ["wheelchair"], 1)
            )

        self.assertNotIn("ai_description", result[0])
        call_mock.assert_not_called()


if __name__ == "__main__":
    unittest.main()
