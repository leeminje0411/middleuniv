const http = require("http");
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const https = require("https");
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

let _supabaseClient = null;
function getSupabaseClientIfAvailable() {
  if (_supabaseClient !== null) return _supabaseClient;

  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    _supabaseClient = undefined;
    return _supabaseClient;
  }

  try {
    // Lazy-require so the server can still run without this dependency.
    const { createClient } = require("@supabase/supabase-js");
    _supabaseClient = createClient(url, serviceKey, {
      auth: { persistSession: false },
      global: {
        headers: {
          "x-client-info": "cau_probe_runtime/server"
        }
      }
    });
    return _supabaseClient;
  } catch (err) {
    _supabaseClient = undefined;
    return _supabaseClient;
  }
}

function readMembersFromJsonFile() {
  if (!fs.existsSync(TEAM_MEMBERS_PATH)) return [];
  const raw = fs.readFileSync(TEAM_MEMBERS_PATH, "utf8");
  const parsed = raw ? JSON.parse(raw) : {};
  const members = parsed && Array.isArray(parsed.members) ? parsed.members : [];
  return members;
}

function writeMembersToJsonFile(members) {
  if (!fs.existsSync(RUNTIME_DIR)) {
    fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  }
  const payload = { members: Array.isArray(members) ? members : [] };
  fs.writeFileSync(TEAM_MEMBERS_PATH, JSON.stringify(payload, null, 2) + "\n", "utf8");
}

function normalizeEverytimeUrl(input) {
  const raw = String(input || "").trim();
  if (!raw) return "";

  try {
    const u = new URL(raw);
    if (!u.hostname.endsWith("everytime.kr")) return "";
    u.hash = "";
    return u.toString();
  } catch (e) {
    return "";
  }
}

function extractEverytimeTokenFromUrl(input) {
  const raw = String(input || "").trim();
  if (!raw) return "";
  const m = raw.match(/\/\@([^/?#]+)/);
  return m && m[1] ? String(m[1]) : "";
}

function fetchTextWithRedirects(targetUrl, { maxRedirects = 5, timeoutMs = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    const normalized = String(targetUrl || "").trim();
    if (!normalized) {
      reject(new Error("url이 필요합니다."));
      return;
    }

    let current = normalized;
    let redirects = 0;

    function doRequest(nextUrl) {
      let u;
      try {
        u = new URL(nextUrl);
      } catch (e) {
        reject(new Error("url 형식이 올바르지 않습니다."));
        return;
      }

      const lib = u.protocol === "https:" ? https : http;
      const req = lib.request(
        {
          method: "GET",
          hostname: u.hostname,
          port: u.port || (u.protocol === "https:" ? 443 : 80),
          path: u.pathname + (u.search || ""),
          headers: {
            "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
            accept: "text/html,application/xhtml+xml"
          }
        },
        (res) => {
          const status = res.statusCode || 0;
          const loc = res.headers && res.headers.location ? String(res.headers.location) : "";

          if (status >= 300 && status < 400 && loc) {
            if (redirects >= maxRedirects) {
              reject(new Error("redirect가 너무 많습니다."));
              res.resume();
              return;
            }

            redirects += 1;
            const resolved = new URL(loc, u.toString()).toString();
            current = resolved;
            res.resume();
            doRequest(resolved);
            return;
          }

          if (status < 200 || status >= 300) {
            reject(new Error(`HTTP ${status}`));
            res.resume();
            return;
          }

          res.setEncoding("utf8");
          let body = "";
          res.on("data", (chunk) => {
            body += chunk;
            if (body.length > 6 * 1024 * 1024) {
              req.destroy(new Error("응답이 너무 큽니다."));
            }
          });
          res.on("end", () => {
            resolve({ url: current, text: body });
          });
        }
      );

      req.on("error", (err) => reject(err));
      req.setTimeout(timeoutMs, () => {
        req.destroy(new Error("요청 시간이 초과되었습니다."));
      });
      req.end();
    }

    doRequest(current);
  });
}

function parseEverytimeProfileAndTerms(html, baseUrl) {
  const text = String(html || "");
  const base = String(baseUrl || "https://everytime.kr");

  function stripTags(s) {
    return String(s || "")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  const nameMatch = text.match(/<aside[\s\S]*?<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const profileName = nameMatch && nameMatch[1] ? stripTags(nameMatch[1]) : "";

  const ogMatch = text.match(/<meta\s+property=["']og:url["']\s+content=["']([^"']+)["']/i);
  const ogUrl = ogMatch && ogMatch[1] ? String(ogMatch[1]).trim() : "";

  const terms = [];
  const asideMatch = text.match(/<aside[\s\S]*?<div\s+class=["']menu["'][\s\S]*?<\/aside>/i);
  const asideHtml = asideMatch ? asideMatch[0] : "";

  if (asideHtml) {
    const liRe = /<li([^>]*)>[\s\S]*?<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>[\s\S]*?<\/li>/gi;
    let m;
    while ((m = liRe.exec(asideHtml))) {
      const liAttrs = m[1] || "";
      const href = m[2] || "";
      const label = stripTags(m[3] || "");

      let abs = "";
      try {
        abs = new URL(href, base).toString();
      } catch (e) {
        abs = "";
      }

      if (!abs) continue;
      if (!abs.includes("everytime.kr")) continue;

      terms.push({
        label: String(label).trim(),
        url: abs,
        sourceTermToken: extractEverytimeTokenFromUrl(abs) || null,
        isCurrent: /class\s*=\s*["'][^"']*active[^"']*["']/i.test(liAttrs)
      });
    }
  }

  const isTermDetail = /class=["']tablebody["']/i.test(text) && /class=["']subject\b/i.test(text);

  return {
    profileName,
    ogUrl: ogUrl || null,
    isTermDetail,
    terms
  };
}

function parseEverytimeTimetableFromHtml(html, { pxPerHour } = {}) {
  const text = String(html || "");

  function stripTags(s) {
    return String(s || "")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function getStylePx(styleText, prop) {
    const s = String(styleText || "");
    const re = new RegExp(`${prop}\\s*:\\s*([0-9.]+)px`, "i");
    const m = s.match(re);
    if (!m || !m[1]) return null;
    const n = Number(m[1]);
    return Number.isFinite(n) ? n : null;
  }

  const subjectExists = /class=["']subject\b/i.test(text);
  if (!subjectExists) {
    return { courses: [], meetings: [], debug: { subjectExists: false } };
  }

  // Heuristic: Everytime timetable uses ~75px per hour (2h ~= 150px).
  const usedPxPerHour = Number.isFinite(Number(pxPerHour)) ? Number(pxPerHour) : 75;
  const pxPerMinute = usedPxPerHour / 60;

  // Extract timetable columns (Mon..Sun). We only support visible columns; hidden (Sat/Sun) are commonly display:none.
  const tableMatch = text.match(/<table\s+class=["']tablebody["'][\s\S]*?<\/table>/i);
  const tableHtml = tableMatch ? tableMatch[0] : "";
  const tdRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;

  // Determine the baseline start hour from tablehead (e.g. 9, 10, 11...) so top:0 aligns with real time.
  let baseStartMinute = 0;
  try {
    const headMatch = text.match(/<table\s+class=["']tablehead["'][\s\S]*?<\/table>/i);
    const headHtml = headMatch ? headMatch[0] : "";
    const hourMatches = Array.from(headHtml.matchAll(/<b[^>]*>\s*(\d{1,2})\s*<\/b>/gi)).map((m) => Number(m[1]));
    const hours = hourMatches.filter((h) => Number.isFinite(h) && h >= 0 && h <= 23);
    if (hours.length) {
      const minHour = Math.min(...hours);
      baseStartMinute = Math.max(0, Math.min(23 * 60, minHour * 60));
    }
  } catch (e) {
    baseStartMinute = 0;
  }

  const days = [];
  let tdIdx = 0;
  let td;
  while ((td = tdRe.exec(tableHtml))) {
    tdIdx += 1;
    // Skip the first td? In the actual markup, first cell is <th> times, and then <td> columns.
    const dayOfWeek = tdIdx - 1; // 0=Mon
    if (dayOfWeek < 0 || dayOfWeek > 6) continue;
    const tdHtml = td[1] || "";
    // Ignore hidden weekend columns.
    if (/display\s*:\s*none/i.test(td[0])) continue;
    days.push({ dayOfWeek, html: tdHtml });
  }

  const courseMap = new Map();
  const meetingRows = [];

  for (const day of days) {
    const tdHtml = String(day.html || "");
    const subjectRe = /<div\s+class=["']subject\s+([^"']+)["'][^>]*style=["']([^"']+)["'][^>]*>([\s\S]*?)<\/div>/gi;
    let sm;
    while ((sm = subjectRe.exec(tdHtml))) {
      const classTail = sm[1] || "";
      const styleText = sm[2] || "";
      const inner = sm[3] || "";

      const topPx = getStylePx(styleText, "top");
      const heightPx = getStylePx(styleText, "height");
      if (topPx == null || heightPx == null) continue;

      const startMinute = Math.max(0, Math.min(1439, baseStartMinute + Math.round(topPx / pxPerMinute)));
      const endMinute = Math.max(1, Math.min(1440, baseStartMinute + Math.round((topPx + heightPx) / pxPerMinute)));
      if (endMinute <= startMinute) continue;

      const nameMatch = inner.match(/<h3[^>]*>([\s\S]*?)<\/h3>/i);
      const courseName = nameMatch ? stripTags(nameMatch[1]) : "";
      if (!courseName) continue;

      const instructorMatch = inner.match(/<em[^>]*>([\s\S]*?)<\/em>/i);
      const instructorName = instructorMatch ? stripTags(instructorMatch[1]) : null;

      const locMatch = inner.match(/<span[^>]*>([\s\S]*?)<\/span>/i);
      const locationText = locMatch ? stripTags(locMatch[1]) : null;

      const colorKeyMatch = String(classTail).match(/\bcolor(\d+)\b/i);
      const colorKey = colorKeyMatch ? `color${colorKeyMatch[1]}` : null;

      const courseKey = `${courseName}||${instructorName || ""}||${locationText || ""}`;
      if (!courseMap.has(courseKey)) {
        courseMap.set(courseKey, {
          course_name: courseName,
          instructor_name: instructorName,
          location_text: locationText,
          color_key: colorKey,
          meetings: []
        });
      }
      courseMap.get(courseKey).meetings.push({
        day_of_week: day.dayOfWeek,
        start_minute: startMinute,
        end_minute: endMinute
      });
    }
  }

  const courses = Array.from(courseMap.values());
  return {
    courses,
    meetingCount: courses.reduce((acc, c) => acc + (c.meetings ? c.meetings.length : 0), 0),
    debug: {
      subjectExists: true,
      pxPerHour: usedPxPerHour,
      baseStartMinute,
      dayCount: days.length
    }
  };
}

function normalizeTextLoose(input) {
  return String(input || "")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[\-_/().,~'"`·:;!?\[\]{}<>|@#$%^&*+=\\]/g, "")
    .trim();
}

function parseAcademicTermLabel(termLabel) {
  const label = String(termLabel || "").replace(/\s+/g, " ").trim();
  const yearMatch = label.match(/(19\d{2}|20\d{2})/);
  const year = yearMatch ? Number(yearMatch[1]) : null;

  let termType = null;
  if (/겨울|winter/i.test(label)) termType = "winter";
  else if (/여름|summer/i.test(label)) termType = "summer";
  else if (/1\s*학기|\b1st\b/i.test(label)) termType = "1";
  else if (/2\s*학기|\b2nd\b/i.test(label)) termType = "2";
  else if (/학기/.test(label)) termType = "unknown";

  return {
    year,
    term_type: termType,
    term_label: label || null,
    campus: null
  };
}

function meetingOverlapScore(a, b) {
  if (!a || !b) return 0;
  if (a.day_of_week !== b.day_of_week) return 0;
  const s = Math.max(a.start_minute, b.start_minute);
  const e = Math.min(a.end_minute, b.end_minute);
  const overlap = Math.max(0, e - s);
  if (overlap <= 0) return 0;
  const lenA = Math.max(1, a.end_minute - a.start_minute);
  const lenB = Math.max(1, b.end_minute - b.start_minute);
  const denom = Math.max(lenA, lenB);
  return overlap / denom;
}

function bestMeetingOverlapScore(sourceMeetings, catalogMeetings) {
  const src = Array.isArray(sourceMeetings) ? sourceMeetings : [];
  const cat = Array.isArray(catalogMeetings) ? catalogMeetings : [];
  if (!src.length || !cat.length) return 0;

  let total = 0;
  for (const sm of src) {
    let best = 0;
    for (const cm of cat) {
      best = Math.max(best, meetingOverlapScore(sm, cm));
    }
    total += best;
  }
  return total / src.length;
}

async function fetchEverytimeHtmlWithFallback(targetUrl) {
  const fetched = await fetchTextWithRedirects(targetUrl);
  const parsed = parseEverytimeProfileAndTerms(fetched.text, fetched.url);

  const hasTerms = Boolean(parsed && Array.isArray(parsed.terms) && parsed.terms.length);
  const hasName = Boolean(parsed && String(parsed.profileName || "").trim());
  const looksOk = Boolean(hasTerms || hasName || parsed.isTermDetail);

  if (looksOk) {
    return { url: fetched.url, text: fetched.text, via: "http" };
  }

  const rendered = await withPlaywrightLock(async () => {
    const browser = await chromium.launch({
      headless: true,
      args: ["--disable-blink-features=AutomationControlled"]
    });
    const context = await browser.newContext({
      viewport: DEFAULT_VIEWPORT,
      locale: "ko-KR",
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36"
    });
    await context.addInitScript(() => {
      try {
        Object.defineProperty(navigator, "webdriver", { get: () => undefined });
        Object.defineProperty(navigator, "languages", { get: () => ["ko-KR", "ko", "en-US", "en"] });
        Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3, 4, 5] });
      } catch (e) {
        // ignore
      }
    });
    const page = await context.newPage();
    try {
      await page.route("**/*", (route) => {
        const type = route.request().resourceType();
        if (type === "image" || type === "font" || type === "media") {
          route.abort().catch(() => {});
          return;
        }
        route.continue().catch(() => {});
      });

      await page.goto(fetched.url, { waitUntil: "domcontentloaded", timeout: 25000 });
      await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});

      await Promise.race([
        page.waitForSelector("aside .menu ol li a", { timeout: 12000 }).catch(() => null),
        page.waitForSelector(".tablebody .subject", { timeout: 12000 }).catch(() => null)
      ]);
      await page.waitForTimeout(900);

      const debug = await page
        .evaluate(() => {
          const links = document.querySelectorAll("aside .menu ol li a");
          const subjects = document.querySelectorAll(".tablebody .subject");
          const aside = document.querySelector("aside");
          const head = document.querySelector(".tablehead");
          const body = document.querySelector(".tablebody");
          const clip = (s) => {
            const t = String(s || "");
            return t.length > 1200 ? t.slice(0, 1200) : t;
          };

          return {
            termLinkCount: links ? links.length : 0,
            subjectCount: subjects ? subjects.length : 0,
            asideHtmlHead: clip(aside ? aside.innerHTML : ""),
            tableheadHtmlHead: clip(head ? head.innerHTML : ""),
            tablebodyHtmlHead: clip(body ? body.innerHTML : "")
          };
        })
        .catch(() => null);

      const html = await page.content();
      return { url: page.url(), text: html, debug };
    } finally {
      await context.close().catch(() => {});
      await browser.close().catch(() => {});
    }
  });

  return { url: rendered.url, text: rendered.text, via: "playwright", debug: rendered.debug || null };
}

async function loadTeamMembersByPortalLoginId(portalLoginId) {
  const loginId = String(portalLoginId || "").trim();
  if (!loginId) return [];

  const supabase = getSupabaseClientIfAvailable();
  if (!supabase) {
    return readMembersFromJsonFile();
  }

  const { data: user, error: userError } = await supabase
    .rpc("get_or_create_portal_user", { p_portal_login_id: loginId });
  if (userError || !user || !user.id) {
    throw new Error(userError && userError.message ? userError.message : "portal user 조회 실패");
  }

  const { data: rows, error: rowsError } = await supabase
    .from("team_members")
    .select("name, student_id")
    .eq("user_id", user.id)
    .order("created_at", { ascending: true });

  if (rowsError) {
    throw new Error(rowsError.message || "team_members 조회 실패");
  }

  return (rows || []).map((r) => ({
    name: r && r.name != null ? String(r.name) : "",
    studentId: r && r.student_id != null ? String(r.student_id) : ""
  }));
}

async function addOrUpdateTeamMemberByPortalLoginId({ portalLoginId, name, studentId }) {
  const loginId = String(portalLoginId || "").trim();
  const safeName = String(name || "").trim();
  const safeStudentId = String(studentId || "").trim();
  if (!loginId) throw new Error("portalLoginId가 필요합니다.");
  if (!safeName) throw new Error("name이 필요합니다.");
  if (!safeStudentId) throw new Error("studentId가 필요합니다.");

  const supabase = getSupabaseClientIfAvailable();
  if (!supabase) {
    const members = readMembersFromJsonFile();
    const next = Array.isArray(members) ? members.slice() : [];
    const idx = next.findIndex((m) => String(m && m.studentId || "").trim() === safeStudentId);
    const item = { name: safeName, studentId: safeStudentId };
    if (idx >= 0) next[idx] = item;
    else next.push(item);
    writeMembersToJsonFile(next);
    return item;
  }

  const { data: member, error } = await supabase.rpc("add_team_member", {
    p_portal_login_id: loginId,
    p_name: safeName,
    p_student_id: safeStudentId
  });
  if (error || !member) {
    throw new Error(error && error.message ? error.message : "team member 저장 실패");
  }

  return {
    name: member && member.name != null ? String(member.name) : safeName,
    studentId: member && member.student_id != null ? String(member.student_id) : safeStudentId
  };
}

async function deleteTeamMemberByPortalLoginId({ portalLoginId, studentId }) {
  const loginId = String(portalLoginId || "").trim();
  const safeStudentId = String(studentId || "").trim();
  if (!loginId) throw new Error("portalLoginId가 필요합니다.");
  if (!safeStudentId) throw new Error("studentId가 필요합니다.");

  const supabase = getSupabaseClientIfAvailable();
  if (!supabase) {
    const members = readMembersFromJsonFile();
    const next = (Array.isArray(members) ? members : []).filter(
      (m) => String(m && m.studentId || "").trim() !== safeStudentId
    );
    writeMembersToJsonFile(next);
    return { deleted: true };
  }

  const { data: user, error: userError } = await supabase
    .rpc("get_or_create_portal_user", { p_portal_login_id: loginId });
  if (userError || !user || !user.id) {
    throw new Error(userError && userError.message ? userError.message : "portal user 조회 실패");
  }

  const { error: delError } = await supabase
    .from("team_members")
    .delete()
    .eq("user_id", user.id)
    .eq("student_id", safeStudentId);

  if (delError) {
    throw new Error(delError.message || "team member 삭제 실패");
  }

  return { deleted: true };
}

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

async function tryExtractUserNameFromPage(page) {
  if (!page) return null;
  try {
    const texts = await page
      .evaluate(() => {
        return Array.from(document.querySelectorAll('.btn-login'))
          .map((el) => String(el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim())
          .filter((t) => t);
      })
      .catch(() => []);
    for (const t of texts) {
      const m = String(t || '').replace(/\s+/g, ' ').trim().match(/^(\S+)\s*님\b/);
      if (m && m[1] && m[1] !== '로그인') {
        return m[1];
      }
    }
    return null;
  } catch (e) {
    return null;
  }
}

ensureDir(PUBLIC_DIR);
ensureDir(LIVE_DIR);
ensureDir(RUNTIME_DIR);

let session = null;
let jobState = null;
let playwrightLock = Promise.resolve();

const DEFAULT_VIEWPORT = { width: 980, height: 720 };

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

function computeProgressFromLive(live) {
  if (!live) return null;
  const step = live.currentStep ? String(live.currentStep) : "";

  const norm = step.replace(/\s+/g, " ").trim();
  const isLogin = norm.includes("로그인");
  const isEnterTeam = norm.includes("팀플룸") && norm.includes("진입");
  const isList = norm.includes("리스트") && norm.includes("수집");
  const isDetail = norm.includes("상세") && norm.includes("수집");
  const isDone = norm === "완료" || norm.includes("완료");

  if (isDone) return 100;
  if (isDetail) {
    const rooms = Array.isArray(live.rooms) ? live.rooms : [];
    const total = rooms.length;
    if (!total) return 70;
    const done = rooms.filter((r) => r && r.detail).length;
    const ratio = Math.max(0, Math.min(1, done / total));
    return Math.round(70 + ratio * 28);
  }
  if (isList) return 45;
  if (isEnterTeam) return 25;
  if (isLogin) return 5;

  // Fallback: when status indicates done.
  if (String(live.status || "") === "done") return 100;
  return null;
}

function getWorkerState() {
  if (!jobState) {
    return makeIdleState();
  }
  const live = safeReadJson(LIVE_JSON_PATH);
  const data = live || jobState.data || null;
  const computedProgress = jobState && jobState.isRunning ? computeProgressFromLive(data) : null;
  const computedStep = jobState && jobState.isRunning && data && data.currentStep ? String(data.currentStep) : null;

  return {
    ...jobState,
    progress: computedProgress != null ? computedProgress : jobState.progress,
    step: computedStep != null ? computedStep : jobState.step,
    data,
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
  jobState.logs.push({ ts: new Date().toISOString(), line: text });
  if (jobState.logs.length > 200) {
    jobState.logs = jobState.logs.slice(-200);
  }

  // Also print to stdout so you can see what the worker is waiting on in the terminal.
  try {
    console.log(text);
  } catch (e) {
    // ignore
  }
}

async function getOrCreateSession({ loginId, password, headless }) {
  const startTs = new Date().getTime();
  pushJobLog(`getOrCreateSession start`);
  const normalizedId = String(loginId || "").trim();
  if (!normalizedId || !password) {
    throw new Error("아이디와 비밀번호가 필요합니다.");
  }

  const desiredHeadless = typeof headless === "boolean"
    ? headless
    : (process.env.BOOK_HEADLESS ? process.env.BOOK_HEADLESS === "true" : true);

  if (session && session.loginId === normalizedId) {
    const pageClosed = await session.page?.isClosed?.().catch?.(() => true);
    if (pageClosed || !session.page || !session.context || !session.browser) {
      pushJobLog("getOrCreateSession: existing session has closed page/context/browser -> recreate");
      await closeSession().catch(() => {});
      session = null;
    }
  }

  if (session && session.loginId === normalizedId) {
    if (typeof session.headless === true) {
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
  const context = await browser.newContext({
    viewport: desiredHeadless ? { width: 1440, height: 1200 } : DEFAULT_VIEWPORT
  });
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

function bookWaitStamp() {
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  const ms = String(d.getMilliseconds()).padStart(3, "0");
  return `${hh}:${mi}:${ss}.${ms}`;
}

async function bookingLoginSnapshot(page) {
  const url = String(page.url() || "");
  const pwCount = await page.locator('input[type="password"]').count().catch(() => 0);
  const loginMarkerCount = await page
    .locator('text=중앙대학교 통합 LOGIN')
    .count()
    .catch(() => 0);
  const headerText = await page
    .locator('.btn-login')
    .first()
    .innerText()
    .then((t) => String(t || "").replace(/\s+/g, " ").trim())
    .catch(() => "");
  return `url=${url} pwInputs=${pwCount} loginMarker=${loginMarkerCount} btn-login=${JSON.stringify(headerText)}`;
}

async function bookWaitTrace(label, fn, { timeoutMs, intervalMs, snapshot } = {}) {
  const startedAt = Date.now();
  const timeout = Number(timeoutMs) || 0;
  const interval = Number(intervalMs) || 500;
  let tick = 0;
  let timer = null;

  pushBookingLog(`[wait] ${bookWaitStamp()} START ${label}`);

  timer = setInterval(async () => {
    tick += 1;
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
    pushBookingLog(`[wait] ${bookWaitStamp()} ... ${label} tick=${tick} elapsed=${elapsed}ms${snapText}`);
  }, interval);

  try {
    if (!timeout) {
      const result = await fn();
      pushBookingLog(`[wait] ${bookWaitStamp()} END ${label} (${Date.now() - startedAt}ms)`);
      return result;
    }

    const result = await Promise.race([
      fn(),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`timeout ${timeout}ms`)), timeout))
    ]);
    pushBookingLog(`[wait] ${bookWaitStamp()} END ${label} (${Date.now() - startedAt}ms)`);
    return result;
  } catch (err) {
    let snapText = "";
    if (typeof snapshot === "function") {
      try {
        const snap = await snapshot();
        snapText = snap ? ` | ${snap}` : "";
      } catch (e) {
        snapText = ` | snapshot-error=${String(e && e.message ? e.message : e)}`;
      }
    }
    pushBookingLog(`[wait] ${bookWaitStamp()} FAIL ${label} (${Date.now() - startedAt}ms) error=${String(err && err.message ? err.message : err)}${snapText}`);
    throw err;
  } finally {
    if (timer) clearInterval(timer);
  }
}

async function detectLoggedInForBooking(page) {
  const currentUrl = String(page.url() || "");
  if (currentUrl && currentUrl.includes("/login")) {
    return false;
  }

  const headerText = await page
    .locator('.btn-login')
    .first()
    .innerText()
    .then((t) => String(t || "").replace(/\s+/g, " ").trim())
    .catch(() => "");
  if (headerText && /\S+\s+님$/.test(headerText)) {
    return true;
  }

  const hasPassword = await page
    .locator('input[type="password"]')
    .count()
    .then((n) => n > 0)
    .catch(() => false);
  if (hasPassword) {
    return false;
  }

  const hasLoginMarker = await page
    .locator('text=중앙대학교 통합 LOGIN')
    .count()
    .then((n) => n > 0)
    .catch(() => false);
  if (hasLoginMarker) {
    return false;
  }

  return Boolean(currentUrl);
}

async function doLoginForBooking(page, loginId, password) {
  const BASE_URL = "https://library.cau.ac.kr";
  const LOGIN_URL = `${BASE_URL}/login?returnUrl=%2F&queryParamsHandling=merge`;

  await bookWaitTrace(
    "doLoginForBooking: goto LOGIN_URL domcontentloaded",
    async () => {
      await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" });
      await page.waitForLoadState("domcontentloaded").catch(() => {});
    },
    { timeoutMs: 25000, snapshot: () => bookingLoginSnapshot(page) }
  );

  const already = await bookWaitTrace(
    "doLoginForBooking: detectLoggedIn(pre)",
    async () => {
      return await detectLoggedInForBooking(page);
    },
    { timeoutMs: 5000, snapshot: () => bookingLoginSnapshot(page) }
  );
  if (already) {
    pushBookingLog(`doLoginForBooking: already logged in, skip url=${page.url()}`);
    return;
  }

  // Wait for login form to be interactable (avoid fixed sleeps)
  const inputs = page.locator("input");
  await bookWaitTrace(
    "doLoginForBooking: wait input visible",
    async () => {
      await inputs.first().waitFor({ state: "visible", timeout: 15000 });
    },
    { timeoutMs: 16000, snapshot: () => bookingLoginSnapshot(page) }
  );

  await bookWaitTrace(
    "doLoginForBooking: wait visible inputs>=2",
    async () => {
      await page
        .waitForFunction(() => {
          const els = Array.from(document.querySelectorAll("input"));
          const visible = els.filter((el) => {
            const style = window.getComputedStyle(el);
            const rect = el.getBoundingClientRect();
            return style && style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
          });
          return visible.length >= 2;
        }, {
          timeout: 15000
        })
        .catch(() => {});
    },
    { timeoutMs: 16000, snapshot: () => bookingLoginSnapshot(page) }
  );

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

  const loginBtn = page.locator('button:has-text("로그인")').first();
  if (!(await loginBtn.count().catch(() => 0))) {
    throw new Error("로그인 버튼을 찾지 못했습니다.");
  }

  await bookWaitTrace(
    "doLoginForBooking: click login -> navigation",
    async () => {
      await Promise.allSettled([
        page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => {}),
        loginBtn.click({ timeout: 15000 }).catch(() => {})
      ]);
    },
    { timeoutMs: 21000, snapshot: () => bookingLoginSnapshot(page) }
  );

  // Wait until we leave /login (do not swallow errors; outer bookWaitTrace owns the timeout)
  await bookWaitTrace(
    "doLoginForBooking: wait leave /login",
    async () => {
      await page.waitForURL(
        (url) => {
          const u = String(url || "");
          return u.startsWith(BASE_URL) && !u.includes("/login");
        },
        { timeout: 20000 }
      );
    },
    { timeoutMs: 21000, snapshot: () => bookingLoginSnapshot(page) }
  );

  // Then wait until our fast logged-in detector becomes true.
  await bookWaitTrace(
    "doLoginForBooking: wait detectLoggedIn(post)",
    async () => {
      const startedAt = Date.now();
      const timeoutMs = 8000;
      while (Date.now() - startedAt < timeoutMs) {
        if (await detectLoggedInForBooking(page)) return;
        await sleep(200);
      }
      throw new Error("detectLoggedInForBooking(post) timeout");
    },
    { timeoutMs: 9000, snapshot: () => bookingLoginSnapshot(page) }
  );

  pushBookingLog(`doLoginForBooking: login ok url=${page.url()}`);
}

async function selectDateOnListPage(page, dateValue) {
  pushBookingLog(`selectDateOnListPage start dateValue=${String(dateValue || "")}`);
  if (!dateValue) {
    pushBookingLog("selectDateOnListPage skip (no dateValue)");
    return;
  }

  await page.waitForSelector("select#reservableDate", { timeout: 20000 });
  pushBookingLog(`selectDateOnListPage reservableDate visible url=${page.url()}`);

  const wanted = String(dateValue);
  const options = await page
    .evaluate(() => {
      const el = document.querySelector("#reservableDate");
      if (!el) return [];
      return Array.from(el.querySelectorAll("option")).map((o) => ({
        value: String(o.value || ""),
        text: String(o.textContent || "").trim()
      }));
    })
    .catch(() => []);

  pushBookingLog(`selectDateOnListPage options=${JSON.stringify(options.slice(0, 40))}`);

  let picked = options.find((o) => o.value === wanted) || null;
  if (!picked) {
    picked = options.find((o) => o.value && o.value.includes(wanted)) || null;
  }
  if (!picked) {
    // Fallback: match by text containing MM/DD (e.g. "3월 22일")
    const parts = wanted.split("-");
    const mm = parts.length >= 2 ? String(Number(parts[1])) : "";
    const dd = parts.length >= 3 ? String(Number(parts[2])) : "";
    const token = mm && dd ? `${mm}월 ${dd}일` : "";
    if (token) {
      picked = options.find((o) => o.text && o.text.includes(token)) || null;
    }
  }

  if (!picked || !picked.value) {
    throw new Error(`예약 날짜 선택 실패: wanted=${wanted} options=${JSON.stringify(options.slice(0, 80))}`);
  }

  pushBookingLog(`selectDateOnListPage pick value=${picked.value} text=${picked.text}`);

  await page.selectOption("#reservableDate", { value: picked.value }).catch(async () => {
    await page.evaluate((value) => {
      const dateSelect = document.querySelector("#reservableDate");
      if (!dateSelect) return;
      dateSelect.value = value;
      dateSelect.dispatchEvent(new Event("input", { bubbles: true }));
      dateSelect.dispatchEvent(new Event("change", { bubbles: true }));
    }, picked.value);
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
  const headless = process.env.BOOK_BOOK_HEADLESS ? process.env.BOOK_BOOK_HEADLESS === "true" : true;
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
    const timeout = Number(timeoutMs) || 15000;
    const startedAt = Date.now();
    const deadline = startedAt + timeout;
    let lastLogAt = 0;

    const hasWanted = async () => {
      return await page
        .evaluate(
          ({ sel, wantedValue }) => {
            const el = document.querySelector(sel);
            if (!el) return { ok: false, reason: "no-select", optionCount: 0 };
            const opts = Array.from(el.querySelectorAll("option"));
            const ok = opts.some(
              (o) => String(o.value) === wantedValue || String(o.textContent || "").trim() === wantedValue
            );
            return { ok, reason: ok ? "found" : "not-found", optionCount: opts.length, currentValue: String(el.value || "") };
          },
          { sel: selector, wantedValue: wanted }
        )
        .catch((e) => ({ ok: false, reason: `evaluate-error:${e && e.message ? e.message : String(e)}`, optionCount: 0 }));
    };

    while (Date.now() < deadline) {
      const r = await hasWanted();
      if (r && r.ok) return;

      const now = Date.now();
      if (!lastLogAt || now - lastLogAt >= 1500) {
        lastLogAt = now;
        pushBookingLog(
          `waitSelectHasValue polling selector=${selector} wanted=${wanted} reason=${r && r.reason ? r.reason : "?"} optionCount=${r && r.optionCount != null ? r.optionCount : "?"} currentValue=${r && r.currentValue != null ? r.currentValue : ""} elapsedMs=${now - startedAt}`
        );
      }

      await sleep(150);
    }

    const finalDump = await page
      .evaluate(
        ({ sel }) => {
          const el = document.querySelector(sel);
          if (!el) return { found: false, value: null, options: [] };
          const opts = Array.from(el.querySelectorAll("option")).map((o) => ({
            value: String(o.value || ""),
            text: String(o.textContent || "").trim()
          }));
          return { found: true, value: String(el.value || ""), options: opts.slice(0, 80) };
        },
        { sel: selector }
      )
      .catch(() => ({ found: false, value: null, options: [] }));

    pushBookingLog(`waitSelectHasValue TIMEOUT selector=${selector} wanted=${wanted} dump=${JSON.stringify(finalDump)}`);
    throw new Error(`waitSelectHasValue timeout selector=${selector} wanted=${wanted}`);
  }

  async function selectOptionRobust(selector, valueOrLabel) {
    const v = String(valueOrLabel);

    pushBookingLog(`selectOptionRobust start selector=${selector} wanted=${v} url=${page.url()}`);
    await page.waitForSelector(selector, { timeout: 20000 });

    const optionDumpBefore = await page
      .evaluate(
        ({ sel }) => {
          const el = document.querySelector(sel);
          if (!el) return { found: false, options: [] };
          const opts = Array.from(el.querySelectorAll("option")).map((o) => ({
            value: String(o.value || ""),
            text: String(o.textContent || "").trim()
          }));
          return { found: true, options: opts.slice(0, 60) };
        },
        { sel: selector }
      )
      .catch(() => ({ found: false, options: [] }));

    pushBookingLog(`selectOptionRobust options selector=${selector} dump=${JSON.stringify(optionDumpBefore)}`);

    pushBookingLog(`selectOptionRobust waitSelectHasValue selector=${selector} wanted=${v}`);
    await waitSelectHasValue(selector, v, 20000);
    pushBookingLog(`selectOptionRobust waitSelectHasValue done selector=${selector} wanted=${v}`);

    pushBookingLog(`selectOptionRobust selectOption selector=${selector} wanted=${v}`);
    await page.selectOption(selector, { value: v }).catch(async () => {
      await page.selectOption(selector, { label: v });
    });
    pushBookingLog(`selectOptionRobust selectOption done selector=${selector} wanted=${v}`);

    await page
      .evaluate((sel) => {
        const el = document.querySelector(sel);
        if (!el) return;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      }, selector)
      .catch(() => {});

    pushBookingLog(`selectOptionRobust dispatch done selector=${selector} wanted=${v}`);

    const applied = await page
      .evaluate(
        ({ sel, wanted }) => {
          const el = document.querySelector(sel);
          if (!el) return { ok: false, value: null };
          return { ok: String(el.value) === String(wanted), value: String(el.value || "") };
        },
        { sel: selector, wanted: v }
      )
      .catch(() => ({ ok: false, value: null }));

    if (!applied || !applied.ok) {
      const optionDumpAfter = await page
        .evaluate(
          ({ sel }) => {
            const el = document.querySelector(sel);
            if (!el) return { found: false, options: [] };
            const opts = Array.from(el.querySelectorAll("option")).map((o) => ({
              value: String(o.value || ""),
              text: String(o.textContent || "").trim()
            }));
            return { found: true, value: String(el.value || ""), options: opts.slice(0, 60) };
          },
          { sel: selector }
        )
        .catch(() => ({ found: false, options: [] }));

      pushBookingLog(`selectOptionRobust FAILED selector=${selector} wanted=${v} applied=${JSON.stringify(applied)} after=${JSON.stringify(optionDumpAfter)}`);
      throw new Error(`selectOptionRobust 실패: selector=${selector} wanted=${v}`);
    }

    pushBookingLog(`selectOptionRobust done selector=${selector} wanted=${v} url=${page.url()}`);
  }

  async function closeCurtainIfPresent() {
    const closeBtn = page.locator("ik-bulletins-curtain-view button.btn-close").first();
    if (await closeBtn.count().catch(() => 0)) {
      await closeBtn.click({ timeout: 1500 }).catch(() => {});
      await sleep(100);
    }
  }

  async function addCompanionsIfAny() {
    const companions = await loadTeamMembersByPortalLoginId(id).catch(() => []);
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
    pushBookingLog(`companion dialog visible initialChipCount=${chipCount}`);

    for (let i = 0; i < companions.length; i++) {
      const c = companions[i];
      console.log(`[api/book] companion add ${i + 1} / ${companions.length} ${JSON.stringify(c)}`);
      pushBookingLog(`companion fill start i=${i} name=${String(c.name || "")} studentId=${String(c.studentId || "")}`);

      const nameInput = dialog.locator('input[formcontrolname="name"]');
      const idInput = dialog.locator('input[formcontrolname="memberNo"]');
      await nameInput.waitFor({ state: "visible", timeout: 15000 });
      await idInput.waitFor({ state: "visible", timeout: 15000 });

      await nameInput.fill("").catch(() => {});
      await idInput.fill("").catch(() => {});
      await sleep(50);

      await nameInput.fill(String(c.name || "").trim());
      await idInput.fill(String(c.studentId || "").trim());

      // Angular form controls sometimes need explicit events/blur to enable buttons.
      await nameInput.dispatchEvent("input").catch(() => {});
      await idInput.dispatchEvent("input").catch(() => {});
      await nameInput.dispatchEvent("change").catch(() => {});
      await idInput.dispatchEvent("change").catch(() => {});
      await idInput.press("Tab").catch(() => {});
      await sleep(80);
      pushBookingLog(`companion filled i=${i}`);

      const addBtn = dialog.locator('button:has-text("추가")').first();

      pushBookingLog(`companion wait addBtn enabled i=${i}`);
      const enableStartedAt = Date.now();
      const enableDeadline = enableStartedAt + 15000;
      let lastEnableLogAt = 0;
      while (Date.now() < enableDeadline) {
        const enabled = await addBtn.isEnabled().catch(() => false);
        if (enabled) break;
        const now = Date.now();
        if (!lastEnableLogAt || now - lastEnableLogAt >= 1200) {
          lastEnableLogAt = now;
          const values = await dialog
            .evaluate((el) => {
              const nameEl = el.querySelector('input[formcontrolname="name"]');
              const idEl = el.querySelector('input[formcontrolname="memberNo"]');
              return {
                name: nameEl ? String(nameEl.value || "") : null,
                memberNo: idEl ? String(idEl.value || "") : null
              };
            })
            .catch(() => ({}));
          pushBookingLog(
            `companion addBtn still disabled i=${i} elapsedMs=${now - enableStartedAt} values=${JSON.stringify(values)}`
          );
        }
        await sleep(150);
      }

      const enabledFinal = await addBtn.isEnabled().catch(() => false);
      if (!enabledFinal) {
        const dump = await dialog
          .evaluate((el) => String(el.innerText || "").slice(0, 800))
          .catch(() => "");
        pushBookingLog(`companion addBtn enable TIMEOUT i=${i} dialogText=${JSON.stringify(dump)}`);
        throw new Error(`동반이용자 추가 버튼 활성화 실패 i=${i}`);
      }

      await addBtn.scrollIntoViewIfNeeded().catch(() => {});

      const before = await chipList.count().catch(() => chipCount);
      pushBookingLog(`companion click add i=${i} chipBefore=${before}`);
      await addBtn.click({ timeout: 8000 }).catch(async (e) => {
        pushBookingLog(`companion addBtn click failed i=${i} err=${e && e.message ? e.message : String(e)} -> retry`);
        await sleep(200);
        await addBtn.scrollIntoViewIfNeeded().catch(() => {});
        await addBtn.click({ timeout: 8000, force: true });
      });

      await sleep(150);
      const after = await chipList.count().catch(() => before);
      pushBookingLog(`companion after click i=${i} chipAfter=${after}`);

      if (after <= before) {
        const dump = await dialog
          .evaluate((el) => String(el.innerText || "").slice(0, 800))
          .catch(() => "");
        pushBookingLog(`companion chip not increased i=${i} before=${before} after=${after} dialogText=${JSON.stringify(dump)}`);
        throw new Error(`동반이용자 추가 실패(칩 증가 없음) i=${i}`);
      }

      chipCount = after;
      pushBookingLog(`companion added i=${i} chipCount=${chipCount}`);
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
    pushBookingLog(`detail form: closeCurtainIfPresent url=${page.url()}`);
    await closeCurtainIfPresent();
    pushBookingLog(`detail form: curtain checked(before selects) url=${page.url()}`);
    if (dateValue) {
      pushBookingLog(`detail form: select hopeDate=${String(dateValue)} url=${page.url()}`);
      const currentHope = await page
        .evaluate(() => {
          const el = document.querySelector("#hopeDate");
          return el ? String(el.value || "") : "";
        })
        .catch(() => "");

      if (String(currentHope) === String(dateValue)) {
        pushBookingLog(`detail form: hopeDate already set (${currentHope}) -> skip`);
      } else {
        await selectOptionRobust("#hopeDate", String(dateValue));
      }
      await sleep(120);
      pushBookingLog(`detail form: hopeDate selected url=${page.url()}`);
    }

    pushBookingLog(`detail form: beginTime=${String(beginTime)} endTime=${String(endTime)} url=${page.url()}`);
    console.log(`[api/book] request ${JSON.stringify({ roomIndex, roomId: normalizedRoomId || null, dateValue, beginTime, endTime })}`);
    await closeCurtainIfPresent();
    pushBookingLog(`detail form: curtain checked url=${page.url()}`);

    pushBookingLog(`detail form: select beginTime=${String(beginTime)} url=${page.url()}`);
    await selectOptionRobust("#beginTime", String(beginTime));
    console.log(`[api/book] beginTime selected ${beginTime}`);
    await sleep(120);
    pushBookingLog(`detail form: beginTime selected url=${page.url()}`);

    pushBookingLog(`detail form: select endTime=${String(endTime)} url=${page.url()}`);
    await waitSelectHasValue("#endTime", String(endTime), 30000).catch((e) => {
      pushBookingLog(`detail form: endTime options not ready: ${e && e.message ? e.message : String(e)}`);
      throw e;
    });
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
      const portalLoginId = String(req.headers["x-portal-login-id"] || "").trim();
      if (!portalLoginId) {
        sendJson(res, 400, {
          ok: false,
          message: "x-portal-login-id 헤더가 필요합니다."
        });
        return;
      }

      const members = await loadTeamMembersByPortalLoginId(portalLoginId);

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

  if (method === "POST" && pathname === "/api/everytime/map-term") {
    try {
      const portalLoginId = String(req.headers["x-portal-login-id"] || "").trim();
      if (!portalLoginId) {
        sendJson(res, 400, {
          ok: false,
          message: "x-portal-login-id 헤더가 필요합니다."
        });
        return;
      }

      const supabase = getSupabaseClientIfAvailable();
      if (!supabase) {
        sendJson(res, 400, {
          ok: false,
          message: "Supabase 설정이 필요합니다. (.env의 SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)"
        });
        return;
      }

      const body = await parseBody(req);
      const termLabel = body && body.termLabel != null ? String(body.termLabel) : "";
      const termUrl = body && body.termUrl != null ? normalizeEverytimeUrl(body.termUrl) : "";
      const courses = body && Array.isArray(body.courses) ? body.courses : [];

      if (!termLabel.trim()) {
        sendJson(res, 400, { ok: false, message: "termLabel이 필요합니다." });
        return;
      }
      if (!courses.length) {
        sendJson(res, 400, { ok: false, message: "courses가 비어있습니다. preview-term 결과(courses)를 그대로 전달하세요." });
        return;
      }

      const parsedTerm = parseAcademicTermLabel(termLabel);
      const year = parsedTerm.year;
      const termType = parsedTerm.term_type || "unknown";
      const campus = null;
      if (!Number.isFinite(year) || !year) {
        sendJson(res, 400, { ok: false, message: `termLabel에서 year를 추출할 수 없습니다: ${termLabel}` });
        return;
      }

      // 1) academic_terms: treat campus NULL/'' as same key (unique idx uses coalesce)
      const { data: existingTerms, error: existingErr } = await supabase
        .from("academic_terms")
        .select("id, year, term_type, term_label, campus")
        .eq("year", year)
        .eq("term_type", termType)
        .or("campus.is.null,campus.eq.")
        .limit(1);
      if (existingErr) {
        throw new Error(existingErr.message || "academic_terms 조회 실패");
      }

      let termRow = existingTerms && existingTerms[0] ? existingTerms[0] : null;

      if (!termRow) {
        const { data: inserted, error: insertErr } = await supabase
          .from("academic_terms")
          .insert({
            year,
            term_type: termType,
            term_label: String(parsedTerm.term_label || termLabel).trim(),
            campus
          })
          .select("id, year, term_type, term_label, campus")
          .single();

        if (insertErr || !inserted || !inserted.id) {
          throw new Error(insertErr && insertErr.message ? insertErr.message : "academic_terms insert 실패");
        }

        termRow = inserted;
      }

      // 2) course_catalog(+meetings) load for this term
      const { data: catalogRows, error: catalogErr } = await supabase
        .from("course_catalog")
        .select(
          "id, course_code, section, course_name, professor_name, professor_name_normalized, course_name_normalized, building, room, course_catalog_meetings(day_of_week,start_minute,end_minute)"
        )
        .eq("term_id", termRow.id);

      if (catalogErr) {
        throw new Error(catalogErr.message || "course_catalog 조회 실패");
      }

      const catalog = Array.isArray(catalogRows) ? catalogRows : [];

      // 3) match
      const mappedCourses = [];
      const mappingInserts = [];

      for (const c of courses) {
        const srcName = c && c.course_name != null ? String(c.course_name) : "";
        const srcProf = c && c.instructor_name != null ? String(c.instructor_name) : "";
        const srcLoc = c && c.location_text != null ? String(c.location_text) : "";
        const srcMeetings = c && Array.isArray(c.meetings) ? c.meetings : [];

        const normName = normalizeTextLoose(srcName);
        const normProf = normalizeTextLoose(srcProf);

        let best = null;
        for (const row of catalog) {
          const catNameRaw = row && row.course_name != null ? String(row.course_name) : "";
          const catProfRaw = row && row.professor_name != null ? String(row.professor_name) : "";

          const catName = normalizeTextLoose(row && row.course_name_normalized ? row.course_name_normalized : catNameRaw);
          const catProf = normalizeTextLoose(row && row.professor_name_normalized ? row.professor_name_normalized : catProfRaw);

          let nameScore = 0;
          if (normName && catName && normName === catName) nameScore = 1;
          else if (normName && catName && (catName.includes(normName) || normName.includes(catName))) nameScore = 0.65;

          let profScore = 0;
          if (normProf && catProf && normProf === catProf) profScore = 1;
          else if (normProf && catProf && (catProf.includes(normProf) || normProf.includes(catProf))) profScore = 0.6;

          const catMeetings = row && Array.isArray(row.course_catalog_meetings) ? row.course_catalog_meetings : [];
          const overlap = bestMeetingOverlapScore(srcMeetings, catMeetings);

          const score = nameScore * 0.6 + profScore * 0.2 + overlap * 0.2;
          if (!best || score > best.score) {
            best = {
              score,
              row,
              nameScore,
              profScore,
              overlap
            };
          }
        }

        const matched = Boolean(best && best.row && best.score >= 0.62);
        const matchedId = matched ? best.row.id : null;

        mappedCourses.push({
          course_name: srcName,
          instructor_name: srcProf || null,
          location_text: srcLoc || null,
          meetings: srcMeetings,
          mapped: matched,
          match_score: best ? best.score : 0,
          matched_course_catalog_id: matchedId,
          matched_course_name: matched ? String(best.row.course_name || "") : null,
          matched_professor_name: matched ? (best.row.professor_name != null ? String(best.row.professor_name) : null) : null,
          matched_building: matched ? (best.row.building != null ? String(best.row.building) : null) : null,
          matched_room: matched ? (best.row.room != null ? String(best.row.room) : null) : null,
          matched_meetings: matched && Array.isArray(best.row.course_catalog_meetings) ? best.row.course_catalog_meetings : []
        });

        mappingInserts.push({
          term_id: termRow.id,
          course_catalog_id: matchedId,
          source: "everytime",
          source_course_code: null,
          source_section: null,
          source_course_name: srcName || null,
          source_professor_name: srcProf || null,
          source_days: srcMeetings && srcMeetings.length ? JSON.stringify(srcMeetings.map((m) => m.day_of_week)) : null,
          source_building: null,
          source_room: null,
          match_score: best ? best.score : null
        });
      }

      // 4) persist mapping batch
      try {
        await supabase.from("everytime_course_mapping").delete().eq("term_id", termRow.id).eq("source", "everytime");
      } catch (e) {
        // ignore
      }

      const { error: mapInsertErr } = await supabase.from("everytime_course_mapping").insert(mappingInserts);
      if (mapInsertErr) {
        throw new Error(mapInsertErr.message || "everytime_course_mapping insert 실패");
      }

      sendJson(res, 200, {
        ok: true,
        term: termRow,
        sourceTermUrl: termUrl || null,
        mappedCourses
      });
      return;
    } catch (err) {
      const message = err && err.message ? String(err.message) : String(err);
      const statusCode = message === "JSON 파싱 실패" ? 400 : 500;
      sendJson(res, statusCode, {
        ok: false,
        message
      });
      return;
    }
  }

  if (method === "POST" && pathname === "/api/everytime/preview-term") {
    try {
      const portalLoginId = String(req.headers["x-portal-login-id"] || "").trim();
      if (!portalLoginId) {
        sendJson(res, 400, {
          ok: false,
          message: "x-portal-login-id 헤더가 필요합니다."
        });
        return;
      }

      const body = await parseBody(req);
      const termUrl = normalizeEverytimeUrl(body && body.termUrl != null ? body.termUrl : "");
      const pxPerHour = body && body.pxPerHour != null ? Number(body.pxPerHour) : undefined;
      if (!termUrl) {
        sendJson(res, 400, { ok: false, message: "termUrl이 필요합니다." });
        return;
      }

      const fetched = await fetchEverytimeHtmlWithFallback(termUrl);
      const parsedMeta = parseEverytimeProfileAndTerms(fetched.text, fetched.url);
      const timetableParsed = parseEverytimeTimetableFromHtml(fetched.text, { pxPerHour });

      // Try to infer label from aside (term detail pages usually have only one active term)
      const termLabel = (parsedMeta.terms.find((t) => t && t.isCurrent) || parsedMeta.terms[0] || {}).label;

      sendJson(res, 200, {
        ok: true,
        finalUrl: fetched.url,
        fetchedVia: fetched.via,
        fetchedDebug: fetched.debug || null,
        profileName: parsedMeta.profileName,
        termLabel: String(termLabel || "").trim() || null,
        courses: timetableParsed && Array.isArray(timetableParsed.courses) ? timetableParsed.courses : [],
        meetingCount: timetableParsed && timetableParsed.meetingCount != null ? timetableParsed.meetingCount : 0,
        timetableDebug: timetableParsed && timetableParsed.debug ? timetableParsed.debug : null
      });
      return;
    } catch (err) {
      const message = err && err.message ? String(err.message) : String(err);
      const statusCode = message === "JSON 파싱 실패" ? 400 : 500;
      sendJson(res, statusCode, {
        ok: false,
        message
      });
      return;
    }
  }

  if (method === "POST" && pathname === "/api/everytime/parse") {
    try {
      const portalLoginId = String(req.headers["x-portal-login-id"] || "").trim();
      if (!portalLoginId) {
        sendJson(res, 400, {
          ok: false,
          message: "x-portal-login-id 헤더가 필요합니다."
        });
        return;
      }

      const body = await parseBody(req);
      const inputUrl = body && body.url != null ? body.url : "";
      const targetUrl = normalizeEverytimeUrl(inputUrl);
      if (!targetUrl) {
        sendJson(res, 400, {
          ok: false,
          message: "everytime.kr 링크를 입력해주세요."
        });
        return;
      }

      const fetched = await fetchEverytimeHtmlWithFallback(targetUrl);
      const parsed = parseEverytimeProfileAndTerms(fetched.text, fetched.url);

      sendJson(res, 200, {
        ok: true,
        inputUrl: targetUrl,
        finalUrl: fetched.url,
        fetchedVia: fetched.via,
        fetchedDebug: fetched.debug || null,
        profileName: parsed.profileName,
        sourceProfileToken: extractEverytimeTokenFromUrl(targetUrl) || null,
        terms: parsed.terms,
        isTermDetail: parsed.isTermDetail
      });
      return;
    } catch (err) {
      sendJson(res, 500, {
        ok: false,
        message: "에타 링크 파싱 실패",
        error: err && err.message ? err.message : String(err)
      });
      return;
    }
  }

  if (method === "POST" && pathname === "/api/everytime/sync-term") {
    try {
      const portalLoginId = String(req.headers["x-portal-login-id"] || "").trim();
      if (!portalLoginId) {
        sendJson(res, 400, {
          ok: false,
          message: "x-portal-login-id 헤더가 필요합니다."
        });
        return;
      }

      const supabase = getSupabaseClientIfAvailable();
      if (!supabase) {
        sendJson(res, 400, {
          ok: false,
          message: "Supabase 설정이 필요합니다. (.env의 SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)"
        });
        return;
      }

      const body = await parseBody(req);
      const termUrl = normalizeEverytimeUrl(body && body.termUrl != null ? body.termUrl : "");
      const profileUrl = normalizeEverytimeUrl(body && body.profileUrl != null ? body.profileUrl : "");
      const pxPerHour = body && body.pxPerHour != null ? Number(body.pxPerHour) : undefined;
      if (!termUrl) {
        sendJson(res, 400, { ok: false, message: "termUrl이 필요합니다." });
        return;
      }

      const { data: user, error: userError } = await supabase
        .rpc("get_or_create_portal_user", { p_portal_login_id: portalLoginId });
      if (userError || !user || !user.id) {
        throw new Error(userError && userError.message ? userError.message : "portal user 조회 실패");
      }

      const fetched = await fetchEverytimeHtmlWithFallback(termUrl);
      const parsed = parseEverytimeProfileAndTerms(fetched.text, fetched.url);
      const profileName = parsed.profileName || null;
      const sourceProfileToken = extractEverytimeTokenFromUrl(profileUrl) || extractEverytimeTokenFromUrl(termUrl) || null;

      const { data: profileRow, error: profileError } = await supabase
        .from("timetable_profiles")
        .upsert(
          {
            user_id: user.id,
            source: "everytime",
            source_profile_token: sourceProfileToken,
            profile_name: profileName,
            source_profile_url: profileUrl || null
          },
          { onConflict: "user_id,source" }
        )
        .select("id")
        .single();

      if (profileError || !profileRow || !profileRow.id) {
        throw new Error(profileError && profileError.message ? profileError.message : "timetable_profiles 저장 실패");
      }

      const termToken = extractEverytimeTokenFromUrl(termUrl) || null;
      const termLabel = (parsed.terms.find((t) => t && t.url === fetched.url) || parsed.terms.find((t) => t && t.isCurrent) || parsed.terms[0] || {})
        .label;
      const safeTermLabel = String(termLabel || "선택 학기").trim();

      await supabase
        .from("timetable_terms")
        .update({ is_current: false })
        .eq("profile_id", profileRow.id)
        .eq("is_current", true);

      const { data: termRow, error: termError } = await supabase
        .from("timetable_terms")
        .upsert(
          {
            profile_id: profileRow.id,
            term_label: safeTermLabel,
            source_term_token: termToken,
            source_term_url: termUrl,
            is_current: true
          },
          { onConflict: "profile_id,term_label" }
        )
        .select("id")
        .single();

      if (termError || !termRow || !termRow.id) {
        throw new Error(termError && termError.message ? termError.message : "timetable_terms 저장 실패");
      }

      // Sync normalized timetable (courses + meetings) if present in HTML.
      const timetableParsed = parseEverytimeTimetableFromHtml(fetched.text, { pxPerHour });
      let syncedCourses = 0;
      let syncedMeetings = 0;
      let timetableSyncError = null;

      try {
        await supabase.from("timetable_courses").delete().eq("term_id", termRow.id);

        const coursesToInsert = (timetableParsed && Array.isArray(timetableParsed.courses) ? timetableParsed.courses : []).map((c) => ({
          term_id: termRow.id,
          course_name: c.course_name,
          instructor_name: c.instructor_name || null,
          location_text: c.location_text || null,
          color_key: c.color_key || null,
          source_course_key: null
        }));

        if (coursesToInsert.length) {
          const { data: insertedCourses, error: courseInsertError } = await supabase
            .from("timetable_courses")
            .insert(coursesToInsert)
            .select("id, course_name, instructor_name, location_text");
          if (courseInsertError) {
            throw new Error(courseInsertError.message || "courses insert 실패");
          }

          syncedCourses = insertedCourses ? insertedCourses.length : 0;

          const idMap = new Map();
          for (const row of insertedCourses || []) {
            const key = `${row.course_name}||${row.instructor_name || ""}||${row.location_text || ""}`;
            if (row && row.id) idMap.set(key, row.id);
          }

          const meetingInserts = [];
          for (const c of timetableParsed.courses || []) {
            const key = `${c.course_name}||${c.instructor_name || ""}||${c.location_text || ""}`;
            const courseId = idMap.get(key);
            if (!courseId) continue;
            for (const m of c.meetings || []) {
              meetingInserts.push({
                course_id: courseId,
                day_of_week: m.day_of_week,
                start_minute: m.start_minute,
                end_minute: m.end_minute
              });
            }
          }

          if (meetingInserts.length) {
            const { error: meetingError } = await supabase.from("timetable_course_meetings").insert(meetingInserts);
            if (meetingError) {
              throw new Error(meetingError.message || "meetings insert 실패");
            }
            syncedMeetings = meetingInserts.length;
          }
        }
      } catch (e) {
        timetableSyncError = e && e.message ? String(e.message) : String(e);
      }

      let rawSaved = false;
      let rawSaveError = null;
      try {
        const { error: rawError } = await supabase.from("timetable_import_raw").insert({
          term_id: termRow.id,
          source: "everytime",
          source_url: fetched.url,
          raw_html: fetched.text
        });
        if (rawError) {
          rawSaveError = rawError.message || "raw 저장 실패";
        } else {
          rawSaved = true;
        }
      } catch (e) {
        rawSaveError = e && e.message ? String(e.message) : String(e);
      }

      sendJson(res, 200, {
        ok: true,
        profileId: profileRow.id,
        termId: termRow.id,
        termLabel: safeTermLabel,
        syncedCourses,
        syncedMeetings,
        timetableSyncError,
        rawSaved,
        rawSaveError
      });
      return;
    } catch (err) {
      const message = err && err.message ? String(err.message) : String(err);
      const statusCode = message === "JSON 파싱 실패" ? 400 : 500;
      sendJson(res, statusCode, {
        ok: false,
        message: message
      });
      return;
    }
  }

  if (method === "POST" && pathname === "/api/team-members") {
    try {
      const portalLoginId = String(req.headers["x-portal-login-id"] || "").trim();
      if (!portalLoginId) {
        sendJson(res, 400, {
          ok: false,
          message: "x-portal-login-id 헤더가 필요합니다."
        });
        return;
      }

      const body = await parseBody(req);
      const name = body && body.name != null ? body.name : "";
      const studentId = body && body.studentId != null ? body.studentId : "";

      await addOrUpdateTeamMemberByPortalLoginId({ portalLoginId, name, studentId });
      const members = await loadTeamMembersByPortalLoginId(portalLoginId);

      sendJson(res, 200, { ok: true, members });
      return;
    } catch (err) {
      const message = err && err.message ? String(err.message) : String(err);
      const statusCode = message === "JSON 파싱 실패" ? 400 : 500;
      sendJson(res, statusCode, {
        ok: false,
        message: message
      });
      return;
    }
  }

  if (method === "DELETE" && pathname === "/api/team-members") {
    try {
      const portalLoginId = String(req.headers["x-portal-login-id"] || "").trim();
      if (!portalLoginId) {
        sendJson(res, 400, {
          ok: false,
          message: "x-portal-login-id 헤더가 필요합니다."
        });
        return;
      }

      const body = await parseBody(req);
      const studentId = body && body.studentId != null ? body.studentId : "";
      await deleteTeamMemberByPortalLoginId({ portalLoginId, studentId });
      const members = await loadTeamMembersByPortalLoginId(portalLoginId);

      sendJson(res, 200, { ok: true, members });
      return;
    } catch (err) {
      const message = err && err.message ? String(err.message) : String(err);
      const statusCode = message === "JSON 파싱 실패" ? 400 : 500;
      sendJson(res, statusCode, {
        ok: false,
        message: message
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

        const bookHeadless = process.env.BOOK_BOOK_HEADLESS ? process.env.BOOK_BOOK_HEADLESS === "true" : true;
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
          const runStartedAt = Date.now();
          pushJobLog("[worker] 세션 준비 중...");

          const scrapeHeadless = process.env.BOOK_HEADLESS ? process.env.BOOK_HEADLESS === "true" : true;

          const sessionStartedAt = Date.now();
          pushJobLog(`[worker] getOrCreateSession start headless=${String(scrapeHeadless)}`);
          const s = await getOrCreateSession({ loginId: id, password, headless: scrapeHeadless });
          pushJobLog(`[worker] getOrCreateSession end (${Date.now() - sessionStartedAt}ms) url=${s && s.page ? s.page.url() : "-"}`);

          const ensureStartedAt = Date.now();
          pushJobLog(`[worker] ensureLoggedIn start url=${s && s.page ? s.page.url() : "-"}`);
          await ensureLoggedIn(s.page, s.loginId, s.password);
          pushJobLog(`[worker] ensureLoggedIn end (${Date.now() - ensureStartedAt}ms) url=${s && s.page ? s.page.url() : "-"}`);
          s.lastActiveAt = new Date().toISOString();

          const extractedUserName = await tryExtractUserNameFromPage(s.page);
          pushJobLog(`[worker] userName extracted=${extractedUserName || "null"}`);

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
            headless: process.env.BOOK_HEADLESS ? process.env.BOOK_HEADLESS === "true" : true,
            credentials: { loginId: s.loginId, password: s.password },
            targetDateValue: dateValue,
            initialUserName: extractedUserName,
            page: s.page,
            keepOpen: true
          });

          jobState.isRunning = false;
          jobState.finishedAt = new Date().toISOString();
          jobState.status = "done";
          jobState.step = "완료";
          jobState.progress = 100;
          jobState.data = result && result.output ? result.output : null;
          pushJobLog(`[worker] run total (${Date.now() - runStartedAt}ms)`);
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
  console.log("" + LIVE_JSON_PATH);
});