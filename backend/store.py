"""CourseStore — in-memory + SQLite 영속화 코스 캐시.

컨테이너 재시작 시에도 최근 추천 코스를 복구할 수 있도록 SQLite에 병행 저장한다.
TTL 24시간 — share 링크 만료와 동일하여 일관된 UX 보장.
"""
from __future__ import annotations

import json
import logging
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path

logger = logging.getLogger(__name__)

_DB_PATH = Path(__file__).resolve().parent / "data" / "courses.db"
_COURSE_TTL_HOURS = 24


class CourseStore:
    """코스 캐시: 메모리 우선 조회, 미스 시 SQLite에서 복구."""

    def __init__(self) -> None:
        self._data: dict[str, dict] = {}
        self._init_db()

    def _init_db(self) -> None:
        _DB_PATH.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(str(_DB_PATH))
        try:
            conn.execute(
                """CREATE TABLE IF NOT EXISTS courses (
                    id TEXT PRIMARY KEY,
                    course_json TEXT NOT NULL,
                    expires_at TIMESTAMP NOT NULL
                )"""
            )
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_courses_expires ON courses(expires_at)"
            )
            conn.commit()
        finally:
            conn.close()

    def _conn(self) -> sqlite3.Connection:
        conn = sqlite3.connect(str(_DB_PATH))
        conn.execute("PRAGMA journal_mode=WAL")
        return conn

    def get(self, course_id: str) -> dict | None:
        cached = self._data.get(course_id)
        if cached is not None:
            return cached
        # 컨테이너 재시작 후에도 /api/courses/{id} 가 살아있도록 SQLite fallback
        try:
            conn = self._conn()
            try:
                row = conn.execute(
                    "SELECT course_json, expires_at FROM courses WHERE id = ?",
                    (course_id,),
                ).fetchone()
            finally:
                conn.close()
        except Exception as e:
            logger.warning("코스 DB 조회 실패 (id=%s): %s", course_id, e)
            return None
        if not row:
            return None
        try:
            expires_at = datetime.fromisoformat(row[1])
            if expires_at.tzinfo is None:
                expires_at = expires_at.replace(tzinfo=timezone.utc)
            if datetime.now(timezone.utc) > expires_at:
                return None
        except (ValueError, TypeError):
            return None
        course = json.loads(row[0])
        self._data[course_id] = course
        return course

    def put(self, course_id: str, course: dict) -> None:
        self._data[course_id] = course
        expires_at = datetime.now(timezone.utc) + timedelta(hours=_COURSE_TTL_HOURS)
        try:
            conn = self._conn()
            try:
                conn.execute(
                    "INSERT OR REPLACE INTO courses (id, course_json, expires_at) VALUES (?, ?, ?)",
                    (course_id, json.dumps(course, ensure_ascii=False), expires_at.isoformat()),
                )
                conn.commit()
            finally:
                conn.close()
        except Exception as e:
            # 영속화 실패는 치명적이지 않음 — 메모리 캐시로만 동작
            logger.warning("코스 영속화 실패 (id=%s): %s", course_id, e)

    def put_many(self, courses: list[dict]) -> None:
        for c in courses:
            if "id" in c:
                self.put(c["id"], c)

    def clear(self) -> None:
        self._data.clear()
        try:
            conn = self._conn()
            try:
                conn.execute("DELETE FROM courses")
                conn.commit()
            finally:
                conn.close()
        except Exception as e:
            logger.warning("코스 DB clear 실패: %s", e)

    def cleanup_expired(self) -> int:
        """만료된 코스 레코드 삭제. 반환: 삭제 건수."""
        try:
            conn = self._conn()
            try:
                now_iso = datetime.now(timezone.utc).isoformat()
                # 만료된 ID 목록 조회 후 삭제
                expired_ids = [
                    row[0]
                    for row in conn.execute(
                        "SELECT id FROM courses WHERE expires_at < ?", (now_iso,)
                    ).fetchall()
                ]
                cur = conn.execute(
                    "DELETE FROM courses WHERE expires_at < ?", (now_iso,)
                )
                conn.commit()
                deleted = cur.rowcount
            finally:
                conn.close()
        except Exception as e:
            logger.warning("만료 코스 정리 실패: %s", e)
            return 0
        # 인메모리 dict에서도 만료 항목 제거
        for cid in expired_ids:
            self._data.pop(cid, None)
        if deleted:
            logger.info("만료 코스 %d건 삭제", deleted)
        return deleted


course_store = CourseStore()
