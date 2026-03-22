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

  const isMountedRef = useRef(false);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      document.body.classList.remove("logging-in");
    };
  }, []);

  const canSubmit = useMemo(() => {
    return !isRunning && loginId.trim() && loginPassword;
  }, [isRunning, loginId, loginPassword]);

  async function pollUntilLoginStep() {
    const maxMs = 45_000;
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
        setPct(Math.max(0, Math.min(100, p)));
      }

      if (j && (j.status === "error" || j.error)) {
        throw new Error(j.error || "로그인 실패");
      }

      if (!running && j && j.status === "idle") {
        throw new Error("스크래퍼가 중단되었습니다");
      }

      if (step.includes("팀플룸 페이지") || step.includes("팀플룸 리스트")) {
        return;
      }
    }

    throw new Error("로그인 대기 시간 초과");
  }

  async function runAndWait() {
    const id = loginId.trim();
    const password = loginPassword;

    if (!id || !password) {
      alert("아이디와 비밀번호를 입력해주세요.");
      return;
    }

    setIsRunning(true);
    setPct(0);
    setStatusText("핸드쉐이크 진행중");
    document.body.classList.add("logging-in");

    try {
      const resp = await fetch("/api/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, password, dateValue: todayKstDateValue() })
      });

      const j = await resp.json().catch(() => ({}));
      if (!resp.ok || (j && j.ok === false)) {
        throw new Error((j && j.message) || "로그인 요청 실패");
      }

      await pollUntilLoginStep();

      sessionStorage.setItem("cau_login_id", id);
      sessionStorage.setItem("cau_login_password", password);
      sessionStorage.setItem("cau_logged_in", "true");

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

  return (
    <div className="login-page">
      <div className="login-card">
        <div className="logo-wrap">
          <img className={"cau-logo" + (isRunning ? " logging-in" : "")} src={isRunning ? "/images/cau-logo.png" : "/images/cau-logo-kind.png"} alt="중앙대학교 로고" />
        </div>

        <div className="hack-overlay" aria-hidden={!isRunning}>
          <div className="hack-terminal">
            <div className="hack-status">{statusText}</div>
            <div className="hack-progress" role="progressbar" aria-label="로그인 진행률" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
              <div className="hack-progress-bar" style={{ width: `${pct}%` }} />
            </div>
            <div className="hack-progress-text">{pct ? `${Math.round(pct)}%` : ""}</div>
          </div>
        </div>

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
