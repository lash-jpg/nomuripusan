# 무리없이 부산

이동약자, 시니어 동행자, 유아차 동반 가족을 위한 부산 관광 코스 추천 웹앱입니다. 한국관광공사 TourAPI 기반 관광지·행사·숙박 데이터를 활용하고, 접근성 조건·이동 피로도·날씨·여행 기간을 함께 반영해 실행 가능한 저피로 동선을 제안합니다.

- 운영 URL: https://nomuripusan-production.up.railway.app
- 배포 플랫폼: Railway
- 백엔드: FastAPI, Python 3.12
- 프론트엔드: 정적 HTML/CSS/JavaScript, PWA 서비스워커
- 지도: Kakao Maps JavaScript SDK, OSRM 도로 경로 보조

## 주요 기능

- 여행자 조건 입력: 휠체어, 유아차, 시니어, 보행 보조기 등 복수 조건을 선택합니다.
- 부산 권역 기반 추천: 해운대, 남포, 영도, 광안리, 송도, 기장, 서면, 동래, 수영, 사하, 북구, 금정, 강서, 사상, 연제, 부산진 등 권역을 반영합니다.
- 저피로 코스 생성: 거리, 경사, 대기 시간, 접근성 등급, 카테고리 반복, 권역 반복을 점수화해 하루 당 여러 대안 코스를 만듭니다.
- 기간 기반 행사 반영: 여행 시작일이 있으면 해당 기간의 행사/축제를 추천 후보에 포함합니다.
- 날씨 대응: 비 예보가 있을 때 실외 장소에 페널티를 주고 실내 장소를 우선합니다.
- 지도 기반 상세 보기: 코스 상세 화면에서 Kakao 지도, 번호 마커, OSRM 도로 경로 또는 직선 경로를 표시합니다.
- 장소 추가/삭제: 상세 화면에서 코스 중간에 장소를 추가하거나 기존 장소를 제거할 수 있습니다.
- 공유 링크: 추천 코스를 저장하고 공유 가능한 링크를 생성합니다.
- 현장 접근성 신고: 엘리베이터 고장, 화장실 폐쇄, 신규 장애물 등 현장 정보를 제보할 수 있습니다.
- 만족도/행동 로그: 추천 품질 개선을 위한 익명 로그와 설문 데이터를 수집합니다.

## 화면 구성

- `/`: 서비스 소개 및 시작 화면
- `/onboarding.html`: 여행자 유형, 일정, 권역 입력
- `/results.html`: 추천 코스 목록과 지도 개요
- `/course.html`: 코스 상세, 지도, 방문 순서, 장소 추가/삭제, 현장 제보
- `/share.html`: 공유된 일정 카드
- `/offline.html`: 오프라인 안내 화면

## 기술 구조

```text
무리없이부산/
├─ backend/
│  ├─ main.py                  # FastAPI 앱, 보안 헤더, CORS, rate limit, 정적 파일 서빙
│  ├─ routers/                 # 추천, 코스, 공유, 신고, 검색, 메타, 날씨, 로그 API
│  ├─ services/                # TourAPI, 추천 알고리즘, Gemini, Supabase 연동
│  └─ store.py                 # 코스 캐시 저장소
├─ frontend/
│  ├─ *.html                   # 정적 화면
│  ├─ css/style.css            # 디자인 시스템 및 반응형 스타일
│  ├─ js/*.js                  # 화면별 클라이언트 로직
│  ├─ sw.js                    # PWA 캐시 전략
│  └─ manifest.json
├─ tests/
│  ├─ test_api.py
│  ├─ test_algorithm.py
│  ├─ test_frontend_fixes.py
│  └─ e2e/
├─ Dockerfile
├─ requirements.txt
└─ start.sh
```

## API 개요

- `POST /api/recommend`: 여행자 조건과 일정 기반 코스 추천
- `GET /api/courses/{course_id}`: 캐시된 코스 상세 조회
- `POST /api/share`: 공유 링크 생성
- `GET /api/share/{token}`: 공유 코스 조회
- `GET /api/search-places?keyword=...`: 장소 검색 보조
- `GET /api/spot-detail/{content_id}`: TourAPI 상세 정보 조회
- `POST /api/report`: 현장 접근성 제보 등록
- `GET /api/reports/{spot_id}`: 장소별 현장 제보 조회
- `GET /api/weather`: 여행일 기준 날씨 상태 조회
- `GET /api/meta/busan-sigungu`: 부산 시군구 코드 조회
- `GET /api/meta/tour-categories`: 관광 분류 코드 조회
- `POST /api/log/recommend`: 추천 결과 로그
- `POST /api/log/survey`: 만족도 설문 로그
- `POST /api/log/interaction`: 사용자 상호작용 로그
- `GET /runtime-config.js`: 클라이언트 런타임 설정, Kakao 지도 키 주입

## 환경변수

`.env.example`을 기준으로 로컬 `.env` 또는 Railway Variables에 설정합니다.

```env
TOUR_API_KEY=YOUR_TOUR_API_KEY_HERE
KAKAO_MAP_KEY=YOUR_KAKAO_MAP_KEY_HERE
GEMINI_API_KEY=YOUR_GEMINI_API_KEY_HERE
WEATHER_KEY=YOUR_WEATHER_KEY_HERE
SUPABASE_URL=YOUR_SUPABASE_URL_HERE
SUPABASE_ANON_KEY=YOUR_SUPABASE_ANON_KEY_HERE
ALLOWED_ORIGINS=https://nomuripusan-production.up.railway.app
PORT=8000
```

- `TOUR_API_KEY`: 필수입니다. 앱 시작 시 누락되면 서버가 중단됩니다.
- `KAKAO_MAP_KEY`: 선택값입니다. 없거나 SDK 로드가 실패하면 요약 SVG 지도로 대체됩니다.
- `GEMINI_API_KEY`: 선택값입니다. 없으면 저장된 추천 이유 또는 기본 추천 설명만 사용합니다.
- `WEATHER_KEY`: 선택값입니다. 없으면 날씨 연동을 생략합니다.
- `SUPABASE_URL`, `SUPABASE_ANON_KEY`: 선택값입니다. 없으면 분석 로그 저장과 추천 이유 원격 저장소 연동은 비활성화됩니다.
- `ALLOWED_ORIGINS`: 배포 도메인과 로컬 개발 도메인을 콤마로 지정합니다.
- `PORT`: Railway는 런타임에서 주입하며, 로컬 기본값은 `8000`입니다.

## 로컬 실행

```bash
python -m venv .venv
source .venv/Scripts/activate
pip install -r requirements.txt
python -m uvicorn backend.main:app --reload --port 8000
```

접속 주소는 `http://localhost:8000`입니다.

Windows PowerShell에서는 가상환경 활성화 명령만 아래처럼 실행합니다.

```powershell
.\.venv\Scripts\Activate.ps1
```

## Docker 실행

```bash
docker build -t nomuripusan .
docker run --env-file .env -p 8000:8000 nomuripusan
```

## 테스트

변경 범위에 따라 필요한 테스트를 선택해 실행합니다.

```bash
python -m pytest tests/test_frontend_fixes.py -q
python -m pytest tests/test_algorithm.py -q
python -m pytest tests/test_api.py -q
python -m pytest tests/ -q
```

최근 지도 폴백 수정 검증:

```bash
python -m pytest tests/test_frontend_fixes.py -q
```

## 배포

현재 운영 배포는 Railway production 환경의 `nomuripusan` 서비스에 연결되어 있습니다.

```bash
railway status
railway up
railway deployment list
railway domain
```

GitHub 원격은 다음 저장소를 사용합니다.

```bash
git remote -v
# nomuripusan https://github.com/lash-jpg/nomuripusan.git
```

배포 전 권장 순서:

```bash
python -m pytest tests/test_frontend_fixes.py -q
git status --short
git push nomuripusan HEAD:main
railway up
```

## 지도 동작 정책

`course.html`의 지도는 Kakao Maps JavaScript SDK가 정상 로드되면 실제 지도를 유지합니다. 타일 로드 이벤트 지연만으로 정상 지도를 SVG mock으로 덮어쓰지 않습니다.

mock 지도는 다음 경우에만 사용합니다.

- `KAKAO_MAP_KEY`가 설정되지 않은 경우
- Kakao SDK 스크립트 로드가 실패한 경우
- 유효 좌표가 없는 경우

OSRM 도로 경로 조회가 실패해도 지도 전체를 mock으로 전환하지 않고, 코스 연결선만 직선 경로로 표시합니다.

## 데이터 저장

- 공유 링크, 현장 제보, 코스 캐시는 로컬 SQLite/파일 기반 저장소를 사용합니다.
- `backend/data/*.db`, 캐시 파일, 로그 파일은 `.gitignore` 대상입니다.
- Supabase 환경변수가 있으면 분석 로그 저장에 사용할 수 있고, 없으면 기능이 no-op으로 동작합니다.

## 보안 및 운영 메모

- FastAPI 미들웨어에서 CSP, `X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`를 설정합니다.
- 추천, 공유, 설문, 일부 조회 API에는 경량 rate limit이 적용되어 있습니다.
- 외부 API 호출량 관리를 위해 추천 후보, 숙박 조회, 런타임 설정 캐시, 서비스워커 캐시 정책을 분리합니다.
