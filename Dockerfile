FROM python:3.12-slim

WORKDIR /app

# 의존성 설치
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# 앱 복사
COPY . .

# 보안: 비루트 사용자로 실행
RUN useradd -m -u 1000 appuser && chown -R appuser /app
USER appuser

# HuggingFace Spaces는 7860 포트 사용
EXPOSE 7860

COPY start.sh .
RUN sed -i 's/\r//' start.sh && chmod +x start.sh

CMD ["./start.sh"]
