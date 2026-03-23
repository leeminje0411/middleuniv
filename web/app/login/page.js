"use client";

import "./login.css";

import { useEffect, useMemo, useRef, useState } from "react";

function todayKstDateValue() {
  try {
    return new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Seoul" });
  } catch (e) {
    return new Date().toISOString().slice(0, 10);
  }
}

export default function LoginPage() {
  const [loginId, setLoginId] = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  const [isRunning, setIsRunning] = useState(false);
  const [statusText, setStatusText] = useState("");
  const [pct, setPct] = useState(0);
  const targetPctRef = useRef(0);
  const rafRef = useRef(null);

  const isMountedRef = useRef(false);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      document.body.classList.remove("logging-in");
    };
  }, []);

  useEffect(() => {
    if (!isRunning) {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      return;
    }

    let cancelled = false;
    const tick = () => {
      if (cancelled) return;

      const target = Math.max(0, Math.min(100, Number(targetPctRef.current) || 0));
      setPct((cur) => {
        const current = Math.max(0, Math.min(100, Number(cur) || 0));
        const diff = target - current;
        if (Math.abs(diff) < 0.2) return target;

        // Smoothly approach target; faster when far, slower when close.
        const next = current + diff * 0.12;
        return Math.max(0, Math.min(100, next));
      });

      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => {
      cancelled = true;
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [isRunning]);

  const canSubmit = useMemo(() => {
    return !isRunning && loginId.trim() && loginPassword;
  }, [isRunning, loginId, loginPassword]);

  function readStoredCreds() {
    try {
      const id = (sessionStorage.getItem("cau_login_id") || localStorage.getItem("cau_login_id") || "").trim();
      const password = sessionStorage.getItem("cau_login_password") || localStorage.getItem("cau_login_password") || "";
      return { id, password };
    } catch (e) {
      return { id: "", password: "" };
    }
  }

  function storeCreds(id, password) {
    try {
      sessionStorage.setItem("cau_login_id", id);
      sessionStorage.setItem("cau_login_password", password);
      localStorage.setItem("cau_login_id", id);
      localStorage.setItem("cau_login_password", password);
    } catch (e) {
      // ignore
    }
  }

  async function runWithPromptedCreds() {
    let { id, password } = readStoredCreds();

    if (!id || !password) {
      id = (prompt("포탈 ID를 입력하세요 (로컬 저장)") || "").trim();
      password = prompt("비밀번호를 입력하세요 (로컬 저장)") || "";
      if (!id || !password) {
        alert("ID/비밀번호가 필요합니다.");
        return;
      }
      storeCreds(id, password);
    }

    setLoginId(id);
    setLoginPassword(password);
    await runAndWaitWithCreds(id, password);
  }

  async function pollUntilLoginStep() {
    const maxMs = 120_000;
    const started = Date.now();

    while (Date.now() - started < maxMs) {
      await new Promise((r) => setTimeout(r, 900));

      const r = await fetch("/api/state", { cache: "no-store" });
      const j = await r.json().catch(() => ({}));

      const step = j && j.step ? String(j.step) : "";
      const running = !!(j && j.isRunning);
      const p = Number(j && j.progress) || 0;

      if (step) {
        setStatusText(step);
      }
      if (Number.isFinite(p)) {
        targetPctRef.current = Math.max(0, Math.min(100, p));
      }

      try {
        console.log("[login] state", {
          isRunning: j && j.isRunning,
          status: j && j.status,
          progress: j && j.progress,
          step: j && j.step
        });
      } catch (e) {
        // ignore
      }

      if (j && (j.status === "error" || j.error)) {
        throw new Error(j.error || "로그인 실패");
      }

      if (!running && j && j.status === "idle") {
        throw new Error("스크래퍼가 중단되었습니다");
      }

      if (j && (j.status === "done" || (j.progress != null && Number(j.progress) >= 100))) {
        return;
      }
    }

    throw new Error("완료 대기 시간 초과");
  }

  async function runAndWaitWithCreds(id, password) {
    const safeId = String(id || "").trim();
    const safePassword = String(password || "");

    if (!safeId || !safePassword) {
      alert("아이디와 비밀번호를 입력해주세요.");
      return;
    }

    setIsRunning(true);
    targetPctRef.current = 0;
    setPct(0);
    setStatusText("핸드쉐이크 진행중");
    document.body.classList.add("logging-in");

    try {
      const resp = await fetch("/api/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: safeId, password: safePassword, dateValue: todayKstDateValue() })
      });

      const j = await resp.json().catch(() => ({}));
      if (!resp.ok || (j && j.ok === false)) {
        throw new Error((j && j.message) || "로그인 요청 실패");
      }

      setStatusText("대시보드로 이동 중...");

      sessionStorage.setItem("cau_login_id", safeId);
      sessionStorage.setItem("cau_login_password", safePassword);
      sessionStorage.setItem("cau_logged_in", "true");

      try {
        console.log("[login] redirect to /dashboard");
      } catch (e) {
        // ignore
      }
      window.location.href = "/dashboard";
    } catch (e) {
      const msg = e && e.message ? String(e.message) : "로그인 실패";
      alert(msg);
    } finally {
      if (isMountedRef.current) {
        setIsRunning(false);
        document.body.classList.remove("logging-in");
      }
    }
  }

  async function runAndWait() {
    await runAndWaitWithCreds(loginId.trim(), loginPassword);
  }

  return (
    <div className="login-page">
      <div className="login-card">
        <div className="logo-wrap">
          <img className="cau-logo" src={isRunning ? "/images/cau-logo.png" : "/images/cau-logo-kind.png"} alt="중앙대학교 로고" />
        </div>

        {isRunning ? (
          <div className="login-loading" aria-live="polite">
            <div className="login-loading-text">{statusText || "로그인 중..."}</div>
            <div className="login-loading-bar" role="progressbar" aria-label="로그인 진행률" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
              <div className="login-loading-bar-fill" style={{ width: `${pct}%` }} />
            </div>
            <div className="login-loading-pct">{pct ? `${Math.round(pct)}%` : ""}</div>
          </div>
        ) : null}

        <form
          className="form-area"
          onSubmit={(e) => {
            e.preventDefault();
            if (canSubmit) {
              runAndWait();
            }
          }}
        >
          <div className="field">
            <label htmlFor="loginId">아이디</label>
            <input id="loginId" type="text" autoComplete="username" placeholder="아이디" value={loginId} onChange={(e) => setLoginId(e.target.value)} disabled={isRunning} />
          </div>

          <div className="field">
            <label htmlFor="loginPassword">비밀번호</label>
            <input id="loginPassword" type="password" autoComplete="current-password" placeholder="비밀번호" value={loginPassword} onChange={(e) => setLoginPassword(e.target.value)} disabled={isRunning} />
          </div>

          <button type="submit" className="login-button" disabled={!canSubmit}>
            <span className="button-text">로그인</span>
          </button>
        </form>

      </div>
    </div>
  );
}

