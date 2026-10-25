"""
Selenium fixtures for the FlowBoard end-to-end tests.

Two independent browsers are used (driver = user A, driver_b = user B) so we
can prove real-time collaboration: what A does appears on B's screen live.

Environment variables
---------------------
BASE_URL             App under test, e.g. http://<alb-dns-name>   (default http://localhost)
HEADLESS             "1" (default) headless Chrome, "0" to watch the browsers
SELENIUM_REMOTE_URL  Use a Selenium Grid, e.g. http://selenium:4444/wd/hub
CHROME_BINARY        Optional path to Chrome/Chromium
CHROMEDRIVER_PATH    Optional path to chromedriver (otherwise Selenium Manager finds it)
"""
import os
import pathlib
import time

import pytest
from selenium import webdriver
from selenium.webdriver.chrome.service import Service

SCREENSHOT_DIR = pathlib.Path(__file__).parent / "screenshots"


def _make_driver(position_x=0):
    opts = webdriver.ChromeOptions()
    if os.getenv("HEADLESS", "1") == "1":
        opts.add_argument("--headless=new")
    opts.add_argument("--window-size=1440,900")
    opts.add_argument(f"--window-position={position_x},0")
    opts.add_argument("--no-sandbox")
    opts.add_argument("--disable-dev-shm-usage")
    if os.getenv("CHROME_BINARY"):
        opts.binary_location = os.environ["CHROME_BINARY"]

    remote = os.getenv("SELENIUM_REMOTE_URL")
    if remote:
        return webdriver.Remote(command_executor=remote, options=opts)
    service = Service(os.getenv("CHROMEDRIVER_PATH")) if os.getenv("CHROMEDRIVER_PATH") else Service()
    return webdriver.Chrome(service=service, options=opts)


@pytest.fixture(scope="session")
def base_url():
    return os.getenv("BASE_URL", "http://localhost").rstrip("/")


@pytest.fixture(scope="module")
def driver():
    drv = _make_driver(0)
    yield drv
    drv.quit()


@pytest.fixture(scope="module")
def driver_b():
    drv = _make_driver(720)
    yield drv
    drv.quit()


@pytest.fixture(scope="module")
def ctx():
    """State shared by the ordered steps of the user journey."""
    stamp = time.strftime("%m%d%H%M%S")
    return {
        "a": {"name": "Ayesha Tester", "email": f"ayesha.{stamp}@flowboard.test", "password": "Selenium#2026"},
        "b": {"name": "Bilal Tester", "email": f"bilal.{stamp}@flowboard.test", "password": "Selenium#2026"},
        "workspace": f"Selenium Workspace {stamp}",
        "project": "Selenium Project",
        "key": "SEL",
        "stamp": stamp,
    }


@pytest.hookimpl(hookwrapper=True)
def pytest_runtest_makereport(item, call):
    """On failure, screenshot every browser the test used."""
    outcome = yield
    report = outcome.get_result()
    if report.when == "call" and report.failed:
        SCREENSHOT_DIR.mkdir(exist_ok=True)
        for name in ("driver", "driver_b"):
            drv = item.funcargs.get(name)
            if drv is not None:
                path = SCREENSHOT_DIR / f"FAILED_{item.name}_{name}.png"
                drv.save_screenshot(str(path))
                print(f"\nScreenshot saved: {path}")
