"""RouteReasonStore — 경로별 추천 이유 SQLite 저장소."""
from __future__ import annotations

import json
import logging
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

logger = logging.getLogger(__name__)

_DATA_DIR = Path(__file__).resolve().parent.parent / "data"
_DB_PATH = _DATA_DIR / "recommendation_reasons.db"
_SEED_PATH = _DATA_DIR / "course_reason_seeds.json"


class RouteReasonStore:
    """추천 경로 키별 이유를 SQLite에 저장하고 조회한다."""

    def __init__(
        self,
        db_path: Path | None = None,
        seed_path: Path | None = None,
    ) -> None:
        self._db_path = db_path or _DB_PATH
        self._seed_path = seed_path or _SEED_PATH
        self._disabled = False
        try:
            self._init_db()
        except Exception as e:
            self._disabled = True
            logger.warning("추천 이유 DB 초기화 실패, 저장 이유 없이 동작: %s", e)

    def _conn(self) -> sqlite3.Connection:
        self._db_path.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(str(self._db_path))
        conn.execute("PRAGMA journal_mode=WAL")
        return conn

    def _init_db(self) -> None:
        conn = self._conn()
        try:
            conn.execute(
                """CREATE TABLE IF NOT EXISTS route_reasons (
                    key TEXT PRIMARY KEY,
                    reason_json TEXT NOT NULL,
                    source TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                )"""
            )
            conn.commit()
            self._seed(conn)
        finally:
            conn.close()

    def _seed(self, conn: sqlite3.Connection) -> None:
        if not self._seed_path.exists():
            return
        try:
            records = json.loads(self._seed_path.read_text(encoding="utf-8"))
        except Exception as e:
            logger.warning("추천 이유 seed 로드 실패: %s", e)
            return
        if not isinstance(records, list):
            logger.warning("추천 이유 seed 형식 오류: list가 아님")
            return

        now = datetime.now(timezone.utc).isoformat()
        inserted = 0
        for record in records:
            if not isinstance(record, dict):
                continue
            key = str(record.get("key", "")).strip()
            data = record.get("data")
            source = str(record.get("source") or "seed")
            if not key or not isinstance(data, dict):
                continue
            payload = json.dumps(data, ensure_ascii=False)
            conn.execute(
                """INSERT INTO route_reasons (key, reason_json, source, created_at, updated_at)
                   VALUES (?, ?, ?, ?, ?)
                   ON CONFLICT(key) DO UPDATE SET
                       reason_json = excluded.reason_json,
                       source = excluded.source,
                       updated_at = excluded.updated_at
                   WHERE route_reasons.source = 'seed'""",
                (key, payload, source, now, now),
            )
            inserted += 1
        conn.commit()
        if inserted:
            logger.info("추천 이유 seed %d건 확인", inserted)

    def get(self, key: str) -> dict | None:
        if self._disabled:
            return None
        try:
            conn = self._conn()
            try:
                row = conn.execute(
                    "SELECT reason_json FROM route_reasons WHERE key = ?",
                    (key,),
                ).fetchone()
            finally:
                conn.close()
        except Exception as e:
            logger.warning("추천 이유 DB 조회 실패 (%s): %s", key, e)
            return None
        if not row:
            return None
        try:
            data = json.loads(row[0])
        except Exception as e:
            logger.warning("추천 이유 JSON 파싱 실패 (%s): %s", key, e)
            return None
        return data if isinstance(data, dict) else None

    def put(self, key: str, data: dict, source: str = "gemini") -> None:
        if self._disabled:
            return
        if not key or not isinstance(data, dict):
            return
        now = datetime.now(timezone.utc).isoformat()
        payload = json.dumps(data, ensure_ascii=False)
        try:
            conn = self._conn()
            try:
                conn.execute(
                    """INSERT OR REPLACE INTO route_reasons
                       (key, reason_json, source, created_at, updated_at)
                       VALUES (
                           ?,
                           ?,
                           ?,
                           COALESCE((SELECT created_at FROM route_reasons WHERE key = ?), ?),
                           ?
                       )""",
                    (key, payload, source, key, now, now),
                )
                conn.commit()
            finally:
                conn.close()
        except Exception as e:
            logger.warning("추천 이유 DB 저장 실패 (%s): %s", key, e)


reason_store = RouteReasonStore()
