const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const PROJECT_ROOT = __dirname;
const LIVE_JSON_PATH = path.join(PROJECT_ROOT, "live", "latest_team_today.json");
const SCRAPER_PATH = path.join(PROJECT_ROOT, "cau_team_today_only2.js");

let currentJob = null;

function getTailLines(lines, maxLines) {
  const arr = Array.isArray(lines) ? lines : [];
  if (!arr.length) return [];
  const n = Math.max(0, Number(maxLines) || 0);
  if (!n) return [];
  return arr.slice(-n);
}

function getLastStderrLines(job, maxLines) {
  if (!job || !Array.isArray(job.logs)) return [];
  const stderrLines = job.logs.filter((l) => String(l || "").startsWith("[stderr] "));
  const tail = getTailLines(stderrLines, maxLines);
  return tail.map((l) => String(l).replace(/^\[stderr\]\s*/, "")).filter(Boolean);
}

function safeReadJson(filePath) {
  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }
    const text = fs.readFileSync(filePath, "utf8");
    return JSON.parse(text);
  } catch (err) {
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

function pushLog(job, line) {
  if (!job || !line) return;

  job.logs.push(line);

  if (job.logs.length > 300) {
    job.logs = job.logs.slice(-300);
  }

  updateProgressFromLog(job, line);
}

function updateProgressFromLog(job, line) {
  const text = String(line || "").trim();

  if (!text) return;

  if (text.includes("[1] 로그인 중")) {
    job.step = "로그인 중";
    job.progress = Math.max(job.progress, 10);
    return;
  }

  if (text.includes("[완료] 로그인 성공")) {
    job.step = "로그인 완료";
    job.progress = Math.max(job.progress, 20);
    return;
  }

  if (text.includes("[2] 팀플룸 페이지 진입 중")) {
    job.step = "팀플룸 페이지 진입 중";
    job.progress = Math.max(job.progress, 30);
    return;
  }

  if (text.includes("[완료] 날짜 선택")) {
    job.step = "날짜 선택 완료";
    job.progress = Math.max(job.progress, 40);
    return;
  }

  if (text.includes("[3] 팀플룸 리스트 수집 중")) {
    job.step = "목록 수집 중";
    job.progress = Math.max(job.progress, 50);
    return;
  }

  if (text.includes("[완료] 룸")) {
    job.step = "룸 목록 수집 완료";
    job.progress = Math.max(job.progress, 60);
    return;
  }

  if (text.includes("[4-")) {
    job.step = "상세 페이지 수집 중";
    job.progress = Math.max(job.progress, 75);
    return;
  }

  if (text.includes("FINAL JSON") || text.includes("LIVE JSON")) {
    job.step = "결과 파일 정리 중";
    job.progress = Math.max(job.progress, 95);
    return;
  }

  if (text.includes("완료")) {
    job.step = "완료";
    job.progress = Math.max(job.progress, 100);
  }
}

function getCurrentState() {
  if (!currentJob) {
    return makeIdleState();
  }

  const live = safeReadJson(LIVE_JSON_PATH);

  return {
    isRunning: currentJob.isRunning,
    startedAt: currentJob.startedAt,
    finishedAt: currentJob.finishedAt,
    progress: currentJob.progress,
    step: currentJob.step,
    status: currentJob.status,
    error: currentJob.error,
    pid: currentJob.pid,
    logs: currentJob.logs,
    data: live || currentJob.data || null
  };
}

function markJobFailed(job, step, errorMessage) {
  if (!job) return;

  job.isRunning = false;
  job.finishedAt = new Date().toISOString();
  job.status = "error";
  job.step = step;
  job.error = errorMessage;
}

function runScraper(id, password) {
  return new Promise((resolve, reject) => {
    if (!id || !password) {
      reject(new Error("아이디와 비밀번호가 필요합니다."));
      return;
    }

    if (currentJob && currentJob.isRunning) {
      reject(new Error("이미 스크래퍼가 실행 중입니다."));
      return;
    }

    if (!fs.existsSync(SCRAPER_PATH)) {
      reject(new Error("cau_team_today_only2.js 파일을 찾을 수 없습니다."));
      return;
    }

    currentJob = {
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

    let settled = false;

    const child = spawn("node", [SCRAPER_PATH], {
      cwd: PROJECT_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        CAU_ID: String(id).trim(),
        CAU_PW: String(password)
      }
    });

    currentJob.pid = child.pid;

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      text.split(/\r?\n/).forEach((line) => {
        if (line.trim()) {
          pushLog(currentJob, line);
        }
      });
    });

    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      text.split(/\r?\n/).forEach((line) => {
        if (line.trim()) {
          pushLog(currentJob, "[stderr] " + line);
        }
      });
    });

    child.on("error", (err) => {
      if (settled) {
        return;
      }

      settled = true;
      markJobFailed(currentJob, "실행 실패", err.message);
      reject(err);
    });

    child.on("close", (code) => {
      if (settled) {
        return;
      }

      settled = true;
      currentJob.isRunning = false;
      currentJob.finishedAt = new Date().toISOString();

      const live = safeReadJson(LIVE_JSON_PATH);
      currentJob.data = live;

      if (code === 0) {
        currentJob.status = "done";
        currentJob.step = "완료";
        currentJob.progress = 100;
        resolve(getCurrentState());
        return;
      }

      currentJob.status = "error";
      currentJob.step = "실패";
      const stderrTail = getLastStderrLines(currentJob, 10);
      const logTail = getTailLines(currentJob.logs, 15);
      const parts = [`스크래퍼 종료 코드: ${code}`];
      if (stderrTail.length) {
        parts.push("\n[stderr tail]\n" + stderrTail.join("\n"));
      }
      if (logTail.length) {
        parts.push("\n[log tail]\n" + logTail.join("\n"));
      }
      currentJob.error = parts.join("\n");
      reject(new Error(currentJob.error));
    });
  });
}

module.exports = {
  runScraper,
  getCurrentState
};