"use client";

import { useEffect, useMemo, useRef, useState } from "react";

function todayKstDateValue() {
  try {
    return new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Seoul" });
  } catch (e) {
    return new Date().toISOString().slice(0, 10);
  }
}

function blocksToReservableText(blocks) {
  const arr = Array.isArray(blocks) ? blocks : [];
  const windows = arr
    .filter((b) => b && String(b.status || "") === "이용가능")
    .map((b) => {
      const s = String(b.start || "").trim();
      const e = String(b.end || "").trim();
      if (!s || !e) return null;
      return `${s}~${e}`;
    })
    .filter(Boolean);

  if (!windows.length) return "-";
  return windows.slice(0, 12).join(" | ") + (windows.length > 12 ? " | ..." : "");
}

function fallbackRoomIdFromIndex(room) {
  const idx = room && room.index != null ? Number(room.index) : NaN;
  if (!Number.isFinite(idx)) return null;
  if (idx === 4) return 52;
  return 14 + idx;
}

function minuteToTimeLabel(minute) {
  const m = Number(minute);
  if (!Number.isFinite(m)) return "";
  const mm = ((m % 1440) + 1440) % 1440;
  const hh = String(Math.floor(mm / 60)).padStart(2, "0");
  const mi = String(mm % 60).padStart(2, "0");
  return `${hh}:${mi}`;
}

function timeLabelToMinute(label) {
  const s = String(label || "").trim();
  const m = s.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return NaN;
  const hh = Number(m[1]);
  const mi = Number(m[2]);
  if (!Number.isFinite(hh) || !Number.isFinite(mi)) return NaN;
  return hh * 60 + mi;
}

function buildDerivedStartEndMapFromSlots(room) {
  const slots = room && Array.isArray(room.slots) ? room.slots : [];
  if (!slots.length) return null;

  const normSlots = slots
    .map((s) => {
      if (!s) return null;
      const startMinute = Number(s.startMinute);
      const endMinute = Number(s.endMinute);
      if (!Number.isFinite(startMinute) || !Number.isFinite(endMinute)) return null;
      return {
        status: String(s.status || ""),
        startMinute,
        endMinute
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.startMinute - b.startMinute);

  if (!normSlots.length) return null;

  const slotByStart = new Map(normSlots.map((s) => [s.startMinute, s]));

  const map = {};

  function isIntervalAvailable(begin, end) {
    const stepMin = 10;
    for (let t = begin; t < end; t += stepMin) {
      const slot = slotByStart.get(t);
      if (!slot || slot.status !== "이용가능") {
        return false;
      }
    }
    return true;
  }

  const durations = [60, 120, 180];
  for (let begin = 0; begin <= 1380; begin += 60) {
    const ends = [];
    for (const dur of durations) {
      const end = begin + dur;
      if (end > 1440) continue;
      if (isIntervalAvailable(begin, end)) {
        ends.push(minuteToTimeLabel(end));
      }
    }
    if (ends.length) {
      map[minuteToTimeLabel(begin)] = ends;
    }
  }

  return Object.keys(map).length ? map : null;
}

function buildDerivedStartEndMapFromBlocks(room) {
  const blocks = room && Array.isArray(room.blocks) ? room.blocks : [];
  if (!blocks.length) return null;

  const asMinutes = blocks
    .filter((b) => b && String(b.status || "") === "이용가능")
    .map((b) => {
      const start = timeLabelToMinute(b.start);
      const end = timeLabelToMinute(b.end);
      if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
      return { start, end };
    })
    .filter(Boolean);

  if (!asMinutes.length) return null;
  const map = {};
  const durations = [60, 120, 180];

  function isCovered(begin, end) {
    return asMinutes.some((w) => begin >= w.start && end <= w.end);
  }

  for (let begin = 0; begin <= 1380; begin += 60) {
    const ends = [];
    for (const dur of durations) {
      const end = begin + dur;
      if (end > 1440) continue;
      if (isCovered(begin, end)) {
        ends.push(minuteToTimeLabel(end));
      }
    }
    if (ends.length) {
      map[minuteToTimeLabel(begin)] = ends;
    }
  }

  return Object.keys(map).length ? map : null;
}

function getStoredLogin() {
  try {
    const isLoggedIn = sessionStorage.getItem("cau_logged_in");
    const id = sessionStorage.getItem("cau_login_id");
    const password = sessionStorage.getItem("cau_login_password");
    if (isLoggedIn !== "true" || !id || !password) return null;
    return { id, password };
  } catch (e) {
    return null;
  }
}

export default function DashboardPage() {
  const [stateData, setStateData] = useState(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [bookingStatus, setBookingStatus] = useState("");
  const [uiDateValue, setUiDateValue] = useState(todayKstDateValue());
  const [searchText, setSearchText] = useState("");
  const [showOnlyReservable, setShowOnlyReservable] = useState(true);
  const [activeRoom, setActiveRoom] = useState(null);
  const [beginTime, setBeginTime] = useState("");
  const [endTime, setEndTime] = useState("");
  const [members, setMembers] = useState([]);

  const pollingRef = useRef(null);
  const inFlightRunRef = useRef(false);
  const didInitialAutoRunRef = useRef(false);

  const rooms = useMemo(() => {
    const data = stateData && stateData.data ? stateData.data : null;
    return data && Array.isArray(data.rooms) ? data.rooms : [];
  }, [stateData]);

  const filteredRooms = useMemo(() => {
    const q = String(searchText || "").trim().toLowerCase();
    return (rooms || []).filter((room) => {
      if (!room) return false;

      if (showOnlyReservable) {
        const derived = blocksToReservableText(room.blocks);
        const t = String(room.reservableText || room.availableText || derived || "").trim();
        if (!t || t === "-" || t.includes("가능시간: -")) {
          return false;
        }
      }

      if (!q) return true;
      const derived = blocksToReservableText(room.blocks);
      const hay = `${room.name || ""} ${room.labelText || ""} ${room.reservableText || derived || ""}`.toLowerCase();
      return hay.includes(q);
    });
  }, [rooms, searchText, showOnlyReservable]);

  const dateValue = useMemo(() => {
    const fromState = stateData && stateData.data ? stateData.data.selectedDateValue : null;
    return uiDateValue || fromState || todayKstDateValue();
  }, [stateData, uiDateValue]);

  const selectedDateLabel = useMemo(() => {
    const data = stateData && stateData.data ? stateData.data : null;
    return (data && data.selectedDateLabel) || "";
  }, [stateData]);

  const userName = useMemo(() => {
    const data = stateData && stateData.data ? stateData.data : null;
    return (data && data.userName) ? String(data.userName) : "";
  }, [stateData]);

  const logsText = useMemo(() => {
    const logs = stateData && Array.isArray(stateData.logs) ? stateData.logs : [];
    const sliced = logs.slice(-200);
    return sliced.join("\n");
  }, [stateData]);

  const isRunning = !!(stateData && stateData.status === "running");
  const progress = Math.max(0, Math.min(100, Number(stateData && stateData.progress) || 0));
  const step = stateData && stateData.step ? String(stateData.step) : "";

  const shouldShowSkeleton = useMemo(() => {
    if (isRunning) return true;
    if (!stateData) return true;
    if (!rooms.length) return true;
    const data = stateData && stateData.data ? stateData.data : null;
    const selected = data && data.selectedDateValue ? String(data.selectedDateValue) : "";
    if (selected && uiDateValue && selected !== uiDateValue) return true;
    return false;
  }, [isRunning, stateData, rooms.length, uiDateValue]);

  function buildExternalUrl(room) {
    const roomId = room && room.roomId ? String(room.roomId) : (fallbackRoomIdFromIndex(room) ? String(fallbackRoomIdFromIndex(room)) : null);
    if (!roomId) return "#";
    const d = encodeURIComponent(String(dateValue));
    return `https://library.cau.ac.kr/library-services/room/team-rooms/${encodeURIComponent(roomId)}/${d}?tabIndex=2&hopeDate=${d}`;
  }

  function getRoomReservableText(room) {
    const derived = blocksToReservableText(room && room.blocks);
    const base = room ? (room.reservableText || room.availableText || derived) : derived;
    const t = String(base || "").trim();
    return t || "-";
  }

  async function fetchStateOnce() {
    const r = await fetch("/api/state", { cache: "no-store" });
    const j = await r.json().catch(() => ({}));
    setStateData(j);
    return j;
  }

  async function loadMembers() {
    const r = await fetch("/api/team-members", { cache: "no-store" });
    const j = await r.json().catch(() => ({}));
    if (j && j.ok && Array.isArray(j.members)) {
      setMembers(j.members);
    } else {
      setMembers([]);
    }
  }

  async function runScraper(overrideDateValue) {
    const login = getStoredLogin();
    if (!login) {
      window.location.href = "/login";
      return;
    }

    if (inFlightRunRef.current || isSubmitting || (stateData && stateData.status === "running")) {
      return;
    }

    inFlightRunRef.current = true;
    setIsSubmitting(true);
    try {
      const finalDateValue = overrideDateValue || dateValue;
      const resp = await fetch("/api/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: login.id, password: login.password, dateValue: finalDateValue })
      });
      const j = await resp.json().catch(() => ({}));
      if (!resp.ok || (j && j.ok === false)) {
        throw new Error((j && j.message) || "실행 요청 실패");
      }
      await fetchStateOnce();
    } catch (e) {
      alert(e && e.message ? String(e.message) : "실행 요청 실패");
    } finally {
      setIsSubmitting(false);
      inFlightRunRef.current = false;
    }
  }

  async function logout() {
    try {
      await fetch("/api/logout", { method: "POST" });
    } catch (e) {
      // ignore
    }
    sessionStorage.removeItem("cau_logged_in");
    sessionStorage.removeItem("cau_login_id");
    sessionStorage.removeItem("cau_login_password");
    window.location.href = "/login";
  }

  function openRoom(room) {
    setActiveRoom(room);
    setBeginTime("");
    setEndTime("");
    setBookingStatus("");
    document.body.classList.add("modal-open");
  }

  function closeRoom() {
    setActiveRoom(null);
    setBookingStatus("");
    document.body.classList.remove("modal-open");
  }

  const startEndMap = useMemo(() => {
    const derivedSlots = buildDerivedStartEndMapFromSlots(activeRoom);
    if (derivedSlots) {
      return derivedSlots;
    }

    const m = activeRoom && activeRoom.detail && activeRoom.detail.startEndMap ? activeRoom.detail.startEndMap : null;
    if (m && typeof m === "object") {
      return m;
    }

    const derivedBlocks = buildDerivedStartEndMapFromBlocks(activeRoom);
    if (derivedBlocks) {
      return derivedBlocks;
    }

    return {};
  }, [activeRoom]);

  const beginOptions = useMemo(() => {
    const keys = Object.keys(startEndMap || {});
    keys.sort();
    return keys;
  }, [startEndMap]);

  const endOptions = useMemo(() => {
    const arr = beginTime && startEndMap && Array.isArray(startEndMap[beginTime]) ? startEndMap[beginTime] : [];
    return arr;
  }, [startEndMap, beginTime]);

  useEffect(() => {
    if (!beginTime) {
      setEndTime("");
      return;
    }
    if (endOptions.length && (!endTime || !endOptions.includes(endTime))) {
      const prefer = startEndMap && Array.isArray(startEndMap[beginTime]) ? startEndMap[beginTime] : [];
      const beginMin = timeLabelToMinute(beginTime);
      const preferEnd = Number.isFinite(beginMin) ? minuteToTimeLabel(beginMin + 60) : "";
      if (preferEnd && prefer.includes(preferEnd)) {
        setEndTime(preferEnd);
      } else {
        setEndTime(endOptions[0]);
      }
    }
  }, [beginTime, endOptions, endTime]);

  useEffect(() => {
    if (!activeRoom) return;
    if (beginTime) return;
    if (!beginOptions.length) return;
    setBeginTime(beginOptions[0]);
  }, [activeRoom, beginOptions, beginTime]);

  async function submitBooking() {
    if (!activeRoom) return;
    if (!beginTime || !endTime) {
      alert("예약 시간을 선택해주세요.");
      return;
    }

    const resolvedRoomId = activeRoom && activeRoom.roomId ? String(activeRoom.roomId) : (fallbackRoomIdFromIndex(activeRoom) ? String(fallbackRoomIdFromIndex(activeRoom)) : null);

    const login = getStoredLogin();
    if (!login) {
      window.location.href = "/login";
      return;
    }

    setIsSubmitting(true);
    setBookingStatus("예약 신청 요청 중...");
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 60000);

      const resp = await fetch("/api/book", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          id: login.id,
          password: login.password,
          roomIndex: activeRoom.index,
          roomId: resolvedRoomId,
          dateValue,
          beginTime,
          endTime
        })
      });

      clearTimeout(timeoutId);
      const j = await resp.json().catch(() => ({}));
      if (!resp.ok || (j && j.ok === false)) {
        throw new Error((j && (j.message || j.error)) || "예약 신청 실패");
      }

      setBookingStatus("예약 신청이 접수되었습니다. (실제 완료 여부는 사이트 상태에 따라 다를 수 있음)");
      alert("예약 신청을 실행했습니다.");
      closeRoom();
    } catch (e) {
      const msg = e && e.name === "AbortError"
        ? "예약 신청이 지연되고 있습니다(60초 타임아웃). Worker가 실행 중인지 확인하세요."
        : (e && e.message ? String(e.message) : "예약 신청 실패");
      setBookingStatus(msg);
      alert(msg);
    } finally {
      setIsSubmitting(false);
    }
  }

  useEffect(() => {
    const login = getStoredLogin();
    if (!login) {
      window.location.href = "/login";
      return;
    }

    fetchStateOnce().catch(() => {});
    loadMembers().catch(() => {});

    pollingRef.current = setInterval(() => {
      fetchStateOnce().catch(() => {});
    }, 1200);

    return () => {
      if (pollingRef.current) {
        clearInterval(pollingRef.current);
        pollingRef.current = null;
      }
      document.body.classList.remove("modal-open");
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (didInitialAutoRunRef.current) {
      return;
    }
    if (!stateData) {
      return;
    }
    if (isRunning) {
      return;
    }

    const data = stateData && stateData.data ? stateData.data : null;
    const selected = data && data.selectedDateValue ? String(data.selectedDateValue) : "";
    if (selected && selected === uiDateValue && rooms.length) {
      didInitialAutoRunRef.current = true;
      return;
    }

    didInitialAutoRunRef.current = true;
    runScraper(uiDateValue);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stateData, uiDateValue, isRunning, rooms.length]);

  return (
    <>
      <header className="navbar">
        <div className="navbar-container">
          <div className="navbar-left">
            <a href="/dashboard" className="navbar-logo-link">
              <img className="navbar-logo" src="/images/cau-logo-kind.png" alt="중앙대학교 로고" />
            </a>
            <span className="navbar-title">팀플룸 조회 시스템</span>
          </div>
          <div className="navbar-right">
            <div style={{ color: "rgba(255, 255, 255, 0.9)", fontWeight: 700 }}>
              {userName ? userName : "-"}
            </div>
            <button className="ghost-button" type="button" onClick={logout} disabled={isSubmitting}>
              로그아웃
            </button>
          </div>
        </div>
      </header>

      <div className="page">
        <section className="panel">
          <div className="panel-head">
            <div>
              <h2>팀플룸 현재 크롤링 결과</h2>
              <p>{selectedDateLabel ? `선택 날짜: ${selectedDateLabel}` : `선택 날짜: ${dateValue}`}</p>
              <p>{step || (isRunning ? "실행중" : "대기중")}</p>
            </div>
            <div className="panel-actions">
              <input
                type="date"
                value={uiDateValue}
                onChange={(e) => {
                  const next = e.target.value;
                  setUiDateValue(next);
                  runScraper(next);
                }}
                style={{
                  height: 48,
                  padding: "0 14px",
                  borderRadius: 14,
                  border: "1px solid var(--line)",
                  background: "rgba(255, 255, 255, 0.85)",
                  fontWeight: 900,
                  color: "var(--text)"
                }}
                aria-label="날짜 선택"
              />
              <input
                type="text"
                value={searchText}
                onChange={(e) => setSearchText(e.target.value)}
                placeholder="룸 검색"
                style={{
                  height: 48,
                  padding: "0 14px",
                  borderRadius: 14,
                  border: "1px solid var(--line)",
                  background: "rgba(255, 255, 255, 0.85)",
                  fontWeight: 800,
                  color: "var(--text)",
                  minWidth: 160
                }}
                aria-label="룸 검색"
              />
              <button
                className="ghost-button"
                type="button"
                onClick={() => setShowOnlyReservable((v) => !v)}
                aria-pressed={showOnlyReservable}
              >
                {showOnlyReservable ? "예약가능만" : "전체"}
              </button>
              <button className="run-button" type="button" onClick={() => runScraper()} disabled={isSubmitting || isRunning}>
                {isRunning ? "실행중" : "크롤링하기"}
              </button>
              <button className="ghost-button" type="button" onClick={() => fetchStateOnce().catch(() => {})} disabled={isSubmitting}>
                상태 새로고침
              </button>
            </div>
          </div>

          <div className="timeline" aria-label="진행률">
            <div className="segment segment-available" style={{ flex: `0 0 ${progress}%` }} />
            <div className="segment segment-unknown" style={{ flex: `0 0 ${100 - progress}%` }} />
          </div>

          <div style={{ marginTop: 16 }} className="rooms-grid">
            {shouldShowSkeleton ? (
              Array.from({ length: 5 }).map((_, idx) => (
                <div key={idx} className="room-card skeleton-card">
                  <div className="room-head">
                    <div>
                      <div className="skeleton-line skeleton-title" />
                      <div className="skeleton-line skeleton-sub" />
                    </div>
                    <div className="skeleton-pill" />
                  </div>
                  <div className="skeleton-timeline" />
                  <div className="room-details">
                    <div className="skeleton-line" />
                    <div className="skeleton-line" />
                  </div>
                </div>
              ))
            ) : filteredRooms.length ? (
              filteredRooms.map((r) => (
                <div
                  key={String(r.index)}
                  className="room-card"
                  role="button"
                  tabIndex={0}
                  onClick={() => openRoom(r)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") openRoom(r);
                  }}
                >
                  <div className="room-head">
                    <div>
                      <h3>
                        {r.name || `팀플룸${Number(r.index) + 1}`}
                        {String(r.name || "").includes("팀플룸4") ? (
                          <span className="room-capacity-badge">6명 이상</span>
                        ) : null}
                      </h3>
                      <p>{r.labelText || "-"}</p>
                    </div>
                    <div className="room-badge">{getRoomReservableText(r) === "-" ? "-" : "가능"}</div>
                  </div>
                  <div style={{ color: "var(--sub)", fontSize: 13, lineHeight: 1.6 }}>
                    {getRoomReservableText(r) === "-" ? "가능시간: -" : `가능시간: ${getRoomReservableText(r)}`}
                  </div>
                  <div style={{ marginTop: 10, fontSize: 12, color: "var(--sub)" }}>
                    <a
                      href={buildExternalUrl(r)}
                      target="_blank"
                      rel="noreferrer"
                      style={{ color: "var(--accent)", textDecoration: "none" }}
                      onClick={(e) => e.stopPropagation()}
                    >
                      외부 예약 페이지 열기
                    </a>
                  </div>
                </div>
              ))
            ) : (
              <div className="empty-state">아직 수집된 팀플룸 데이터가 없습니다.</div>
            )}
          </div>
        </section>

        <section className="panel" style={{ marginTop: 18 }}>
          <div className="panel-head">
            <div>
              <h2>동반이용자 목록</h2>
              <p>예약 제출 시 자동으로 사용됩니다.</p>
            </div>
          </div>
          {members.length ? (
            <div style={{ display: "grid", gap: 8 }}>
              {members.map((m, idx) => (
                <div key={idx} style={{ display: "flex", justifyContent: "space-between", padding: "10px 12px", borderRadius: 14, background: "rgba(255,255,255,0.6)", border: "1px solid var(--line)" }}>
                  <strong>{m.name || "-"}</strong>
                  <span style={{ color: "var(--sub)", fontWeight: 700 }}>{m.studentId || "-"}</span>
                </div>
              ))}
            </div>
          ) : (
            <div style={{ color: "var(--sub)" }}>저장된 팀원 정보가 없습니다.</div>
          )}
        </section>

        <section className="panel" style={{ marginTop: 18 }}>
          <div className="panel-head">
            <div>
              <h2>실시간 로그</h2>
              <p>필요할 때만 아래에서 확인하세요.</p>
            </div>
          </div>
          <div className="log-box">{logsText || "로그가 아직 없습니다."}</div>
        </section>
      </div>

      {activeRoom ? (
        <div className="reservation-modal show" aria-hidden="false">
          <div className="reservation-backdrop" onClick={closeRoom} />
          <div className="reservation-sheet" role="dialog" aria-modal="true" aria-label="팀플룸 예약">
            <div className="reservation-head">
              <div>
                <div className="reservation-title">{activeRoom.name || "팀플룸 예약"}</div>
                <div className="reservation-sub">{activeRoom.labelText || "-"}</div>
              </div>
              <button type="button" className="reservation-close" onClick={closeRoom}>
                닫기
              </button>
            </div>

            <div className="reservation-body">
              <div className="reservation-section">
                <div className="reservation-section-title">예약정보</div>

                <div className="reservation-row">
                  <div className="reservation-label">예약일자</div>
                  <div className="reservation-value">{selectedDateLabel || dateValue || "-"}</div>
                </div>

                <div className="reservation-row reservation-time-row">
                  <div className="reservation-label">예약시간</div>
                  <div className="reservation-value">
                    <div className="reservation-time-grid">
                      <div>
                        <div className="reservation-sub-label">시작</div>
                        <select className="reservation-select" value={beginTime} onChange={(e) => setBeginTime(e.target.value)}>
                          <option value="">선택</option>
                          {beginOptions.map((t) => (
                            <option key={t} value={t}>
                              {t}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <div className="reservation-sub-label">종료</div>
                        <select className="reservation-select" value={endTime} onChange={(e) => setEndTime(e.target.value)} disabled={!beginTime}>
                          <option value="">선택</option>
                          {endOptions.map((t) => (
                            <option key={t} value={t}>
                              {t}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>
                  </div>
                </div>

                {bookingStatus ? (
                  <div className="reservation-row">
                    <div className="reservation-label">상태</div>
                    <div className="reservation-value" style={{ fontWeight: 700 }}>
                      {bookingStatus}
                    </div>
                  </div>
                ) : null}
              </div>

              <div className="reservation-actions">
                <button type="button" className="reservation-action secondary" onClick={closeRoom}>
                  취소
                </button>
                <button type="button" className="reservation-action primary" onClick={submitBooking} disabled={isSubmitting}>
                  신청
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
