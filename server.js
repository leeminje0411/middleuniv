const http = require("http");
const fs = require("fs");
const path = require("path");
const url = require("url");
const { chromium } = require("playwright");

const {
  runTeamTodayScraper,
  windowsToText,
  blocksToText
} = require("./scraper/teamTodayScraper");

const PORT = Number(process.env.PORT) || 4000;
const ROOT_DIR = __dirname;
const PUBLIC_DIR = path.join(ROOT_DIR, "public");
const LIVE_DIR = path.join(ROOT_DIR, "live");
const LIVE_JSON_PATH = path.join(LIVE_DIR, "latest_team_today.json");
const RUNTIME_DIR = path.join(ROOT_DIR, "runtime");
const TEAM_MEMBERS_PATH = path.join(RUNTIME_DIR, "team_members.json");

function safeRemovePath(targetPath) {
  if (!targetPath) return;
  const resolved = path.resolve(targetPath);

  // Prevent deleting outside of the project root.
  if (!resolved.startsWith(ROOT_DIR + path.sep) && resolved !== ROOT_DIR) {
    return;
  }

  if (!fs.existsSync(resolved)) {
    return;
  }

  const stat = fs.lstatSync(resolved);
  if (stat.isDirectory()) {
    fs.rmSync(resolved, { recursive: true, force: true });
    return;
  }

  fs.unlinkSync(resolved);
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

ensureDir(PUBLIC_DIR);
ensureDir(LIVE_DIR);
ensureDir(RUNTIME_DIR);

let session = null;
let jobState = null;
let playwrightLock = Promise.resolve();

function ensureBookingState() {
  if (!jobState) {
    jobState = makeIdleState();
  }
  if (!jobState.booking) {
    jobState.booking = {
      isRunning: false,
      step: null,
      url: null,
      targetUrl: null,
      error: null,
      startedAt: null,
      finishedAt: null
    };
  }
  return jobState.booking;
}

function pushBookingLog(line) {
  ensureBookingState();
  pushJobLog(`[book] ${String(line || "").trim()}`);
}

function setBookingStep(step, urlValue, targetUrlValue) {
  const b = ensureBookingState();
  b.step = step ? String(step) : b.step;
  if (urlValue != null) b.url = String(urlValue);
  if (targetUrlValue != null) b.targetUrl = String(targetUrlValue);
}

function withPlaywrightLock(fn) {
  const next = playwrightLock.then(fn);
  playwrightLock = next.catch(() => {});
  return next;
}

function safeReadJson(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const text = fs.readFileSync(filePath, "utf8");
    return text ? JSON.parse(text) : null;
  } catch (e) {
    return null;
  }
}

function makeIdleState() {
  const live = safeReadJson(LIVE_JSON_PATH);
  return {
    isRunning: false,
    startedAt: null,
    finishedAt: null,
    progress: 0,
    step: "대기중",
    status: "idle",
    error: null,
    pid: null,
    logs: [],
    data: live
  };
}

function getWorkerState() {
  if (!jobState) {
    return makeIdleState();
  }
  const live = safeReadJson(LIVE_JSON_PATH);
  return {
    ...jobState,
    data: live || jobState.data || null,
    session: session
      ? {
          hasBrowser: Boolean(session.browser),
          loginId: session.loginId || null,
          lastActiveAt: session.lastActiveAt || null
        }
      : null
  };
}

function pushJobLog(line) {
  if (!jobState) return;
  const text = String(line || "").trim();
  if (!text) return;
  jobState.logs.push(text);
  if (jobState.logs.length > 300) {
    jobState.logs = jobState.logs.slice(-300);
  }
}

async function getOrCreateSession({ loginId, password, headless }) {
  const normalizedId = String(loginId || "").trim();
  if (!normalizedId || !password) {
    throw new Error("아이디와 비밀번호가 필요합니다.");
  }

  const desiredHeadless = typeof headless === "boolean" ? headless : process.env.BOOK_HEADLESS === "true";

  if (session && session.loginId === normalizedId) {
    if (typeof session.headless === "boolean" && session.headless !== desiredHeadless) {
      await closeSession().catch(() => {});
      session = null;
    } else {
      return session;
    }
  }

  if (session) {
    return session;
  }

  const slowMo = Number(process.env.BOOK_SLOWMO_MS) || 0;
  const browser = await chromium.launch({ headless: desiredHeadless, slowMo });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1200 } });
  const page = await context.newPage();

  session = {
    browser,
    context,
    page,
    loginId: normalizedId,
    password,
    headless: desiredHeadless,
    createdAt: new Date().toISOString(),
    lastActiveAt: new Date().toISOString()
  };

  return session;
}

async function closeSession() {
  const s = session;
  session = null;
  if (!s) return;
  await s.context?.close().catch(() => {});
  await s.browser?.close().catch(() => {});
}

async function ensureLoggedIn(page, loginId, password) {
  const BASE_URL = "https://library.cau.ac.kr";
  const currentUrl = String(page.url() || "");
  pushBookingLog(`ensureLoggedIn enter url=${currentUrl}`);

  const isBlank = currentUrl === "about:blank";
  if (isBlank) {
    pushBookingLog("ensureLoggedIn: about:blank -> doLoginForBooking");
    await doLoginForBooking(page, loginId, password);
    pushBookingLog(`ensureLoggedIn: after login url=${page.url()}`);
    return;
  }

  if (currentUrl.includes("/login")) {
    pushBookingLog("ensureLoggedIn: on /login -> doLoginForBooking");
    await doLoginForBooking(page, loginId, password);
    pushBookingLog(`ensureLoggedIn: after login url=${page.url()}`);
    return;
  }

  const bodyText = await page.locator("body").innerText().catch(() => "");
  if (!String(bodyText || "").trim()) {
    pushBookingLog("ensureLoggedIn: empty body -> doLoginForBooking");
    await doLoginForBooking(page, loginId, password);
    pushBookingLog(`ensureLoggedIn: after login url=${page.url()}`);
    return;
  }

  // Detect real login screen marker (avoid naive '로그인' substring which appears in many pages)
  if (bodyText.includes("중앙대학교 통합 LOGIN")) {
    pushBookingLog("ensureLoggedIn: login screen detected -> doLoginForBooking");
    await doLoginForBooking(page, loginId, password);
    pushBookingLog(`ensureLoggedIn: after login url=${page.url()}`);
  } else {
    pushBookingLog("ensureLoggedIn: assume already logged in");
  }

  // Verify we are not stuck on login page
  const afterUrl = String(page.url() || "");
  const afterBody = await page.locator("body").innerText().catch(() => "");
  if (afterUrl.includes("/login") || afterBody.includes("중앙대학교 통합 LOGIN")) {
    throw new Error("로그인 실패: 로그인 페이지에서 벗어나지 못했습니다.");
  }

  if (!afterUrl.startsWith(BASE_URL)) {
    pushBookingLog(`ensureLoggedIn: warning unexpected url=${afterUrl}`);
  }
}

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(data, null, 2));
}

function sendText(res, statusCode, text, contentType) {
  res.writeHead(statusCode, {
    "Content-Type": contentType || "text/plain; charset=utf-8"
  });
  res.end(text);
}

function getContentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();

  if (ext === ".html") return "text/html; charset=utf-8";
  if (ext === ".css") return "text/css; charset=utf-8";
  if (ext === ".js") return "application/javascript; charset=utf-8";
  if (ext === ".json") return "application/json; charset=utf-8";
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".svg") return "image/svg+xml";
  if (ext === ".ico") return "image/x-icon";

  return "application/octet-stream";
}

function serveFile(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      sendText(res, 404, "Not Found");
      return;
    }

    res.writeHead(200, {
      "Content-Type": getContentType(filePath),
      "Cache-Control": "no-store"
    });
    res.end(data);
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function doLoginForBooking(page, loginId, password) {
  const BASE_URL = "https://library.cau.ac.kr";
  const LOGIN_URL = `${BASE_URL}/login?returnUrl=%2F&queryParamsHandling=merge`;

  await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle").catch(() => {});
  await sleep(1200);

  const bodyText = await page.locator("body").innerText().catch(() => "");
  if (!bodyText.includes("중앙대학교 통합 LOGIN")) {
    // 이미 로그인 되어 있거나 페이지 구성이 바뀐 케이스는 계속 진행
  }

  await page.waitForFunction(() => document.querySelectorAll("input").length >= 2, {
    timeout: 15000
  });

  const visibleInputs = await page.locator("input").evaluateAll((els) => {
    function isVisible(el) {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style && style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
    }

    return els
      .map((el, idx) => ({
        idx,
        type: el.type || "",
        visible: isVisible(el)
      }))
      .filter((x) => x.visible);
  });

  const idInput = visibleInputs.find((x) => x.type !== "password");
  const pwInput = visibleInputs.find((x) => x.type === "password");
  if (!idInput || !pwInput) {
    throw new Error("로그인 입력창을 찾지 못했습니다.");
  }

  await page.locator("input").nth(idInput.idx).fill(String(loginId || "").trim());
  await page.locator("input").nth(pwInput.idx).fill(String(password || ""));

  const clicked = await page.evaluate(() => {
    function isVisible(el) {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style && style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
    }
    const buttons = Array.from(document.querySelectorAll("button"));
    const loginButtons = buttons.filter((btn) => {
      const text = (btn.textContent || "").replace(/\s+/g, " ").trim();
      return text === "로그인" && isVisible(btn);
    });
    if (!loginButtons.length) return false;
    loginButtons[0].click();
    return true;
  });

  if (!clicked) {
    throw new Error("로그인 버튼 클릭에 실패했습니다.");
  }

  await Promise.allSettled([
    page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 20000 }),
    page.waitForLoadState("networkidle")
  ]);
  await sleep(1200);
}

async function selectDateOnListPage(page, dateValue) {
  pushBookingLog(`selectDateOnListPage start dateValue=${String(dateValue || "")}`);
  if (!dateValue) {
    pushBookingLog("selectDateOnListPage skip (no dateValue)");
    return;
  }

  await page.waitForSelector("select#reservableDate", { timeout: 20000 });
  pushBookingLog(`selectDateOnListPage reservableDate visible url=${page.url()}`);

  await page.waitForFunction(
    (value) => {
      const dateSelect = document.querySelector("#reservableDate");
      if (!dateSelect) return false;
      const opts = Array.from(dateSelect.querySelectorAll("option")).map((o) => o.value);
      return opts.includes(value);
    },
    { timeout: 20000 },
    String(dateValue)
  );

  await page.selectOption("#reservableDate", String(dateValue)).catch(async () => {
    await page.evaluate((value) => {
      const dateSelect = document.querySelector("#reservableDate");
      if (!dateSelect) return;
      dateSelect.value = value;
      dateSelect.dispatchEvent(new Event("change", { bubbles: true }));
    }, String(dateValue));
  });

  await sleep(250);

  const submitBtn = page.locator('button:has-text("조회")').first();
  if (await submitBtn.count().catch(() => 0)) {
    pushBookingLog("selectDateOnListPage click 조회");
    await submitBtn.click().catch(() => {});
    await page.waitForLoadState("domcontentloaded").catch(() => {});
    await sleep(350);
  }

  pushBookingLog(`selectDateOnListPage done url=${page.url()}`);
}

async function openRoomDetailByIndex(page, roomIndex) {
  const idx = Number(roomIndex);
  if (!Number.isFinite(idx) || idx < 0) {
    throw new Error("roomIndex가 올바르지 않습니다.");
  }
  pushBookingLog(`openRoomDetailByIndex start idx=${idx} url=${page.url()}`);
  const card = page.locator(".ikc-card-rooms").nth(idx);
  const reserveBtn = card.locator('button:has-text("예약")').first();
  if (!(await reserveBtn.count().catch(() => 0))) {
    throw new Error("예약 버튼을 찾지 못했습니다.");
  }

  pushBookingLog("openRoomDetailByIndex click 예약");
  await Promise.all([
    page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => {}),
    reserveBtn.click({ timeout: 15000 })
  ]);
  await page.waitForSelector(".ikc-room-info", { timeout: 20000 });
  pushBookingLog(`openRoomDetailByIndex done url=${page.url()}`);
}

async function performBooking({ id, password, roomIndex, roomId, dateValue, beginTime, endTime, reusePage }) {
  const BASE_URL = "https://library.cau.ac.kr";
  const TEAM_URL = `${BASE_URL}/library-services/room/team-rooms?tabIndex=2`;

  const usingInjectedPage = Boolean(reusePage);
  const headless = process.env.BOOK_HEADLESS === "true";
  const slowMo = Number(process.env.BOOK_SLOWMO_MS) || 0;
  const browser = usingInjectedPage ? null : await chromium.launch({ headless, slowMo });
  const context = usingInjectedPage ? null : await browser.newContext({ viewport: { width: 1440, height: 1200 } });
  const page = usingInjectedPage ? reusePage : await context.newPage();

  // When reusing a session page (headful booking session), we might be on about:blank with no cookies.
  // Ensure login is established before attempting to open protected booking pages.
  setBookingStep("ensureLoggedIn", page.url(), null);
  await ensureLoggedIn(page, id, password);
  setBookingStep("ensureLoggedIn:done", page.url(), null);

  async function waitSelectHasValue(selector, value, timeoutMs) {
    const wanted = String(value);
    await page.waitForFunction(
      ({ selector: sel, wantedValue }) => {
        const el = document.querySelector(sel);
        if (!el) return false;
        const opts = Array.from(el.querySelectorAll("option"));
        return opts.some((o) => String(o.value) === wantedValue || String(o.textContent || "").trim() === wantedValue);
      },
      { timeout: Number(timeoutMs) || 15000 },
      { selector, wantedValue: wanted }
    );
  }

  async function selectOptionRobust(selector, valueOrLabel) {
    const v = String(valueOrLabel);
    await waitSelectHasValue(selector, v, 20000);
    await page.selectOption(selector, { value: v }).catch(async () => {
      await page.selectOption(selector, { label: v });
    });
  }

  async function closeCurtainIfPresent() {
    const closeBtn = page.locator("ik-bulletins-curtain-view button.btn-close").first();
    if (await closeBtn.count().catch(() => 0)) {
      await closeBtn.click({ timeout: 1500 }).catch(() => {});
      await sleep(100);
    }
  }

  async function addCompanionsIfAny() {
    if (!fs.existsSync(TEAM_MEMBERS_PATH)) {
      return;
    }
    const raw = fs.readFileSync(TEAM_MEMBERS_PATH, "utf8");
    const parsed = raw ? JSON.parse(raw) : {};
    const companions = parsed && Array.isArray(parsed.members) ? parsed.members : [];
    if (!companions.length) {
      return;
    }

    const openBtn = page.locator("button.btn-patrons-edit").first();
    if (!(await openBtn.count().catch(() => 0))) {
      throw new Error("동반이용자 등록 버튼을 찾지 못했습니다.");
    }
    await openBtn.click({ timeout: 8000 });
    console.log("[api/book] companion dialog opened");

    const dialog = page.locator("mat-dialog-container, #companionPatronDialog").first();
    await dialog.waitFor({ state: "visible", timeout: 15000 });

    const chipList = page.locator("mat-chip-list .mat-chip");
    let chipCount = await chipList.count().catch(() => 0);

    for (let i = 0; i < companions.length; i++) {
      const c = companions[i];
      console.log(`[api/book] companion add ${i + 1} / ${companions.length} ${JSON.stringify(c)}`);

      const nameInput = dialog.locator('input[formcontrolname="name"]');
      const idInput = dialog.locator('input[formcontrolname="memberNo"]');
      await nameInput.waitFor({ state: "visible", timeout: 15000 });
      await idInput.waitFor({ state: "visible", timeout: 15000 });

      await nameInput.fill(String(c.name || "").trim());
      await idInput.fill(String(c.studentId || "").trim());

      const addBtn = dialog.locator('button:has-text("추가")').first();
      await page.waitForFunction(
        (el) => el && !el.disabled,
        { timeout: 15000 },
        await addBtn.elementHandle()
      );
      await addBtn.click();

      chipCount += 1;
      await page.waitForFunction(
        ({ wanted }) => {
          const chips = document.querySelectorAll("mat-chip-list .mat-chip");
          return chips && chips.length >= wanted;
        },
        { timeout: 15000 },
        { wanted: chipCount }
      );
    }

    const registerBtn = dialog.locator('button:has-text("등록")').first();
    if (await registerBtn.count().catch(() => 0)) {
      await registerBtn.click({ timeout: 10000 }).catch(() => {});
    }
    await dialog.waitFor({ state: "hidden", timeout: 15000 }).catch(() => {});
  }

  async function agreeTrueOrThrow() {
    await closeCurtainIfPresent();

    // internal scroll container
    const content = page.locator("#content").first();
    if (await content.count().catch(() => 0)) {
      await content.evaluate((el) => {
        el.scrollTop = el.scrollHeight;
      }).catch(() => {});
      await sleep(120);
    } else {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
      await sleep(120);
    }

    const group = page
      .locator('mat-radio-group[formcontrolname="agree"], [formcontrolname="agree"] mat-radio-group')
      .first();
    await group.waitFor({ state: "visible", timeout: 15000 });

    const input = group.locator('input.mat-radio-input[value="true"], input[type="radio"][value="true"]').first();
    if (!(await input.count().catch(() => 0))) {
      throw new Error("동의 라디오 input(true)을 찾지 못했습니다.");
    }

    const maxTries = 3;
    for (let attempt = 1; attempt <= maxTries; attempt++) {
      console.log(`[api/book] agree try ${attempt}/${maxTries}`);

      const inputId = await input.getAttribute("id").catch(() => null);

      // Prefer clicking <label for="inputId"> because Angular Material binds there reliably.
      if (inputId) {
        await group.evaluate(
          ({ root, id }) => {
            const label = root.querySelector(`label[for="${CSS.escape(id)}"]`);
            if (label) {
              label.scrollIntoView({ block: "center", inline: "center" });
              label.click();
            }
          },
          { root: undefined, id: inputId }
        ).catch(() => {});
      }

      // Fallback: click input + dispatch events
      await input
        .evaluate((el) => {
          el.scrollIntoView({ block: "center", inline: "center" });
          el.click();
          el.checked = true;
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
        })
        .catch(() => {});

      await sleep(150);

      const checkedByClass = await group
        .locator('mat-radio-button.mat-radio-checked:has(input[value="true"])')
        .count()
        .then((n) => n > 0)
        .catch(() => false);
      const checkedByInput = await input.evaluate((el) => Boolean(el.checked)).catch(() => false);

      if (checkedByClass || checkedByInput) {
        console.log("[api/book] agree(true) selected");
        return;
      }
    }

    const groupHtml = await group
      .evaluate((el) => (el ? String(el.innerHTML || "").slice(0, 4000) : ""))
      .catch(() => "");
    console.log("[api/book] agree group html (head):", groupHtml);
    throw new Error("동의 라디오 선택 실패: '위 사항을 확인하고 동의합니다' (true) 가 체크되지 않았습니다.");
  }

  async function selectUseSectionOrThrow() {
    const useSelect = page.locator("select#useSection").first();
    if (!(await useSelect.count().catch(() => 0))) {
      return;
    }
    await selectOptionRobust("#useSection", "1");
    const ok = await page
      .evaluate(() => {
        const el = document.querySelector("#useSection");
        return el && String(el.value) === "1";
      })
      .catch(() => false);
    if (!ok) {
      throw new Error("용도(useSection) 선택 실패: 학습(1)로 설정되지 않았습니다.");
    }
    console.log("[api/book] useSection selected 1");
  }

  try {
    // doLoginForBooking is invoked via ensureLoggedIn above.

    const normalizedDate = dateValue ? String(dateValue) : "";
    const normalizedRoomId = roomId != null && String(roomId).trim() ? String(roomId).trim() : "";

    if (normalizedRoomId && normalizedDate) {
      const detailUrl = `${BASE_URL}/library-services/room/team-rooms/${encodeURIComponent(
        normalizedRoomId
      )}/${encodeURIComponent(normalizedDate)}?tabIndex=2&hopeDate=${encodeURIComponent(normalizedDate)}`;
      setBookingStep("gotoDetail", page.url(), detailUrl);
      pushBookingLog(`goto detailUrl=${detailUrl}`);
      await page.goto(detailUrl, { waitUntil: "domcontentloaded" });

      // If unauthenticated, the site may bounce us to home or a non-detail page.
      const afterUrl = String(page.url() || "");
      pushBookingLog(`after goto detail url=${afterUrl}`);
      if (!afterUrl.includes("/library-services/room/team-rooms/") || afterUrl === BASE_URL + "/") {
        pushBookingLog("detail navigation bounced -> re-ensureLoggedIn and retry");
        setBookingStep("retryLogin", afterUrl, detailUrl);
        await ensureLoggedIn(page, id, password);
        pushBookingLog(`after re-login url=${page.url()}`);
        await page.goto(detailUrl, { waitUntil: "domcontentloaded" });
        pushBookingLog(`after retry goto url=${page.url()}`);
      }
      await page.waitForSelector(".ikc-room-info", { timeout: 20000 });
      setBookingStep("detailReady", page.url(), detailUrl);
    } else {
      setBookingStep("gotoList", page.url(), TEAM_URL);
      pushBookingLog(`goto TEAM_URL=${TEAM_URL}`);
      await page.goto(TEAM_URL, { waitUntil: "domcontentloaded" });
      await page.waitForSelector(".ikc-card-rooms", { timeout: 20000 });
      await page.waitForSelector(".ikc-card-rooms", { timeout: 20000 });

      await selectDateOnListPage(page, dateValue);
      await page.waitForSelector(".ikc-card-rooms", { timeout: 20000 });

      await openRoomDetailByIndex(page, roomIndex);
      setBookingStep("detailReady", page.url(), null);
    }

    // 상세 페이지에서 날짜/시간 선택
    if (dateValue) {
      pushBookingLog(`detail form: select hopeDate=${String(dateValue)} url=${page.url()}`);
      await selectOptionRobust("#hopeDate", String(dateValue)).catch(() => {});
      await sleep(120);
      pushBookingLog(`detail form: hopeDate selected url=${page.url()}`);
    }

    pushBookingLog(`detail form: beginTime=${String(beginTime)} endTime=${String(endTime)} url=${page.url()}`);
    console.log(`[api/book] request ${JSON.stringify({ roomIndex, roomId: normalizedRoomId || null, dateValue, beginTime, endTime })}`);
    await closeCurtainIfPresent();

    pushBookingLog(`detail form: select beginTime=${String(beginTime)} url=${page.url()}`);
    await selectOptionRobust("#beginTime", String(beginTime));
    console.log(`[api/book] beginTime selected ${beginTime}`);
    await sleep(120);
    pushBookingLog(`detail form: beginTime selected url=${page.url()}`);

    pushBookingLog(`detail form: select endTime=${String(endTime)} url=${page.url()}`);
    await selectOptionRobust("#endTime", String(endTime));
    console.log(`[api/book] endTime selected ${endTime}`);
    await sleep(120);
    pushBookingLog(`detail form: endTime selected url=${page.url()}`);

    pushBookingLog(`detail form: select useSection=1 url=${page.url()}`);
    await selectUseSectionOrThrow();
    pushBookingLog(`detail form: useSection selected url=${page.url()}`);
    await addCompanionsIfAny();
    await agreeTrueOrThrow();

    const submitBtn = page.locator('button[type="submit"]:has-text("신청"), button:has-text("신청")').first();
    if (!(await submitBtn.count().catch(() => 0))) {
      throw new Error("신청 submit 버튼을 찾지 못했습니다.");
    }

    await page.waitForFunction(
      (el) => el && !el.disabled,
      { timeout: 15000 },
      await submitBtn.elementHandle()
    );

    await submitBtn.click({ timeout: 15000 });
    console.log("[api/book] submit clicked");

    const confirmBtn = page.locator('button:has-text("확인")').first();
    if (await confirmBtn.count().catch(() => 0)) {
      await confirmBtn.click().catch(() => {});
    }

    await page.waitForLoadState("domcontentloaded").catch(() => {});
    await sleep(400);

    return {
      ok: true,
      message: "예약 신청을 시도했습니다.",
      roomIndex,
      roomId: normalizedRoomId || null,
      dateValue,
      beginTime,
      endTime,
      finalUrl: page.url()
    };
  } finally {
    if (!usingInjectedPage) {
      await context.close().catch(() => {});
      await browser.close().catch(() => {});
    }
  }
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";

    req.on("data", (chunk) => {
      body += chunk.toString();

      if (body.length > 1024 * 1024) {
        reject(new Error("요청 본문이 너무 큽니다."));
        req.destroy();
      }
    });

    req.on("end", () => {
      try {
        const json = body ? JSON.parse(body) : {};
        resolve(json);
      } catch (err) {
        reject(new Error("JSON 파싱 실패"));
      }
    });

    req.on("error", (err) => {
      reject(err);
    });
  });
}

function resolvePublicPath(requestPath) {
  const relativePath = requestPath.replace(/^\/public\//, "");
  const normalizedPath = path.normalize(relativePath);
  const filePath = path.join(PUBLIC_DIR, normalizedPath);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    return null;
  }

  return filePath;
}

const server = http.createServer(async (req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname || "/";
  const method = req.method || "GET";

  if (method === "GET" && pathname === "/api/state") {
    sendJson(res, 200, getWorkerState());
    return;
  }

  if (method === "GET" && pathname === "/api/team-members") {
    try {
      if (!fs.existsSync(TEAM_MEMBERS_PATH)) {
        sendJson(res, 200, {
          ok: true,
          members: []
        });
        return;
      }

      const raw = fs.readFileSync(TEAM_MEMBERS_PATH, "utf8");
      const parsed = raw ? JSON.parse(raw) : {};
      const members = parsed && Array.isArray(parsed.members) ? parsed.members : [];

      sendJson(res, 200, {
        ok: true,
        members
      });
      return;
    } catch (err) {
      sendJson(res, 500, {
        ok: false,
        message: "팀원 정보 로드 실패",
        error: err && err.message ? err.message : String(err)
      });
      return;
    }
  }

  if (method === "POST" && pathname === "/api/book") {
    try {
      const body = await parseBody(req);
      const id = body.id;
      const password = body.password;
      const roomIndex = body.roomIndex;
      const roomId = body.roomId;
      const dateValue = body.dateValue;
      const beginTime = body.beginTime;
      const endTime = body.endTime;

      if (!id || !password) {
        sendJson(res, 400, { ok: false, message: "예약 신청에는 아이디/비밀번호가 필요합니다." });
        return;
      }
      if ((roomId == null || String(roomId).trim() === "") && roomIndex == null) {
        sendJson(res, 400, { ok: false, message: "roomId 또는 roomIndex가 필요합니다." });
        return;
      }
      if (beginTime == null || endTime == null) {
        sendJson(res, 400, { ok: false, message: "beginTime/endTime이 필요합니다." });
        return;
      }

      const result = await withPlaywrightLock(async () => {
        const b = ensureBookingState();
        b.isRunning = true;
        b.startedAt = new Date().toISOString();
        b.finishedAt = null;
        b.error = null;
        setBookingStep("start", null, null);
        pushBookingLog(
          `request ${JSON.stringify({ roomIndex: roomIndex ?? null, roomId: roomId ?? null, dateValue, beginTime, endTime })}`
        );

        const bookHeadless = process.env.BOOK_BOOK_HEADLESS === "true";
        const s = await getOrCreateSession({ loginId: id, password, headless: bookHeadless });
        pushBookingLog(`session headless=${Boolean(s && s.headless)} currentUrl=${s && s.page ? s.page.url() : "(no page)"}`);
        await ensureLoggedIn(s.page, s.loginId, s.password);
        s.lastActiveAt = new Date().toISOString();

        try {
          const result = await performBooking({
            id: s.loginId,
            password: s.password,
            roomIndex,
            roomId,
            dateValue,
            beginTime,
            endTime,
            reusePage: s.page
          });
          b.isRunning = false;
          b.finishedAt = new Date().toISOString();
          setBookingStep("done", s.page.url(), null);
          pushBookingLog("done");
          return result;
        } catch (e) {
          b.isRunning = false;
          b.finishedAt = new Date().toISOString();
          b.error = e && e.message ? String(e.message) : String(e);
          setBookingStep("error", s.page.url(), null);
          pushBookingLog(`error ${b.error}`);
          throw e;
        }
      });

      sendJson(res, 200, result);
      return;
    } catch (err) {
      sendJson(res, 500, {
        ok: false,
        message: "예약 신청 실패",
        error: err && err.message ? err.message : String(err)
      });
      return;
    }
  }

  if (method === "GET" && pathname === "/api/latest-json") {
    if (!fs.existsSync(LIVE_JSON_PATH)) {
      sendJson(res, 404, {
        ok: false,
        message: "latest_team_today.json 파일이 아직 없습니다."
      });
      return;
    }

    try {
      const raw = fs.readFileSync(LIVE_JSON_PATH, "utf8");
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store"
      });
      res.end(raw);
      return;
    } catch (err) {
      sendJson(res, 500, {
        ok: false,
        message: "JSON 파일 읽기 실패",
        error: err.message
      });
      return;
    }
  }

  if (method === "POST" && pathname === "/api/logout") {
    try {
      // Remove live json (used by dashboard)
      safeRemovePath(LIVE_JSON_PATH);

      await withPlaywrightLock(async () => {
        await closeSession().catch(() => {});
      });

      jobState = null;

      // Remove scraper output folders (e.g. cau_team_today_only_YYYYMMDD_HHMMSS)
      const entries = fs.readdirSync(ROOT_DIR, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) {
          continue;
        }

        if (!entry.name.startsWith("cau_team_today_only_")) {
          continue;
        }

        safeRemovePath(path.join(ROOT_DIR, entry.name));
      }

      sendJson(res, 200, {
        ok: true
      });
      return;
    } catch (err) {
      sendJson(res, 500, {
        ok: false,
        message: "로그아웃 처리 실패",
        error: err && err.message ? err.message : String(err)
      });
      return;
    }
  }

  if (method === "POST" && pathname === "/api/run") {
    try {
      const body = await parseBody(req);
      const id = body.id;
      const password = body.password;
      const dateValue = body.dateValue;

      if (!id || !password) {
        sendJson(res, 400, {
          ok: false,
          message: "아이디와 비밀번호를 입력해주세요."
        });
        return;
      }

      if (jobState && jobState.isRunning) {
        sendJson(res, 409, { ok: false, message: "이미 스크래퍼가 실행 중입니다." });
        return;
      }

      jobState = {
        isRunning: true,
        startedAt: new Date().toISOString(),
        finishedAt: null,
        progress: 5,
        step: "실행 준비 중",
        status: "running",
        error: null,
        pid: null,
        logs: [],
        data: null
      };

      withPlaywrightLock(async () => {
        try {
          pushJobLog("[worker] 세션 준비 중...");
          const scrapeHeadless = process.env.BOOK_HEADLESS === "true";
          const s = await getOrCreateSession({ loginId: id, password, headless: scrapeHeadless });
          await ensureLoggedIn(s.page, s.loginId, s.password);
          s.lastActiveAt = new Date().toISOString();

          const runtimeRoot = process.cwd();
          const outDir = path.join(
            runtimeRoot,
            `cau_team_today_only_${new Date()
              .toISOString()
              .replace(/[-:]/g, "")
              .replace(/\..+/, "")
              .replace("T", "_")}`
          );
          const liveJsonPath = path.join(runtimeRoot, "live", "latest_team_today.json");
          const finalJsonPath = path.join(outDir, "team_today_raw.json");
          const finalMdPath = path.join(outDir, "team_today_summary.md");

          const result = await runTeamTodayScraper({
            outDir,
            liveJsonPath,
            finalJsonPath,
            finalMdPath,
            headless: process.env.BOOK_HEADLESS === "true",
            credentials: { loginId: s.loginId, password: s.password },
            targetDateValue: dateValue,
            page: s.page,
            keepOpen: true
          });

          jobState.isRunning = false;
          jobState.finishedAt = new Date().toISOString();
          jobState.status = "done";
          jobState.step = "완료";
          jobState.progress = 100;
          jobState.data = result && result.output ? result.output : null;
          pushJobLog("[worker] 스크래퍼 완료");
          pushJobLog(`[worker] OUT_DIR: ${result.outDir}`);
          pushJobLog(`[worker] LIVE JSON: ${result.liveJsonPath}`);
          pushJobLog(`[worker] FINAL JSON: ${result.finalJsonPath}`);
        } catch (err) {
          jobState.isRunning = false;
          jobState.finishedAt = new Date().toISOString();
          jobState.status = "error";
          jobState.step = "실패";
          jobState.error = err && err.message ? err.message : String(err);
          pushJobLog("[worker] 스크래퍼 실패: " + jobState.error);
        }
      });

      sendJson(res, 200, {
        ok: true,
        message: "스크래퍼 실행 시작"
      });
      return;
    } catch (err) {
      const message = err && err.message ? err.message : "실행 요청 실패";
      const statusCode = message === "JSON 파싱 실패" ? 400 : 500;

      sendJson(res, statusCode, {
        ok: false,
        message: message
      });
      return;
    }
  }

  if (method === "GET" && pathname === "/") {
    res.writeHead(302, {
      Location: "/login"
    });
    res.end();
    return;
  }

  if (method === "GET" && pathname === "/login") {
    serveFile(res, path.join(PUBLIC_DIR, "login.html"));
    return;
  }

  if (method === "GET" && pathname === "/dashboard") {
    serveFile(res, path.join(PUBLIC_DIR, "dashboard.html"));
    return;
  }

  if (method === "GET" && pathname === "/favicon.ico") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (method === "GET" && pathname.startsWith("/public/")) {
    const filePath = resolvePublicPath(pathname);

    if (!filePath) {
      sendText(res, 403, "Forbidden");
      return;
    }

    serveFile(res, filePath);
    return;
  }

  // CSS, JS, 이미지 등 정적 파일 처리
  if (method === "GET" && (pathname.endsWith(".css") || pathname.endsWith(".js") || pathname.endsWith(".png") || pathname.endsWith(".jpg") || pathname.endsWith(".jpeg") || pathname.endsWith(".gif") || pathname.endsWith(".ico"))) {
    const filePath = path.join(PUBLIC_DIR, pathname);
    serveFile(res, filePath);
    return;
  }

  sendText(res, 404, "Not Found");
});

server.listen(PORT, () => {
  console.log("========================================");
  console.log("CAU TEAM ROOM WEB SERVER");
  console.log("========================================");
  console.log("URL       : http://localhost:" + PORT);
  console.log("LOGIN     : http://localhost:" + PORT + "/login");
  console.log("DASHBOARD : http://localhost:" + PORT + "/dashboard");
  console.log("ROOT      : " + ROOT_DIR);
  console.log("PUBLIC    : " + PUBLIC_DIR);
  console.log("LIVE JSON : " + LIVE_JSON_PATH);
});