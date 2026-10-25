# Test-runner image: Python + Selenium client. Chrome runs in the separate
# selenium/standalone-chrome container (Remote WebDriver).
FROM python:3.12-slim
WORKDIR /tests
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY conftest.py pytest.ini test_flowboard.py ./
CMD ["pytest"]
