"""
프론트엔드 Critical 버그 수정 검증 테스트 (Batch2)
브라우저 없이 course.js 소스 파싱으로 함수 존재·패턴 확인.
"""
import re
import unittest
from pathlib import Path

COURSE_JS = Path("frontend/js/course.js").read_text(encoding="utf-8")
COURSE_HTML = Path("frontend/course.html").read_text(encoding="utf-8")
ONBOARDING_JS = Path("frontend/js/onboarding.js").read_text(encoding="utf-8")
RESULTS_JS = Path("frontend/js/results.js").read_text(encoding="utf-8")
SERVICE_WORKER_JS = Path("frontend/sw.js").read_text(encoding="utf-8")


class FrontendBugFixTests(unittest.TestCase):

    # B-001: kakaoLoader 실패 시 null 리셋
    def test_b001_kakaoloader_reset_on_reject(self):
        """실패 시 kakaoLoader = null 리셋 코드가 존재해야 한다."""
        self.assertIn("kakaoLoader = null", COURSE_JS,
                      "B-001: doReject 내 kakaoLoader = null 리셋 누락")
        self.assertIn("doReject", COURSE_JS,
                      "B-001: doReject 래퍼 함수 누락")

    # B-002: fetchRoadPath 내 loadKakaoSdk 호출 보장
    def test_b002_fetchroadpath_awaits_sdk(self):
        """fetchRoadPath 함수 본문에 await loadKakaoSdk() 가 있어야 한다."""
        # fetchRoadPath 함수 바디만 추출
        m = re.search(
            r'async function fetchRoadPath\(spotList\)\s*\{(.+?)^\s*\}',
            COURSE_JS, re.DOTALL | re.MULTILINE
        )
        self.assertIsNotNone(m, "fetchRoadPath 함수를 찾을 수 없음")
        body = m.group(1)
        self.assertIn("await loadKakaoSdk()", body,
                      "B-002: fetchRoadPath 내 await loadKakaoSdk() 누락")

    # B-002: optional chaining 가드 존재
    def test_b002_optional_chaining_guard(self):
        """kakao?.maps?.LatLng optional chaining 가드가 있어야 한다."""
        self.assertIn("kakao?.maps?.LatLng", COURSE_JS,
                      "B-002: kakao?.maps?.LatLng optional chaining 누락")

    # B-003: estimateLeg 함수 정의 존재
    def test_b003_estimateleg_defined(self):
        """estimateLeg 함수가 정의되어 있어야 한다."""
        self.assertRegex(COURSE_JS, r'function estimateLeg\s*\(',
                         "B-003: estimateLeg 함수 미정의")

    # B-004: transportEmoji 함수 정의 존재 + 매핑 포함
    def test_b004_transportemoji_defined(self):
        """transportEmoji 함수가 정의되어 있어야 하며 walk/transit/car 매핑이 있어야 한다."""
        self.assertRegex(COURSE_JS, r'function transportEmoji\s*\(',
                         "B-004: transportEmoji 함수 미정의")
        m = re.search(
            r'function transportEmoji\s*\([^)]*\)\s*\{([^}]+)\}',
            COURSE_JS
        )
        self.assertIsNotNone(m, "transportEmoji 함수 본문을 파싱할 수 없음")
        body = m.group(1)
        for mode in ("walk", "transit", "car"):
            self.assertIn(mode, body,
                          f"B-004: transportEmoji에 '{mode}' 매핑 누락")

    # B-005: runtime-config.js defer 속성
    def test_b005_runtime_config_deferred(self):
        """course.html의 runtime-config.js 스크립트 태그에 defer가 있어야 한다."""
        self.assertRegex(
            COURSE_HTML,
            r'<script[^>]+runtime-config\.js[^>]+defer',
            "B-005: runtime-config.js 스크립트에 defer 속성 누락"
        )

    # B-005: waitForKakaoKey 대기 로직 존재
    def test_b005_wait_for_kakao_key(self):
        """course.js에 KAKAO_MAP_KEY 대기 함수가 있어야 한다."""
        self.assertIn("waitForKakaoKey", COURSE_JS,
                      "B-005: waitForKakaoKey 대기 함수 누락")
        self.assertIn("await waitForKakaoKey()", COURSE_JS,
                      "B-005: waitForKakaoKey 호출 누락")

    # B-006: 정상 렌더된 카카오맵을 타일 이벤트 오탐으로 덮어쓰지 않음
    def test_b006_no_tile_event_based_mock_fallback(self):
        """카카오 타일 이벤트 감시 실패만으로 mock 지도로 전환하지 않아야 한다."""
        self.assertNotIn("tilesloaded", COURSE_JS,
                         "B-006: tilesloaded 이벤트 기반 mock 폴백은 정상 지도를 오탐으로 덮어쓸 수 있음")
        self.assertNotIn("Course map: Kakao 타일 로드 실패", COURSE_JS,
                         "B-006: 타일 로드 타임아웃 기반 mock 폴백 로그가 남아 있음")

    # B-007: 다른 지도 화면도 타일 이벤트 오탐 폴백을 사용하지 않음
    def test_b007_no_tile_event_fallback_in_other_map_screens(self):
        """온보딩/결과 지도도 tilesloaded 타임아웃만으로 폴백하지 않아야 한다."""
        self.assertNotIn("tilesloaded", ONBOARDING_JS,
                         "B-007: 온보딩 지도에 tilesloaded 기반 폴백이 남아 있음")
        self.assertNotIn("tilesloaded", RESULTS_JS,
                         "B-007: 결과 지도에 tilesloaded 기반 폴백이 남아 있음")

    # B-008: 배포 후 이전 course.js 캐시 재사용 방지
    def test_b008_course_script_is_cache_busted_and_sw_version_bumped(self):
        """course.html은 버전 쿼리로 course.js를 로드하고 서비스워커 캐시 버전은 갱신되어야 한다."""
        self.assertRegex(
            COURSE_HTML,
            r'<script[^>]+src="/js/course\.js\?v=[^"]+"[^>]*defer',
            "B-008: course.js 스크립트에 캐시 무효화 버전 쿼리가 필요함"
        )
        self.assertNotIn("CACHE_VERSION = 'd'", SERVICE_WORKER_JS,
                         "B-008: 이전 서비스워커 캐시 버전 d가 남아 있어 오래된 JS 캐시를 재사용할 수 있음")

    # B-010: searchPlacesFallback 함수 정의 + try-catch 보호
    def test_b010_searchplacesfallback_defined_and_safe(self):
        """searchPlacesFallback이 정의되어 있어야 하며 호출부에 try-catch가 있어야 한다."""
        self.assertRegex(COURSE_JS, r'async function searchPlacesFallback\s*\(',
                         "B-010: searchPlacesFallback 함수 미정의")
        # try { ... searchPlacesFallback ... } catch 패턴 확인
        pattern = re.compile(
            r'try\s*\{[^}]*searchPlacesFallback[^}]*\}\s*catch',
            re.DOTALL
        )
        self.assertIsNotNone(pattern.search(COURSE_JS),
                             "B-010: searchPlacesFallback 호출부에 try-catch 보호 누락")


if __name__ == "__main__":
    unittest.main()
