const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { chromium } = require("playwright");
function debugLog(...args) {
  console.log("[DEBUG]", ...args);
}

const TRACE_WAIT = String(process.env.TRACE_WAIT || "0") === "1";

function waitStamp() {
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  const ms = String(d.getMilliseconds()).padStart(3, "0");
  return `${hh}:${mi}:${ss}.${ms}`;
}

async function waitTrace(label, fn, { intervalMs, timeoutMs, snapshot } = {}) {
  const startedAt = Date.now();
  const interval = Number(intervalMs) || 500;
  const timeout = Number(timeoutMs) || 0;
  let tick = 0;

  if (TRACE_WAIT) {
    console.log(`[WAIT] ${waitStamp()} START ${label}`);
  }

  const timer = setInterval(async () => {
    tick += 1;
    if (!TRACE_WAIT) return;
    const elapsed = Date.now() - startedAt;
    let snapText = "";
    if (typeof snapshot === "function") {
      try {
        const snap = await snapshot();
        snapText = snap ? ` | ${snap}` : "";
      } catch (e) {
        snapText = ` | snapshot-error=${String(e && e.message ? e.message : e)}`;
      }
    }
    console.log(`[WAIT] ${waitStamp()} ... ${label} tick=${tick} elapsed=${elapsed}ms${snapText}`);
  }, interval);

  try {
    if (!timeout) {
      const result = await fn();
      if (TRACE_WAIT) {
        const elapsed = Date.now() - startedAt;
        console.log(`[WAIT] ${waitStamp()} END ${label} (${elapsed}ms)`);
      }
      return result;
    }

    const result = await Promise.race([
      fn(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`timeout ${timeout}ms`)), timeout)
      )
    ]);
    if (TRACE_WAIT) {
      const elapsed = Date.now() - startedAt;
      console.log(`[WAIT] ${waitStamp()} END ${label} (${elapsed}ms)`);
    }
    return result;
  } catch (err) {
    if (TRACE_WAIT) {
      const elapsed = Date.now() - startedAt;
      let snapText = "";
      if (typeof snapshot === "function") {
        try {
          const snap = await snapshot();
          snapText = snap ? ` | ${snap}` : "";
        } catch (e) {
          snapText = ` | snapshot-error=${String(e && e.message ? e.message : e)}`;
        }
      }
      console.log(
        `[WAIT] ${waitStamp()} FAIL ${label} (${elapsed}ms) error=${String(err && err.message ? err.message : err)}${snapText}`
      );
    }
    throw err;
  } finally {
    clearInterval(timer);
  }
}

async function loginSnapshot(page) {
  const url = String(page.url() || "");
  const pwCount = await page.locator('input[type="password"]').count().catch(() => 0);
  const loginMarkerCount = await page
    .locator('text=중앙대학교 통합 LOGIN')
    .count()
    .catch(() => 0);
  return `url=${url} pwInputs=${pwCount} loginMarker=${loginMarkerCount}`;
}

const BASE_URL = "https://library.cau.ac.kr";
const LOGIN_URL = `${BASE_URL}/login?returnUrl=%2F&queryParamsHandling=merge`;
const TEAM_URL = `${BASE_URL}/library-services/room/team-rooms?tabIndex=2`;

const DEFAULT_VIEWPORT = { width: 980, height: 720 };

function nowStamp() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${yyyy}${mm}${dd}_${hh}${mi}${ss}`;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function createRl() {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
}

function ask(rl, q) {
  return new Promise((resolve) => rl.question(q, resolve));
}

function askHidden(query) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    const stdin = process.stdin;

    function onData(char) {
      char = char + "";
      switch (char) {
        case "\n":
        case "\r":
        case "\u0004":
          stdin.removeListener("data", onData);
          break;
        default:
          readline.cursorTo(process.stdout, 0);
          process.stdout.write(query + "*".repeat(rl.line.length));
          break;
      }
    }

    process.stdout.write(query);
    stdin.on("data", onData);

    rl.question("", (value) => {
      rl.close();
      process.stdout.write("\n");
      resolve(value);
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function minutesToHHMM(totalMinutes) {
  const mins = ((totalMinutes % (24 * 60)) + (24 * 60)) % (24 * 60);
  const hh = String(Math.floor(mins / 60)).padStart(2, "0");
  const mm = String(mins % 60).padStart(2, "0");
  return `${hh}:${mm}`;
}

function statusLabelFromClassName(className) {
  if (!className) return "unknown";
  if (className.includes("ikc-timeline-active")) return "이용중";
  if (className.includes("ikc-timeline-reserved")) return "예약중";
  if (className.includes("ikc-timeline-disabled")) return "이용불가";
  if (className.includes("ikc-timeline-reservable")) return "이용가능";
  if (className.includes("ikc-timeline-selected")) return "선택";
  if (className.includes("ikc-timeline-end")) return "끝";
  return "unknown";
}

function compressTimeline(slots) {
  if (!Array.isArray(slots) || slots.length === 0) return [];
  const result = [];
  let current = { ...slots[0] };

  for (let i = 1; i < slots.length; i += 1) {
    const slot = slots[i];
    if (
      slot.status === current.status &&
      slot.startMinute === current.endMinute
    ) {
      current.endMinute = slot.endMinute;
      current.end = slot.end;
    } else {
      result.push({
        status: current.status,
        start: current.start,
        end: current.end
      });
      current = { ...slot };
    }
  }

  result.push({
    status: current.status,
    start: current.start,
    end: current.end
  });

  return result;
}

function blocksToText(blocks) {
  if (!blocks || !blocks.length) return "-";
  return blocks.map((b) => `${b.start}~${b.end} ${b.status}`).join(" | ");
}

function formatStartEndMap(startEndMap) {
  if (!startEndMap || !startEndMap.length) return "-";
  return startEndMap
    .map((x) => {
      if (!x.ends || !x.ends.length) return `${x.start} -> 종료선택없음`;
      return `${x.start} -> ${x.ends.join(", ")}`;
    })
    .join(" | ");
}

function summarizeReservableWindowsFromStartEndMap(startEndMap) {
  if (!startEndMap || !startEndMap.length) return [];
  const result = [];

  for (const row of startEndMap) {
    if (!row.ends || row.ends.length === 0) continue;
    result.push({
      start: row.start,
      end: row.ends[row.ends.length - 1]
    });
  }

  return result;
}

function windowsToText(windows) {
  if (!windows || !windows.length) return "-";
  return windows.map((w) => `${w.start}~${w.end}`).join(" | ");
}

function buildMarkdown(data) {
  const lines = [];

  lines.push(`# 중앙대 팀플룸 당일 예약 가능 시간`);
  lines.push("");
  lines.push(`- 수집시각: ${data.scrapedAt}`);
  lines.push(`- 기준 페이지: ${data.sourceUrl}`);
  lines.push(`- 선택 날짜: ${data.selectedDateLabel || data.selectedDateValue || "-"}`);
  lines.push(`- 룸 수: ${data.rooms.length}`);
  lines.push("");

  lines.push(`## 바로 보기`);
  lines.push("");

  data.rooms.forEach((room, idx) => {
    lines.push(`### ${idx + 1}. ${room.name}`);
    lines.push(`- 기본정보: ${room.labelText || "-"}`);
    lines.push(`- 현재 상태 타임라인: ${blocksToText(room.blocks)}`);
    lines.push(`- 예약 가능한 시간대: ${windowsToText(room.detail ? room.detail.reservableWindows : [])}`);
    lines.push(`- 시작시간별 종료시간: ${formatStartEndMap(room.detail ? room.detail.startEndMap : [])}`);
    lines.push("");
  });

  lines.push(`## 상세`);
  lines.push("");

  data.rooms.forEach((room, idx) => {
    lines.push(`### ${idx + 1}. ${room.name}`);
    lines.push(`- 상세 URL: ${room.detail ? room.detail.detailUrl : "-"}`);

    if (room.detail && room.detail.infoRows && room.detail.infoRows.length) {
      for (const row of room.detail.infoRows) {
        lines.push(`- ${row.label || "정보"}: ${row.value || "-"}`);
      }
    }

    lines.push(`- 설명: ${room.detail ? room.detail.desc || "-" : "-"}`);
    lines.push(`- 주의사항: ${room.detail ? room.detail.attention || "-" : "-"}`);
    lines.push(`- 동반이용자 조건: ${room.detail ? room.detail.companionHint || "-" : "-"}`);
    lines.push(`- 용도 옵션: ${room.detail ? (room.detail.useSectionOptions || []).map((x) => x.label).join(", ") || "-" : "-"}`);
    lines.push(`- 예약 가능한 시간대: ${windowsToText(room.detail ? room.detail.reservableWindows : [])}`);
    lines.push(`- 시작시간별 종료시간: ${formatStartEndMap(room.detail ? room.detail.startEndMap : [])}`);
    lines.push("");
  });

  return lines.join("\n");
}

async function readAllBtnLoginTexts(page) {
  return page
    .evaluate(() => {
      const els = Array.from(document.querySelectorAll(".btn-login"));
      return els
        .map((el) => {
          const t = String(el.innerText || el.textContent || "");
          return t.replace(/\s+/g, " ").trim();
        })
        .filter((t) => t);
    })
    .catch(() => []);
}

function extractUserNameFromTexts(texts) {
  if (!Array.isArray(texts)) return null;
  for (const t of texts) {
    const normalized = String(t || "")
      .replace(/[\u200B-\u200D\uFEFF]/g, "")
      .replace(/\s+/g, " ")
      .trim();
    const m = normalized.match(/^(.+?)\s*님(?:\b|\s|$)/);
    if (m && m[1]) {
      const candidate = String(m[1]).trim();
      if (candidate && candidate !== "로그인") return candidate;
    }
  }
  return null;
}

async function readBodyText(page) {
  return page
    .locator("body")
    .innerText()
    .then((t) => String(t || "").replace(/\s+/g, " ").trim())
    .catch(() => "");
}

function extractUserNameFromBodyText(bodyText) {
  const text = String(bodyText || "").replace(/\s+/g, " ").trim();
  if (!text) return null;

  // Prefer greeting patterns if present.
  const m1 = text.match(/\b(\S+)\s*님\s*반갑습니다\b/);
  if (m1 && m1[1] && m1[1] !== "로그인") return m1[1];

  const m2 = text.match(/\b(\S+)\s*님\b/);
  if (m2 && m2[1] && m2[1] !== "로그인") return m2[1];

  return null;
}

async function extractUserNameRobust(page, { maxMs } = {}) {
  const deadlineMs = typeof maxMs === "number" ? maxMs : 2500;
  const startedAt = Date.now();

  let lastTexts = [];
  while (Date.now() - startedAt < deadlineMs) {
    const texts = await readAllBtnLoginTexts(page);
    lastTexts = texts;
    const extracted = extractUserNameFromTexts(texts);
    if (extracted) {
      return { userName: extracted, source: "btn-login", texts };
    }
    await sleep(250);
  }

  const bodyText = await readBodyText(page);
  const extractedBody = extractUserNameFromBodyText(bodyText);
  if (extractedBody) {
    return { userName: extractedBody, source: "body", texts: lastTexts };
  }

  return { userName: null, source: "none", texts: lastTexts };
}

function explainUserNameExtraction(texts) {
  if (!Array.isArray(texts) || texts.length === 0) {
    return { ok: false, reason: "no .btn-login elements", sample: [] };
  }
  const normalized = texts
    .map((t) =>
      String(t || "")
        .replace(/[\u200B-\u200D\uFEFF]/g, "")
        .replace(/\s+/g, " ")
        .trim()
    )
    .filter((t) => t);
  const hasNim = normalized.some((t) => t.includes("님"));
  if (!hasNim) {
    return { ok: false, reason: "no candidate contains 님", sample: normalized.slice(0, 8) };
  }
  const extracted = extractUserNameFromTexts(normalized);
  if (!extracted) {
    return {
      ok: false,
      reason: "contains 님 but regex/extraction returned null",
      sample: normalized.slice(0, 8)
    };
  }
  return { ok: true, reason: "extracted", sample: normalized.slice(0, 8), userName: extracted };
}

async function detectLoggedIn(page) {
  const currentUrl = String(page.url() || "");

  const isLoginUrl = currentUrl.includes("/login");

  // Strong marker: header login button shows "... 님" when authenticated.
  const headerTexts = await readAllBtnLoginTexts(page);
  const headerName = extractUserNameFromTexts(headerTexts);
  if (headerName) {
    return true;
  }

  // If we're on /login, assume NOT logged in unless strong marker exists.
  if (isLoginUrl) {
    return false;
  }

  // Non-/login pages: if password input exists, we are not logged in.
  const hasPassword = await page
    .locator('input[type="password"]')
    .count()
    .then((n) => n > 0)
    .catch(() => false);
  if (hasPassword) {
    return false;
  }

  // Non-/login pages: login screen marker present -> not logged in.
  const hasLoginMarker = await page
    .locator('text=중앙대학교 통합 LOGIN')
    .count()
    .then((n) => n > 0)
    .catch(() => false);
  if (hasLoginMarker) {
    return false;
  }

  // Last lightweight fallback: title hint (but never used for /login)
  const title = await page.title().catch(() => "");
  if (title && String(title).includes("LOGIN")) {
    return false;
  }

  return Boolean(currentUrl);
}

async function debugVisibleInputs(page) {
  return page.evaluate(() => {
    function isVisible(el) {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return (
        style &&
        style.visibility !== "hidden" &&
        style.display !== "none" &&
        rect.width > 0 &&
        rect.height > 0
      );
    }

    return Array.from(document.querySelectorAll("input")).map((el, idx) => ({
      idx,
      type: el.type || "",
      name: el.name || "",
      id: el.id || "",
      placeholder: el.placeholder || "",
      visible: isVisible(el)
    }));
  });
}

async function doLogin(page, loginId, password) {
  await waitTrace(
    "doLogin: goto LOGIN_URL domcontentloaded",
    async () => {
      await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" });
      await page.waitForLoadState("domcontentloaded").catch(() => {});
    },
    { timeoutMs: 20000, snapshot: () => loginSnapshot(page) }
  );

  // If already logged in, skip immediately.
  if (await waitTrace("doLogin: detectLoggedIn(pre)", () => detectLoggedIn(page), { timeoutMs: 5000, snapshot: () => loginSnapshot(page) })) {
    debugLog("doLogin: already logged in, skip");
    return;
  }

  // Wait for login inputs to be interactable (avoid fixed sleep)
  await waitTrace(
    "doLogin: wait first input visible",
    async () => {
      await page.locator("input").first().waitFor({ state: "visible", timeout: 15000 });
    },
    { timeoutMs: 16000, snapshot: () => loginSnapshot(page) }
  );

  const bodyText = await page.locator("body").innerText().catch(() => "");
  if (!bodyText.includes("중앙대학교 통합 LOGIN")) {
    throw new Error("로그인 페이지에서 통합 LOGIN 영역을 찾지 못했습니다.");
  }

  await waitTrace(
    "doLogin: wait input count>=2",
    async () => {
      await page.waitForFunction(() => {
        return document.querySelectorAll("input").length >= 2;
      }, { timeout: 15000 });
    },
    {
      timeoutMs: 16000,
      snapshot: async () => {
        const url = String(page.url() || "");
        const inputCount = await page.locator("input").count().catch(() => 0);
        const pwCount = await page.locator('input[type="password"]').count().catch(() => 0);
        return `url=${url} inputs=${inputCount} pwInputs=${pwCount}`;
      }
    }
  );

  const inputsDebug = await debugVisibleInputs(page);

  const visibleInputs = await page.locator("input").evaluateAll((els) => {
    function isVisible(el) {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return (
        style &&
        style.visibility !== "hidden" &&
        style.display !== "none" &&
        rect.width > 0 &&
        rect.height > 0
      );
    }

    return els
      .map((el, idx) => ({
        idx,
        type: el.type || "",
        name: el.name || "",
        id: el.id || "",
        placeholder: el.placeholder || "",
        visible: isVisible(el)
      }))
      .filter((x) => x.visible);
  });

  let idInput = visibleInputs.find((x) => x.type !== "password");
  let pwInput = visibleInputs.find((x) => x.type === "password");

  // Fallback: direct selector based (more robust across layout changes)
  if (!pwInput) {
    const pwCount = await page.locator('input[type="password"]').count().catch(() => 0);
    if (pwCount > 0) {
      const pwIdx = await page.locator('input[type="password"]').first().evaluate((el) => {
        const all = Array.from(document.querySelectorAll("input"));
        return all.indexOf(el);
      }).catch(() => -1);
      if (pwIdx >= 0) {
        pwInput = { idx: pwIdx, type: "password", visible: true };
      }
    }
  }

  if (!idInput && pwInput) {
    const idIdx = Math.max(0, Number(pwInput.idx) - 1);
    idInput = { idx: idIdx, type: "text", visible: true };
  }

  if (!idInput || !pwInput) {
    throw new Error(
      `로그인 입력창을 찾지 못했습니다. url=${page.url()} 감지된 input: ${JSON.stringify(inputsDebug)}`
    );
  }

  await page.locator("input").nth(idInput.idx).fill(loginId);
  await page.locator("input").nth(pwInput.idx).fill(password);

  const clicked = await page.evaluate(() => {
    function isVisible(el) {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return (
        style &&
        style.visibility !== "hidden" &&
        style.display !== "none" &&
        rect.width > 0 &&
        rect.height > 0
      );
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

  await waitTrace(
    "doLogin: click login -> navigation domcontentloaded",
    async () => {
      await Promise.allSettled([
        page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 15000 }),
        page.waitForLoadState("domcontentloaded")
      ]);
    },
    { timeoutMs: 16000, snapshot: () => loginSnapshot(page) }
  );

  // Wait until we are no longer on login page (dynamic)
  await waitTrace(
    "doLogin: wait leave /login and no LOGIN marker",
    async () => {
      await page
        .waitForFunction(() => {
          const url = String(location.href || "");
          const body = document.body ? String(document.body.innerText || "") : "";
          if (url.includes("/login")) return false;
          if (body.includes("중앙대학교 통합 LOGIN")) return false;
          return true;
        }, { timeout: 20000 })
        .catch(() => {});
    },
    { timeoutMs: 21000, snapshot: () => loginSnapshot(page) }
  );

  const loggedInPost = await waitTrace("doLogin: detectLoggedIn(post)", () => detectLoggedIn(page), { timeoutMs: 5000, snapshot: () => loginSnapshot(page) });
  if (!loggedInPost) {
    throw new Error(`로그인 후에도 로그인 상태가 아닙니다. 현재 URL=${page.url()}`);
  }
}

async function waitForTeamList(page) {
  const snap = async () => {
    const url = String(page.url() || "");
    const dateCount = await page.locator("#reservableDate").count().catch(() => 0);
    const cards = await page.locator(".ikc-card-rooms").count().catch(() => 0);
    return `url=${url} #reservableDate=${dateCount} .ikc-card-rooms=${cards}`;
  };

  try {
    await waitTrace(
      "waitForTeamList: goto TEAM_URL commit",
      async () => {
        await page.goto(TEAM_URL, { waitUntil: "commit", timeout: 8000 });
      },
      { timeoutMs: 9000, snapshot: snap }
    );
  } catch (err) {
    // Sometimes goto hangs after login; force redirect.
    await waitTrace(
      "waitForTeamList: goto failed -> location.href TEAM_URL",
      async () => {
        await page.evaluate((u) => {
          location.href = u;
        }, TEAM_URL).catch(() => {});
        await page
          .waitForURL((u) => String(u).includes("/library-services/room/team-rooms"), { timeout: 15000 })
          .catch(() => {});
      },
      { timeoutMs: 16000, snapshot: snap }
    );
  }

  // Team rooms list cards may not render until the date is queried.
  // Here we only wait for the page shell (date selector) to become available.
  await waitTrace(
    "waitForTeamList: wait #reservableDate",
    async () => {
      await page.waitForSelector("#reservableDate", { timeout: 15000 });
    },
    { timeoutMs: 16000, snapshot: snap }
  );
}

async function selectDateIfNeeded(page, targetDateValue) {
  const wanted = targetDateValue != null ? String(targetDateValue).trim() : "";
  const result = await page.evaluate((wantedValue) => {
    const dateSelect = document.querySelector("#reservableDate");
    if (!dateSelect) {
      return { found: false, selectedValue: null, selectedLabel: null };
    }

    const options = Array.from(dateSelect.querySelectorAll("option")).map((o) => ({
      value: o.value,
      label: (o.textContent || "").trim()
    }));

    const todayValue = new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Seoul" });
    const preferred = wantedValue
      ? (options.find((o) => String(o.value || "") === wantedValue) || null)
      : null;
    const selected = preferred || options.find((o) => o.value === todayValue) || options[0] || null;

    if (selected) {
      dateSelect.value = selected.value;
      dateSelect.dispatchEvent(new Event("change", { bubbles: true }));
    }

    return {
      found: true,
      selectedValue: selected ? selected.value : null,
      selectedLabel: selected ? selected.label : null
    };
  }, wanted);

  if (result.found) {
    const submitBtn = page.locator('button:has-text("조회")').first();
    if (await submitBtn.count().catch(() => 0)) {
      const snap = async () => {
        const url = String(page.url() || "");
        const disabled = await submitBtn.isDisabled().catch(() => null);
        const cards = await page.locator(".ikc-card-rooms").count().catch(() => 0);
        return `url=${url} 조회.disabled=${String(disabled)} cards=${cards}`;
      };

      await waitTrace(
        "selectTodayIfNeeded: wait 조회 visible",
        async () => {
          await submitBtn.waitFor({ state: "visible", timeout: 15000 }).catch(() => {});
        },
        { timeoutMs: 16000, snapshot: snap }
      );

      await waitTrace(
        "selectTodayIfNeeded: wait 조회 enabled",
        async () => {
          await page
            .waitForFunction(
              (el) => el && !el.disabled,
              { timeout: 15000 },
              await submitBtn.elementHandle().catch(() => null)
            )
            .catch(() => {});
        },
        { timeoutMs: 16000, snapshot: snap }
      );

      await waitTrace(
        "selectTodayIfNeeded: click 조회",
        async () => {
          await submitBtn.click().catch(() => {});
        },
        { timeoutMs: 5000, snapshot: snap }
      );

      // Wait until at least one card is rendered after query.
      await waitTrace(
        "selectTodayIfNeeded: wait cards render (.ikc-card-rooms>=1)",
        async () => {
          await page
            .waitForFunction(() => {
              const cards = document.querySelectorAll(".ikc-card-rooms");
              return cards && cards.length > 0;
            }, { timeout: 20000 })
            .catch(() => {});
        },
        { timeoutMs: 21000, snapshot: snap }
      );
    }
  }

  return result;
}

async function scrapeTeamList(page) {
  const listData = await page.evaluate(() => {
    function statusLabelFromClassName(className) {
      if (!className) return "unknown";
      if (className.includes("ikc-timeline-active")) return "이용중";
      if (className.includes("ikc-timeline-reserved")) return "예약중";
      if (className.includes("ikc-timeline-disabled")) return "이용불가";
      if (className.includes("ikc-timeline-reservable")) return "이용가능";
      if (className.includes("ikc-timeline-selected")) return "선택";
      if (className.includes("ikc-timeline-end")) return "끝";
      return "unknown";
    }

    function minutesToHHMM(totalMinutes) {
      const mins = ((totalMinutes % (24 * 60)) + (24 * 60)) % (24 * 60);
      const hh = String(Math.floor(mins / 60)).padStart(2, "0");
      const mm = String(mins % 60).padStart(2, "0");
      return `${hh}:${mm}`;
    }

    const cards = Array.from(document.querySelectorAll(".ikc-card-rooms"));

    return cards.map((card, idx) => {
      const name =
        (card.querySelector(".ikc-card-name")?.textContent || "").trim() ||
        `팀플룸${idx + 1}`;

      const labelText = (card.querySelector(".ikc-label")?.textContent || "")
        .replace(/\s+/g, " ")
        .trim();

      const timelineGroups = Array.from(card.querySelectorAll(".ikc-card-content .ikc-timeline"));
      const slots = [];

      timelineGroups.forEach((group) => {
        const hourText = (group.querySelector("b")?.textContent || "").trim();
        const hour = parseInt(hourText, 10);
        if (Number.isNaN(hour)) return;

        const segments = Array.from(group.children).filter((el) => el.tagName !== "B");

        segments.forEach((seg, segIdx) => {
          const cls = seg.className || "";
          const status = statusLabelFromClassName(cls);
          if (status === "끝") return;

          const startMinute = hour * 60 + segIdx * 10;
          const endMinute = startMinute + 10;

          slots.push({
            status,
            start: minutesToHHMM(startMinute),
            end: minutesToHHMM(endMinute),
            startMinute,
            endMinute
          });
        });
      });

      return {
        index: idx,
        name,
        labelText,
        slots
      };
    });
  });

  return listData.map((room) => ({
    index: room.index,
    name: room.name,
    labelText: room.labelText,
    slots: room.slots,
    blocks: compressTimeline(room.slots)
  }));
}

async function openRoomDetailFromList(page, roomIndex) {
  const card = page.locator(".ikc-card-rooms").nth(roomIndex);
  const reserveBtn = card.locator('button:has-text("예약")').first();

  await Promise.all([
    page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {}),
    reserveBtn.click()
  ]);

  await page.waitForSelector(".ikc-room-info", { timeout: 15000 });
}

async function readSelectOptions(page, selector) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return [];
    return Array.from(el.querySelectorAll("option"))
      .map((o) => ({
        value: o.value,
        label: (o.textContent || "").trim()
      }))
      .filter((x) => x.value !== "");
  }, selector);
}

async function scrapeRoomDetailBasic(page) {
  const detail = await page.evaluate(() => {
    function statusLabelFromClassName(className) {
      if (!className) return "unknown";
      if (className.includes("ikc-timeline-active")) return "이용중";
      if (className.includes("ikc-timeline-reserved")) return "예약중";
      if (className.includes("ikc-timeline-disabled")) return "이용불가";
      if (className.includes("ikc-timeline-reservable")) return "이용가능";
      if (className.includes("ikc-timeline-selected")) return "선택";
      if (className.includes("ikc-timeline-end")) return "끝";
      return "unknown";
    }

    function minutesToHHMM(totalMinutes) {
      const mins = ((totalMinutes % (24 * 60)) + (24 * 60)) % (24 * 60);
      const hh = String(Math.floor(mins / 60)).padStart(2, "0");
      const mm = String(mins % 60).padStart(2, "0");
      return `${hh}:${mm}`;
    }

    const roomTitle =
      (document.querySelector(".ikc-room-title")?.textContent || "").trim() || "";

    const infoRows = Array.from(document.querySelectorAll(".ikc-room-info li")).map((li) => {
      const label = (li.querySelector(".ikc-label")?.textContent || "").trim();
      const cloned = li.cloneNode(true);
      const labelEl = cloned.querySelector(".ikc-label");
      if (labelEl) labelEl.remove();
      const value = (cloned.textContent || "").replace(/\s+/g, " ").trim();
      return { label, value };
    });

    const desc = (document.querySelector(".ikc-room-info-description")?.textContent || "").trim();
    const attention = (document.querySelector(".ikc-room-info-attention")?.textContent || "").trim();

    const companionHint =
      (document.querySelector(".ikc-form-partners .mat-hint")?.textContent || "")
        .replace(/\s+/g, " ")
        .trim();

    const useSectionOptions = Array.from(document.querySelectorAll("#useSection option"))
      .map((o) => ({
        value: o.value,
        label: (o.textContent || "").trim()
      }))
      .filter((x) => x.value !== "");

    const timelineGroups = Array.from(document.querySelectorAll(".ikc-date-timeline .ikc-timeline-wrap .ikc-timeline"));
    const slots = [];

    timelineGroups.forEach((group) => {
      const hourText = (group.querySelector("b")?.textContent || "").trim();
      const hour = parseInt(hourText, 10);
      if (Number.isNaN(hour)) return;

      const segments = Array.from(group.children).filter((el) => el.tagName !== "B");
      segments.forEach((seg, segIdx) => {
        const cls = seg.className || "";
        const status = statusLabelFromClassName(cls);
        if (status === "끝") return;

        const startMinute = hour * 60 + segIdx * 10;
        const endMinute = startMinute + 10;

        slots.push({
          status,
          start: minutesToHHMM(startMinute),
          end: minutesToHHMM(endMinute),
          startMinute,
          endMinute
        });
      });
    });

    return {
      detailUrl: location.href,
      roomTitle,
      infoRows,
      desc,
      attention,
      companionHint,
      useSectionOptions,
      slots
    };
  });

  detail.blocks = compressTimeline(detail.slots);
  return detail;
}

async function collectStartEndOptions(page) {
  const hopeDates = await readSelectOptions(page, "#hopeDate");
  const beginTimes = await readSelectOptions(page, "#beginTime");

  const result = [];
  
  // 전체 시작 시간 다 처리 (정확한 정보를 위해)
  for (const begin of beginTimes) {
    await page.selectOption("#beginTime", begin.value).catch(() => {});
    await sleep(100); // 최적화된 sleep 유지

    const endTimes = await readSelectOptions(page, "#endTime");

    result.push({
      start: begin.label,
      startValue: begin.value,
      ends: endTimes.map((x) => x.label),
      endValues: endTimes.map((x) => x.value)
    });
  }

  return {
    hopeDates,
    startEndMap: result
  };
}

async function collectCredentials() {
  const rl = createRl();

  let loginId = (process.env.CAU_ID || "").trim();
  let password = process.env.CAU_PW || "";

  if (!loginId) {
    loginId = (await ask(rl, "중앙대 포탈 ID: ")).trim();
  }
  rl.close();

  if (!password) {
    password = await askHidden("비밀번호: ");
  }

  if (!loginId || !password) {
    throw new Error("ID 또는 비밀번호가 비어 있습니다.");
  }

  return { loginId, password };
}

async function runTeamTodayScraper(options) {
  const opts = options || {};
  const outDir = opts.outDir || path.join(process.cwd(), `cau_team_today_only_${nowStamp()}`);
  const liveJsonPath = opts.liveJsonPath || path.join(outDir, "latest_team_today.json");
  const finalJsonPath = opts.finalJsonPath || path.join(outDir, "team_today_raw.json");
  const finalMdPath = opts.finalMdPath || path.join(outDir, "team_today_summary.md");
  const headless = true;
  const credentials = opts.credentials || (await collectCredentials());
  const injectedPage = opts.page || null;
  const keepOpen = Boolean(opts.keepOpen);
  const injectedUserName = opts.initialUserName != null && String(opts.initialUserName).trim()
    ? String(opts.initialUserName).trim()
    : null;

  ensureDir(outDir);
  ensureDir(path.dirname(liveJsonPath));
  ensureDir(path.dirname(finalJsonPath));
  ensureDir(path.dirname(finalMdPath));

  const browser = injectedPage
    ? null
    : await waitTrace(
        `chromium.launch headless=${String(headless)}`,
        async () => {
          return await chromium.launch({ headless });
        },
        { timeoutMs: 30000 }
      );
  const context = injectedPage
    ? injectedPage.context()
    : await waitTrace(
        "browser.newContext(viewport 1440x1200)",
        async () => {
          return await browser.newContext({
            viewport: headless ? { width: 1440, height: 1200 } : DEFAULT_VIEWPORT
          });
        },
        { timeoutMs: 15000 }
      );

  const page = injectedPage
    ? injectedPage
    : await waitTrace(
        "context.newPage()",
        async () => {
          return await context.newPage();
        },
        { timeoutMs: 15000 }
      );

  function writeLive(output) {
    fs.writeFileSync(liveJsonPath, JSON.stringify(output, null, 2), "utf8");
    debugLog("LIVE:", output.currentStep, "| rooms:", output.rooms?.length);
  }
  try {
    console.log("\n==================================================");
    console.log("CAU TEAM ROOM TODAY SCRAPER");
    console.log("==================================================");
    console.log(`OUT_DIR: ${outDir}`);
    console.log("");

    const liveBase = {
      scrapedAt: new Date().toISOString(),
      sourceUrl: TEAM_URL,
      selectedDateValue: null,
      selectedDateLabel: null,
      status: "starting",
      currentStep: "로그인 준비",
      rooms: []
    };
    writeLive(liveBase);

    console.log("[1] 로그인 중...");

    await waitTrace(
      "doLogin(full)",
      async () => {
        await doLogin(page, credentials.loginId, credentials.password);
      },
      { timeoutMs: 60000, intervalMs: 500, snapshot: () => loginSnapshot(page) }
    );

    debugLog("로그인 완료, 현재 URL:", page.url());
    console.log("[완료] 로그인 성공");

    // Prefer worker-injected userName (more reliable than scraping DOM on Angular pages).
    let userName = injectedUserName;
    if (userName) {
      debugLog("userName(injected):", userName);
    }

    liveBase.status = "running";
    liveBase.currentStep = "팀플룸 페이지 진입";
    liveBase.scrapedAt = new Date().toISOString();
    liveBase.userName = userName; // 사용자 이름 저장
    writeLive(liveBase);

    console.log("[2] 팀플룸 페이지 진입 중...");
    await waitForTeamList(page);
    debugLog("팀플룸 페이지 로딩 완료1");
    const selectedDate = await selectDateIfNeeded(page, opts.targetDateValue);
    debugLog("팀플룸 페이지 로딩 완료2");
    console.log(`[완료] 날짜 선택: ${selectedDate.selectedLabel || selectedDate.selectedValue || "-"}`);

    // Team rooms query/DOM is ready now; if userName not injected, try to scrape it.
    if (!userName) {
      try {
        const r = await extractUserNameRobust(page, { maxMs: 2500 });
        userName = r.userName;
        const texts = Array.isArray(r.texts) ? r.texts : [];
        const explain = explainUserNameExtraction(texts);
        if (userName) {
          debugLog(
            "userName(after query): ok",
            JSON.stringify({ userName, source: r.source, candidates: texts.length, sample: (explain.sample || []).slice(0, 8) })
          );
        } else {
          debugLog(
            "userName(after query): null",
            JSON.stringify({ reason: explain.reason, source: r.source, candidates: texts.length, sample: (explain.sample || []).slice(0, 8) })
          );
        }
        if (userName) {
          liveBase.userName = userName;
          writeLive(liveBase);
        }
      } catch (e) {
        // ignore
      }
    }

    liveBase.selectedDateValue = selectedDate.selectedValue || null;
    liveBase.selectedDateLabel = selectedDate.selectedLabel || null;
    liveBase.currentStep = "팀플룸 리스트 수집";
    liveBase.scrapedAt = new Date().toISOString();
    writeLive(liveBase);

    console.log("[3] 팀플룸 리스트 수집 중...");
    const rooms = await scrapeTeamList(page);
    debugLog("스크랩된 룸 수:", rooms.length);
    console.log(`[완료] 룸 ${rooms.length}개`);

    liveBase.rooms = rooms.map((room) => ({
      index: room.index,
      name: room.name,
      labelText: room.labelText,
      slots: room.slots,
      blocks: room.blocks,
      detail: null
    }));
    liveBase.scrapedAt = new Date().toISOString();
    writeLive(liveBase);

    // 개별 팀플룸 상세 처리 함수 (최적화된 병렬)
async function processRoomDetail(page, room, index, totalRooms) {
  debugLog("최적화 병렬 처리 시작:", index, room.name);
  console.log(`[4-${index + 1}] ${room.name} 상세 진입...`);

  // 새 페이지 생성
  const detailPage = await page.context().newPage();
  
  // 네트워크 최적화
  await detailPage.route('**/*.{png,jpg,jpeg,gif,css,font,svg,ico,webp}', route => route.abort());
  await detailPage.route('**/analytics/**', route => route.abort());
  await detailPage.route('**/gtm.js', route => route.abort());
  
  try {
    const hopeDate = selectedDate && selectedDate.selectedValue ? String(selectedDate.selectedValue) : "";
    const listUrl = hopeDate ? `${TEAM_URL}&hopeDate=${encodeURIComponent(hopeDate)}` : TEAM_URL;
    await detailPage.goto(listUrl, { waitUntil: "domcontentloaded" });
    await detailPage.waitForSelector(".ikc-card-rooms", { timeout: 5000 });
    
    await openRoomDetailFromList(detailPage, index);
    
    debugLog("상세페이지 진입 완료:", detailPage.url());
    const basic = await scrapeRoomDetailBasic(detailPage);
    debugLog("basic 수집 완료:", room.name, "slots:", basic.slots?.length);
    
    debugLog("collectStartEndOptions 시작 (최적화됨)");
    const dynamic = await collectStartEndOptions(detailPage);
    debugLog("collectStartEndOptions 완료:", dynamic.startEndMap?.length);
    
    basic.hopeDateOptions = dynamic.hopeDates;
    basic.startEndMap = dynamic.startEndMap;
    basic.reservableWindows = summarizeReservableWindowsFromStartEndMap(dynamic.startEndMap);
    debugLog("가능시간 계산:", windowsToText(basic.reservableWindows));
    
    room.detail = basic;
    
    console.log(`[완료] ${room.name} / 가능시간: ${windowsToText(basic.reservableWindows)}`);
    debugLog("최적화 병렬 처리 완료:", index, room.name);
    
    return { room, index, success: true };
    
  } catch (error) {
    debugLog("최적화 병렬 처리 실패:", index, room.name, error.message);
    console.log(`[실패] ${room.name} - ${error.message}`);
    return { room, index, success: false, error: error.message };
  } finally {
    await detailPage.close();
  }
}

// 최적화된 병렬 처리
async function processAllRoomsOptimizedParallel(page, rooms) {
  const MAX_CONCURRENT = 10; // 다시 10개로
  const results = [];
  
  const startTime = Date.now();
  console.log(`[최적화 병렬 처리 시작] ${rooms.length}개 팀플룸, ${MAX_CONCURRENT}개씩 동시 처리`);
  console.log(`[시간 측정 시작] ${new Date().toLocaleTimeString()}`);
  
  for (let i = 0; i < rooms.length; i += MAX_CONCURRENT) {
    const batchStartTime = Date.now();
    const batch = rooms.slice(i, i + MAX_CONCURRENT);
    const batchPromises = batch.map((room, batchIndex) => 
      processRoomDetail(page, room, i + batchIndex, rooms.length)
    );
    
    const batchResults = await Promise.allSettled(batchPromises);
    const batchEndTime = Date.now();
    const batchDuration = (batchEndTime - batchStartTime) / 1000;
    
    // 결과 처리
    batchResults.forEach((result, batchIndex) => {
      if (result.status === 'fulfilled') {
        results.push(result.value);
      } else {
        const roomIndex = i + batchIndex;
        console.log(`[오류] ${rooms[roomIndex].name} - ${result.reason.message}`);
        results.push({ 
          room: rooms[roomIndex], 
          index: roomIndex, 
          success: false, 
          error: result.reason.message 
        });
      }
    });
    
    // 진행상황 업데이트
    const processedCount = Math.min(i + MAX_CONCURRENT, rooms.length);
    console.log(`[진행] ${processedCount}/${rooms.length} 팀플룸 처리 완료 (배치 시간: ${batchDuration.toFixed(1)}초)`);
  }
  
  const endTime = Date.now();
  const totalDuration = (endTime - startTime) / 1000;
  console.log(`[시간 측정 완료] 총 ${totalDuration.toFixed(1)}초 (${new Date().toLocaleTimeString()})`);
  console.log(`[성능] 평균 ${rooms.length}개 팀플룸 / ${totalDuration.toFixed(1)}초 = ${(totalDuration/rooms.length).toFixed(1)}초/룸`);
  
  return results;
}

    // 최적화된 병렬로 팀플룸 상세 처리 실행
    liveBase.currentStep = "팀플룸 상세 정보 최적화 병렬 수집 중";
    liveBase.scrapedAt = new Date().toISOString();
    writeLive(liveBase);
    
    const results = await processAllRoomsOptimizedParallel(page, rooms);
    
    // 결과 업데이트
    results.forEach((result) => {
      if (result.success) {
        const { room, index } = result;
        liveBase.rooms[index] = {
          index: room.index,
          name: room.name,
          labelText: room.labelText,
          slots: room.slots,
          blocks: room.blocks,
          detail: room.detail
        };
      }
    });
    
    liveBase.scrapedAt = new Date().toISOString();
    writeLive(liveBase);
    
    console.log(`[완료] 최적화 병렬 처리 완료 - 성공: ${results.filter(r => r.success).length}, 실패: ${results.filter(r => !r.success).length}`);

    const output = {
      scrapedAt: new Date().toISOString(),
      sourceUrl: TEAM_URL,
      selectedDateValue: selectedDate.selectedValue || null,
      selectedDateLabel: selectedDate.selectedLabel || null,
      userName: userName || null,
      status: "done",
      currentStep: "완료",
      rooms
    };

    fs.writeFileSync(finalJsonPath, JSON.stringify(output, null, 2), "utf8");
    fs.writeFileSync(finalMdPath, buildMarkdown(output), "utf8");
    fs.writeFileSync(liveJsonPath, JSON.stringify(output, null, 2), "utf8");

    console.log("");
    console.log("==================================================");
    console.log("완료");
    console.log("==================================================");


    return {
      outDir,
      liveJsonPath,
      finalJsonPath,
      finalMdPath,
      output
    };
  } finally {
    if (!injectedPage && !keepOpen) {
      await context.close().catch(() => {});
      await browser.close().catch(() => {});
    }
  }
}

module.exports = {
  runTeamTodayScraper,
  nowStamp,
  ensureDir,
  windowsToText,
  blocksToText,
  formatStartEndMap,
  buildMarkdown
};