"""
FlowBoard end-to-end tests — Selenium WebDriver + pytest.

The steps run IN ORDER and tell one story against the deployed app
(through the AWS Load Balancer):

  01  app loads and the login form is shown
  02  /api/health reports database + redis up
  03  bad credentials show an error
  04  user A registers
  05  A creates a workspace and gets an invite code
  06  A creates a project -> board has the 4 default columns
  07  A adds a task with quick-add
  08  A edits the task: priority, checklist, comment
  09  A DRAGS the task to "In Progress" and it stays there after reload
  10  user B (second browser) registers and joins with the invite code
  11  REAL-TIME: A adds a task -> it appears on B's board without refresh,
      and A's "Viewing now" shows both users
  12  REAL-TIME: A moves the task to Review -> B sees it move
  13  A assigns a task to B -> B gets a live notification
  14  analytics page shows the numbers
  15  sample which EC2 instances answered /api/health

Run:  BASE_URL=http://<alb-dns-name> pytest
"""
import json
import pathlib
import time

from selenium.webdriver.common.action_chains import ActionChains
from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.support.ui import Select, WebDriverWait

TIMEOUT = 45
EVIDENCE = pathlib.Path(__file__).parent / "screenshots"


# ----------------------------------------------------------------- helpers
def wait(drv, timeout=TIMEOUT):
    return WebDriverWait(drv, timeout)


def visible(drv, css, timeout=TIMEOUT):
    return wait(drv, timeout).until(EC.visibility_of_element_located((By.CSS_SELECTOR, css)))


def clickable(drv, css):
    return wait(drv).until(EC.element_to_be_clickable((By.CSS_SELECTOR, css)))


def title_contains(drv, text):
    wait(drv).until(EC.text_to_be_present_in_element((By.ID, "page-title"), text))


def evidence(drv, name):
    EVIDENCE.mkdir(exist_ok=True)
    drv.save_screenshot(str(EVIDENCE / f"{name}.png"))


def card_css(column, key):
    return f'[data-column-name="{column}"] [data-task-key="{key}"]'


def register(drv, base_url, user):
    drv.get(f"{base_url}/register")
    visible(drv, "#name").send_keys(user["name"])
    drv.find_element(By.ID, "email").send_keys(user["email"])
    drv.find_element(By.ID, "password").send_keys(user["password"])
    drv.find_element(By.ID, "register-btn").click()
    title_contains(drv, user["name"].split()[0])


def quick_add(drv, column, title):
    col = visible(drv, f'[data-column-name="{column}"]')
    col.find_element(By.CSS_SELECTOR, "[data-testid=quick-add-btn]").click()
    box = visible(drv, f'[data-column-name="{column}"] [data-testid=quick-add-input]')
    box.send_keys(title)
    box.send_keys(Keys.ENTER)


def card_by_title(drv, column, title, timeout=TIMEOUT):
    xpath = f'//section[@data-column-name="{column}"]//article[@data-testid="task-card"][.//div[@class="card-title" and text()="{title}"]]'
    return wait(drv, timeout).until(EC.visibility_of_element_located((By.XPATH, xpath)))


# ----------------------------------------------------------------- tests
def test_01_app_loads_and_shows_login(driver, base_url):
    driver.get(base_url)
    wait(driver).until(EC.title_is("FlowBoard"))
    title_contains(driver, "Welcome back")
    button = visible(driver, "#login-btn")
    assert button.is_enabled() and button.text == "Log in"
    assert driver.find_element(By.ID, "email").get_attribute("type") == "email"
    evidence(driver, "01_login")


def test_02_health_endpoint(driver, base_url):
    driver.get(f"{base_url}/api/health")
    data = json.loads(driver.find_element(By.TAG_NAME, "body").text)
    print(f"\nHealth: {data['status']} db={data['database']} redis={data['redis']} worker={data['worker']} instance={data['instanceId']}")
    assert data["status"] == "ok" and data["database"] == "up" and data["redis"] == "up"


def test_03_invalid_login_shows_error(driver, base_url):
    driver.get(f"{base_url}/login")
    visible(driver, "#email").send_keys("nobody@flowboard.test")
    driver.find_element(By.ID, "password").send_keys("wrong-password")
    driver.find_element(By.ID, "login-btn").click()
    assert "Incorrect email or password" in visible(driver, "[data-testid=form-error]").text


def test_04_register_user_a(driver, base_url, ctx):
    register(driver, base_url, ctx["a"])
    assert visible(driver, "#user-name").text == ctx["a"]["name"]
    wait(driver).until(lambda d: d.find_element(By.ID, "socket-status").get_attribute("data-connected") == "true")


def test_05_create_workspace(driver, ctx):
    clickable(driver, "#new-workspace-btn").click()
    visible(driver, "#ws-name").send_keys(ctx["workspace"])
    driver.find_element(By.ID, "create-workspace-submit").click()
    title_contains(driver, ctx["workspace"])
    code = visible(driver, "[data-testid=invite-code]").text.strip()
    assert len(code) == 8, f"unexpected invite code {code!r}"
    assert visible(driver, "#my-role").text.lower() == "owner"
    ctx["invite_code"] = code
    ctx["workspace_url"] = driver.current_url
    evidence(driver, "02_workspace")


def test_06_create_project_with_default_columns(driver, ctx):
    clickable(driver, "#new-project-btn").click()
    visible(driver, "#project-name").send_keys(ctx["project"])
    key = driver.find_element(By.ID, "project-key")
    key.clear()
    key.send_keys(ctx["key"])
    driver.find_element(By.ID, "create-project-submit").click()
    title_contains(driver, ctx["project"])
    wait(driver).until(lambda d: len(d.find_elements(By.CSS_SELECTOR, "[data-testid=column]")) == 4)
    names = [c.get_attribute("data-column-name") for c in driver.find_elements(By.CSS_SELECTOR, "[data-testid=column]")]
    assert names == ["To Do", "In Progress", "Review", "Done"]
    ctx["board_url"] = driver.current_url


def test_07_quick_add_task(driver, ctx):
    quick_add(driver, "To Do", "Containerise the API")
    card = visible(driver, card_css("To Do", f"{ctx['key']}-1"))
    assert "Containerise the API" in card.text


def test_08_edit_task_in_modal(driver, ctx):
    visible(driver, card_css("To Do", f"{ctx['key']}-1")).click()
    visible(driver, "[data-testid=task-modal]")
    assert visible(driver, "#task-key").text == f"{ctx['key']}-1"

    Select(visible(driver, "#task-priority")).select_by_value("high")
    for item in ("Write multi-stage Dockerfile", "Add HEALTHCHECK"):
        visible(driver, "#checklist-input").send_keys(item)
        driver.find_element(By.ID, "checklist-add").click()
        wait(driver).until(EC.text_to_be_present_in_element((By.CSS_SELECTOR, ".checklist"), item))
    driver.find_elements(By.CSS_SELECTOR, "[data-testid=checklist-item] input[type=checkbox]")[0].click()
    wait(driver).until(EC.text_to_be_present_in_element((By.ID, "checklist-progress"), "1/2"))

    visible(driver, "#comment-input").send_keys("Started on this — will push the Dockerfile today.")
    driver.find_element(By.ID, "comment-submit").click()
    wait(driver).until(EC.text_to_be_present_in_element((By.ID, "comments"), "push the Dockerfile"))
    evidence(driver, "03_task_modal")

    driver.find_element(By.ID, "close-task").click()
    wait(driver).until(EC.invisibility_of_element_located((By.CSS_SELECTOR, "[data-testid=task-modal]")))
    card = visible(driver, card_css("To Do", f"{ctx['key']}-1"))
    wait(driver).until(lambda d: "1/2" in card.find_element(By.CSS_SELECTOR, "[data-testid=card-checklist]").text)


def test_09_drag_and_drop_persists(driver, ctx):
    key = f"{ctx['key']}-1"
    card = visible(driver, card_css("To Do", key))
    target = driver.find_element(By.CSS_SELECTOR, '[data-column-name="In Progress"] .column-body')
    (ActionChains(driver)
        .click_and_hold(card).pause(0.2)
        .move_by_offset(15, 10).pause(0.2)          # passes the 5px drag threshold
        .move_to_element(target).pause(0.3)
        .move_by_offset(0, 5).pause(0.2)
        .release().perform())
    visible(driver, card_css("In Progress", key))

    driver.refresh()                                 # prove it was saved on the server
    visible(driver, card_css("In Progress", key))
    assert not driver.find_elements(By.CSS_SELECTOR, card_css("To Do", key))
    evidence(driver, "04_after_drag")


def pin_to_same_instance(source, target, base_url):
    """Each EC2 instance has its OWN database, and the ALB uses a stickiness cookie
    (AWSALB) to keep a browser on one instance. Give browser B the same cookie as
    browser A so both users work on the same instance — like two teammates on one
    server. Locally (no ALB) there is no such cookie and this does nothing."""
    target.get(base_url)
    copied = 0
    for c in source.get_cookies():
        if c["name"].startswith("AWSALB"):
            target.add_cookie({k: c[k] for k in ("name", "value", "path") if k in c})
            copied += 1
    if copied:
        print(f"\nCopied {copied} ALB stickiness cookie(s) so both browsers use the same EC2 instance")


def test_10_second_user_joins_with_invite_code(driver, driver_b, base_url, ctx):
    pin_to_same_instance(driver, driver_b, base_url)
    register(driver_b, base_url, ctx["b"])
    visible(driver_b, "#join-code").send_keys(ctx["invite_code"])
    driver_b.find_element(By.ID, "join-btn").click()
    title_contains(driver_b, ctx["workspace"])
    assert visible(driver_b, "#my-role").text.lower() == "member"
    driver_b.get(ctx["board_url"])
    visible(driver_b, card_css("In Progress", f"{ctx['key']}-1"))


def test_11_realtime_new_task_and_presence(driver, driver_b, ctx):
    title = f"Live sync check {ctx['stamp']}"
    driver.get(ctx["board_url"])
    visible(driver, "[data-testid=column]")
    # Both users are on the board -> A sees two avatars under "Viewing now"
    wait(driver).until(lambda d: len(d.find_elements(By.CSS_SELECTOR, "#presence .avatar")) == 2)

    quick_add(driver, "To Do", title)
    # B never reloads: the card must arrive over the WebSocket
    started = time.time()
    card_by_title(driver_b, "To Do", title, timeout=40)
    print(f"\nTask appeared on B's screen after {time.time() - started:.2f}s (no refresh)")
    ctx["live_title"] = title
    evidence(driver_b, "05_realtime_user_b")


def test_12_realtime_move_seen_by_other_user(driver, driver_b, ctx):
    card_by_title(driver, "To Do", ctx["live_title"]).click()
    Select(visible(driver, "#task-status")).select_by_visible_text("Review")
    wait(driver).until(lambda d: Select(d.find_element(By.ID, "task-status")).first_selected_option.text == "Review")
    driver.find_element(By.ID, "close-task").click()
    card_by_title(driver_b, "Review", ctx["live_title"], timeout=40)


def test_13_assignment_sends_live_notification(driver, driver_b, ctx):
    card_by_title(driver, "Review", ctx["live_title"]).click()
    Select(visible(driver, "#task-assignee")).select_by_visible_text(ctx["b"]["name"])
    wait(driver).until(lambda d: Select(d.find_element(By.ID, "task-assignee")).first_selected_option.text == ctx["b"]["name"])
    driver.find_element(By.ID, "close-task").click()

    badge = visible(driver_b, "#unread-count", timeout=40)
    assert int(badge.text) >= 1
    driver_b.find_element(By.ID, "notifications-btn").click()
    panel = visible(driver_b, "[data-testid=notifications-panel]")
    assert "assigned you" in panel.text
    evidence(driver_b, "06_notification")


def test_14_analytics(driver, ctx):
    driver.get(ctx["board_url"])
    clickable(driver, "#analytics-link").click()
    title_contains(driver, "Analytics")
    completion = visible(driver, "[data-testid=kpi-completion]")
    assert "of 2 tasks" in completion.text
    assert driver.find_elements(By.CSS_SELECTOR, ".chart svg")
    evidence(driver, "07_analytics")


def test_15_load_balancer_distribution(driver, base_url):
    """Behind an ALB with 2 healthy instances you should see 2 instance IDs (stickiness off for API calls)."""
    seen = {}
    for _ in range(12):
        driver.get(f"{base_url}/api/health")
        data = json.loads(driver.find_element(By.TAG_NAME, "body").text)
        assert data["status"] == "ok"
        key = f"{data['instanceId']} / {data['container']}"
        seen[key] = seen.get(key, 0) + 1
    print(f"\nResponses per instance/container: {seen}")
