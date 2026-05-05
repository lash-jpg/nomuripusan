"""POST /api/share, GET /api/share/{token} — 일정 공유 엔드포인트 (SQLite 영속화, 24시간 만료)."""

from __future__ import annotations

import json
import logging
import sqlite3
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

import json as _json

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, model_validator

from backend.store import course_store

_SHARE_TTL_HOURS = 24

logger = logging.getLogger(__name__)
router = APIRouter()

_DB_PATH = Path(__file__).resolve().parent.parent / "data" / "share.db"


def _get_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(str(_DB_PATH))
    conn.execute("PRAGMA journal_mode=WAL")
    return conn


def init_share_db() -> None:
    """앱 시작 시 호출하여 테이블을 생성한다."""
    _DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = _get_conn()
    try:
        conn.execute(
            """CREATE TABLE IF NOT EXISTS shares (
                token TEXT PRIMARY KEY,
                course_json TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                expires_at TIMESTAMP NOT NULL
            )"""
        )
        # 기존 테이블에 expires_at 컬럼이 없는 경우 마이그레이션
        try:
            conn.execute("SELECT expires_at FROM shares LIMIT 1")
        except sqlite3.OperationalError:
            conn.execute("ALTER TABLE shares ADD COLUMN expires_at TIMESTAMP")
            conn.execute(
                "UPDATE shares SET expires_at = datetime(created_at, '+24 hours') WHERE expires_at IS NULL"
            )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_shares_expires ON shares(expires_at)")
        conn.commit()
    finally:
        conn.close()
    logger.info("share DB 초기화 완료: %s", _DB_PATH)


def cleanup_expired_shares() -> int:
    """만료된 공유 링크를 DB에서 삭제하고 삭제된 행 수를 반환한다."""
    conn = _get_conn()
    try:
        cur = conn.execute(
            "DELETE FROM shares WHERE expires_at < ?",
            (datetime.now(timezone.utc).isoformat(),),
        )
        conn.commit()
        deleted = cur.rowcount
        if deleted:
            logger.info("만료 공유 링크 %d건 삭제", deleted)
        return deleted
    finally:
        conn.close()


_MAX_COURSE_BYTES = 64 * 1024  # 64 KB


class ShareRequest(BaseModel):
    course_id: str | None = None
    course: dict | None = None

    @model_validator(mode="after")
    def _check_payload_size(self):
        if self.course is not None:
            size = len(_json.dumps(self.course, ensure_ascii=False).encode())
            if size > _MAX_COURSE_BYTES:
                raise ValueError(f"course 페이로드가 너무 큽니다 ({size} bytes > {_MAX_COURSE_BYTES})")
        return self


class ShareResponse(BaseModel):
    token: str
    url: str


@router.post("/api/share", response_model=ShareResponse)
async def create_share(req: ShareRequest):
    course = course_store.get(req.course_id) if req.course_id else None
    if not course and req.course:
        course = req.course
    if not course:
        raise HTTPException(status_code=404, detail="코스를 찾을 수 없습니다.")
    course_id = course.get("id")
    if not course_id:
        raise HTTPException(status_code=400, detail="공유할 코스 데이터에 id가 필요합니다.")

    course_store.put(course_id, course)
    expires_at = datetime.now(timezone.utc) + timedelta(hours=_SHARE_TTL_HOURS)
    token = None

    conn = _get_conn()
    try:
        for _ in range(3):
            candidate = uuid.uuid4().hex[:16]
            try:
                conn.execute(
                    "INSERT INTO shares (token, course_json, expires_at) VALUES (?, ?, ?)",
                    (candidate, json.dumps(course, ensure_ascii=False), expires_at.isoformat()),
                )
                conn.commit()
                token = candidate
                break
            except sqlite3.IntegrityError:
                continue
    except Exception as e:
        logger.error("공유 링크 저장 실패: %s", e)
        raise HTTPException(status_code=500, detail="공유 링크 저장에 실패했습니다.")
    finally:
        conn.close()

    if not token:
        logger.error("공유 토큰 생성 3회 충돌")
        raise HTTPException(status_code=500, detail="공유 링크 생성에 실패했습니다.")

    return {"token": token, "url": f"/share.html?token={token}"}


@router.get("/api/share/{token}")
async def get_share(token: str):
    if not token or len(token) > 32 or not token.isalnum():
        raise HTTPException(status_code=400, detail="유효하지 않은 공유 토큰입니다.")
    conn = _get_conn()
    try:
        row = conn.execute(
            "SELECT course_json, expires_at FROM shares WHERE token = ?", (token,)
        ).fetchone()
    finally:
        conn.close()

    if not row:
        raise HTTPException(status_code=404, detail="공유 링크를 찾을 수 없습니다.")

    # 만료 체크
    if row[1]:
        try:
            expires_at = datetime.fromisoformat(row[1])
            if expires_at.tzinfo is None:
                expires_at = expires_at.replace(tzinfo=timezone.utc)
            if datetime.now(timezone.utc) > expires_at:
                raise HTTPException(status_code=410, detail="공유 링크가 만료되었습니다. (24시간 경과)")
        except (ValueError, TypeError):
            # 파싱 실패한 expires_at은 보수적으로 만료 처리
            raise HTTPException(status_code=410, detail="공유 링크가 만료되었습니다.")

    return json.loads(row[0])
