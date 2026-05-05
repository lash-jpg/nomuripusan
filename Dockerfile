FROM python:3.12-slim

WORKDIR /app

# 의존성 설치
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# 앱 복사 및 start.sh 실행 권한 부여 (chown 전에 처리)
COPY . .
RUN sed -i 's/\r//' start.sh && chmod +x start.sh

# 보안: 비루트 사용자로 실행 (COPY 이후에 chown 적용해야 모든 파일 포함)
RUN useradd -m -u 1000 appuser && chown -R appuser /app
USER appuser

# HuggingFace Spaces는 PORT=7860 환경변수를 자동 주입
# 로컬 docker run 시: -e PORT=7860 -p 7860:7860 또는 기본값 8000 사용
EXPOSE 7860

CMD ["./start.sh"]
