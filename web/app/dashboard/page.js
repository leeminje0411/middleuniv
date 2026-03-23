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

function EverytimeTimetablePreview({ courses }) {
  const dayLabels = ["월", "화", "수", "목", "금", "토", "일"];

  const meetings = (Array.isArray(courses) ? courses : []).flatMap((c) =>
    (c && Array.isArray(c.meetings) ? c.meetings : []).map((m) => ({
      courseName: c.course_name,
      instructorName: c.instructor_name,
      locationText: c.location_text,
      colorKey: c.color_key,
      ...m
    }))
  );

  let minStart = 24 * 60;
  let maxEnd = 0;
  for (const m of meetings) {
    if (m && typeof m.start_minute === "number") minStart = Math.min(minStart, m.start_minute);
    if (m && typeof m.end_minute === "number") maxEnd = Math.max(maxEnd, m.end_minute);
  }
  if (!Number.isFinite(minStart)) minStart = 0;
  if (!Number.isFinite(maxEnd) || maxEnd <= minStart) {
    minStart = 9 * 60;
    maxEnd = 18 * 60;
  }

  const viewStart = Math.max(0, Math.floor((minStart - 60) / 60) * 60);
  const viewEnd = Math.min(24 * 60, Math.ceil((maxEnd + 60) / 60) * 60);
  const totalMinutes = Math.max(60, viewEnd - viewStart);
  const minutePx = 1.2;
  const colWidth = 108;
  const timeColWidth = 64;
  const height = Math.max(420, Math.round(totalMinutes * minutePx));

  const palette = {
    color1: "rgba(93, 141, 252, 0.22)",
    color2: "rgba(252, 201, 60, 0.20)",
    color3: "rgba(95, 211, 160, 0.22)",
    color4: "rgba(236, 126, 162, 0.18)",
    color5: "rgba(172, 129, 255, 0.18)",
    color6: "rgba(96, 180, 255, 0.18)"
  };

  const hours = [];
  for (let t = viewStart; t <= viewEnd; t += 60) {
    const h = Math.floor(t / 60);
    hours.push({ minute: t, label: `${String(h).padStart(2, "0")}:00` });
  }

  return (
    <div className="eta-tt-wrap">
      <div className="eta-tt-head">
        <div className="eta-tt-cell time" style={{ width: timeColWidth }} />
        {dayLabels.slice(0, 5).map((d) => (
          <div key={d} className="eta-tt-cell day" style={{ width: colWidth }}>
            {d}
          </div>
        ))}
      </div>
      <div className="eta-tt-body" style={{ height }}>
        <div className="eta-tt-times" style={{ width: timeColWidth }}>
          {hours.map((h) => (
            <div key={h.minute} className="eta-tt-time" style={{ top: (h.minute - viewStart) * minutePx }}>
              {h.label}
            </div>
          ))}
        </div>
        <div className="eta-tt-grid" style={{ marginLeft: timeColWidth }}>
          {dayLabels.slice(0, 5).map((d, idx) => (
            <div key={d} className="eta-tt-col" style={{ left: idx * colWidth, width: colWidth }} />
          ))}
          {hours.map((h) => (
            <div key={h.minute} className="eta-tt-row" style={{ top: (h.minute - viewStart) * minutePx }} />
          ))}
          {meetings
            .filter((m) => m && typeof m.day_of_week === "number" && m.day_of_week >= 0 && m.day_of_week <= 4)
            .map((m, i) => {
              const top = (m.start_minute - viewStart) * minutePx;
              const heightPx = Math.max(22, (m.end_minute - m.start_minute) * minutePx);
              const left = m.day_of_week * colWidth;
              const bg = palette[m.colorKey] || "rgba(0,0,0,0.08)";
              return (
                <div
                  key={`${m.courseName}-${i}-${m.day_of_week}-${m.start_minute}`}
                  className="eta-tt-block"
                  style={{ top, height: heightPx, left, width: colWidth - 10, background: bg }}
                  title={`${m.courseName}${m.instructorName ? ` / ${m.instructorName}` : ""}${m.locationText ? ` / ${m.locationText}` : ""}`}
                >
                  <div className="eta-tt-name">{m.courseName}</div>
                  <div className="eta-tt-meta">
                    {m.instructorName ? m.instructorName : ""}
                    {m.locationText ? ` ${m.locationText}` : ""}
                  </div>
                </div>
              );
            })}
        </div>
      </div>
    </div>
  );
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
  const [newMemberName, setNewMemberName] = useState("");
  const [newMemberStudentId, setNewMemberStudentId] = useState("");
  const [memberBusy, setMemberBusy] = useState(false);
  const [showEverytimeConnect, setShowEverytimeConnect] = useState(false);
  const [everytimeLink, setEverytimeLink] = useState("");
  const [everytimeStep, setEverytimeStep] = useState("input");
  const [everytimeBusy, setEverytimeBusy] = useState(false);
  const [everytimeError, setEverytimeError] = useState("");
  const [everytimeParseResult, setEverytimeParseResult] = useState(null);
  const [everytimeSelectedTermUrl, setEverytimeSelectedTermUrl] = useState("");
  const [everytimePreview, setEverytimePreview] = useState(null);
  const [everytimePxPerHour, setEverytimePxPerHour] = useState(75);

  const pollingRef = useRef(null);
  const inFlightRunRef = useRef(false);
  const didInitialAutoRunRef = useRef(false);

  function connectEverytime() {
    setShowEverytimeConnect((v) => {
      const next = !v;
      if (next) {
        setEverytimeStep("input");
        setEverytimeBusy(false);
        setEverytimeError("");
        setEverytimeParseResult(null);
        setEverytimeSelectedTermUrl("");
        setEverytimePreview(null);
        setEverytimePxPerHour(75);
      }
      return next;
    });
  }

  function saveEverytimeLink(next) {
    const v = String(next || "").trim();
    setEverytimeLink(v);
    try {
      localStorage.setItem("cau_everytime_link", v);
    } catch (e) {
      // ignore
    }

    setShowEverytimeConnect(false);
  }

  async function parseEverytimeLink() {
    const login = getStoredLogin();
    if (!login || !login.id) {
      setEverytimeError("로그인이 필요합니다.");
      return;
    }

    const link = String(everytimeLink || "").trim();
    if (!link) {
      setEverytimeError("링크를 입력해주세요.");
      return;
    }

    setEverytimeBusy(true);
    setEverytimeError("");
    setEverytimeParseResult(null);
    setEverytimeSelectedTermUrl("");

    try {
      const res = await fetch("/api/everytime/parse", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-portal-login-id": login.id
        },
        body: JSON.stringify({ url: link }),
        cache: "no-store"
      });

      const data = await res.json().catch(() => null);
      if (!res.ok || !data || !data.ok) {
        throw new Error((data && (data.message || data.error)) || "파싱 실패");
      }

      setEverytimeParseResult(data);
      const terms = data && Array.isArray(data.terms) ? data.terms : [];
      if (!terms.length) {
        const via = data && data.fetchedVia ? String(data.fetchedVia) : "";
        const finalUrl = data && data.finalUrl ? String(data.finalUrl) : "";
        throw new Error(
          `학기 목록을 찾지 못했습니다. (via=${via || "-"}) ${finalUrl ? `finalUrl=${finalUrl}` : ""}`.trim()
        );
      }
      const active = terms.find((t) => t && t.isCurrent && t.url) || terms[0];
      if (active && active.url) {
        setEverytimeSelectedTermUrl(String(active.url));
      }
      setEverytimeStep("choose");
    } catch (err) {
      setEverytimeError(err && err.message ? String(err.message) : String(err));
    } finally {
      setEverytimeBusy(false);
    }
  }

  async function previewEverytimeSelectedTerm() {
    const login = getStoredLogin();
    if (!login || !login.id) {
      setEverytimeError("로그인이 필요합니다.");
      return;
    }

    const termUrl = String(everytimeSelectedTermUrl || "").trim();
    if (!termUrl) {
      setEverytimeError("미리볼 학기를 선택해주세요.");
      return;
    }

    setEverytimeBusy(true);
    setEverytimeError("");
    setEverytimePreview(null);

    try {
      const res = await fetch("/api/everytime/preview-term", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-portal-login-id": login.id
        },
        body: JSON.stringify({ termUrl, pxPerHour: everytimePxPerHour }),
        cache: "no-store"
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data || !data.ok) {
        throw new Error((data && (data.message || data.error)) || "미리보기 실패");
      }

      const courses = data && Array.isArray(data.courses) ? data.courses : [];
      if (!courses.length) {
        throw new Error(`시간표 데이터를 찾지 못했습니다. (via=${data && data.fetchedVia ? data.fetchedVia : "-"})`);
      }

      setEverytimePreview(data);
      setEverytimeStep("preview");
    } catch (err) {
      setEverytimeError(err && err.message ? String(err.message) : String(err));
    } finally {
      setEverytimeBusy(false);
    }
  }

  async function syncEverytimeSelectedTerm() {
    const login = getStoredLogin();
    if (!login || !login.id) {
      setEverytimeError("로그인이 필요합니다.");
      return;
    }

    const termUrl = String(everytimeSelectedTermUrl || "").trim();
    if (!termUrl) {
      setEverytimeError("저장할 학기를 선택해주세요.");
      return;
    }

    setEverytimeBusy(true);
    setEverytimeError("");

    try {
      const res = await fetch("/api/everytime/sync-term", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-portal-login-id": login.id
        },
        body: JSON.stringify({ termUrl, profileUrl: everytimeLink, pxPerHour: everytimePxPerHour }),
        cache: "no-store"
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data || !data.ok) {
        throw new Error((data && (data.message || data.error)) || "저장 실패");
      }

      saveEverytimeLink(everytimeLink);
    } catch (err) {
      setEverytimeError(err && err.message ? String(err.message) : String(err));
    } finally {
      setEverytimeBusy(false);
    }
  }

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
    const login = getStoredLogin();
    if (!login) {
      setMembers([]);
      return;
    }

    const r = await fetch("/api/team-members", {
      cache: "no-store",
      headers: {
        "x-portal-login-id": String(login.id)
      }
    });
    const j = await r.json().catch(() => ({}));
    if (j && j.ok && Array.isArray(j.members)) {
      setMembers(j.members);
    } else {
      setMembers([]);
    }
  }

  async function addMember() {
    const login = getStoredLogin();
    if (!login) {
      window.location.href = "/login";
      return;
    }

    const name = String(newMemberName || "").trim();
    const studentId = String(newMemberStudentId || "").trim();
    if (!name || !studentId) return;

    setMemberBusy(true);
    try {
      const r = await fetch("/api/team-members", {
        method: "POST",
        cache: "no-store",
        headers: {
          "Content-Type": "application/json",
          "x-portal-login-id": String(login.id)
        },
        body: JSON.stringify({ name, studentId })
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || (j && j.ok === false)) {
        return;
      }
      setNewMemberName("");
      setNewMemberStudentId("");
      if (j && Array.isArray(j.members)) setMembers(j.members);
      else await loadMembers();
    } finally {
      setMemberBusy(false);
    }
  }

  async function deleteMember(studentId) {
    const login = getStoredLogin();
    if (!login) {
      window.location.href = "/login";
      return;
    }

    const sid = String(studentId || "").trim();
    if (!sid) return;

    setMemberBusy(true);
    try {
      const r = await fetch("/api/team-members", {
        method: "DELETE",
        cache: "no-store",
        headers: {
          "Content-Type": "application/json",
          "x-portal-login-id": String(login.id)
        },
        body: JSON.stringify({ studentId: sid })
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || (j && j.ok === false)) {
        return;
      }
      if (j && Array.isArray(j.members)) setMembers(j.members);
      else await loadMembers();
    } finally {
      setMemberBusy(false);
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

    try {
      const saved = localStorage.getItem("cau_everytime_link");
      if (saved) setEverytimeLink(String(saved));
    } catch (e) {
      // ignore
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
    if (!showEverytimeConnect) return;

    function onKeyDown(e) {
      if (e.key === "Escape") {
        setShowEverytimeConnect(false);
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [showEverytimeConnect]);

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
            <button
              className="ghost-button"
              type="button"
              onClick={connectEverytime}
              disabled={isSubmitting}
              aria-expanded={showEverytimeConnect}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 8,
                color: "rgba(0, 0, 0, 0.78)",
                borderColor: "rgba(255, 255, 255, 0.85)",
                background: "rgba(255, 255, 255, 0.92)",
                boxShadow: "0 12px 26px rgba(0, 0, 0, 0.18)"
              }}
            >
              <img
                src="https://everytime.kr/images/new/nav.logo.png"
                alt="에브리타임"
                style={{ height: 16, width: "auto", display: "block" }}
              />
              에타 연동
            </button>
            <button className="ghost-button" type="button" onClick={logout} disabled={isSubmitting}>
              로그아웃
            </button>
          </div>
        </div>
      </header>

      {showEverytimeConnect ? (
        <div className="everytime-modal show" aria-hidden={false}>
          <div className="everytime-backdrop" onClick={() => setShowEverytimeConnect(false)} />
          <div className="everytime-sheet" role="dialog" aria-modal="true" aria-label="에타 연동">
            <div className="everytime-head">
              <div>
                <div className="everytime-title">에타 연동</div>
                <div className="everytime-sub">에브리타임 링크를 등록해주세요.</div>
              </div>
              <button type="button" className="everytime-close" onClick={() => setShowEverytimeConnect(false)}>
                닫기
              </button>
            </div>
            <div className="everytime-body">
              <div className="everytime-logo-wrap">
                <img className="everytime-logo" src="https://everytime.kr/images/new/nav.logo.png" alt="에브리타임" />
              </div>
              {everytimeStep === "input" ? (
                <div className="everytime-field">
                  <div className="everytime-label">에타 공개 링크</div>
                  <input
                    className="reservation-input everytime-input"
                    placeholder="https://everytime.kr/@..."
                    value={everytimeLink}
                    onChange={(e) => setEverytimeLink(e.target.value)}
                    disabled={everytimeBusy}
                  />
                  {everytimeError ? <div className="everytime-error">{everytimeError}</div> : null}
                  <div className="everytime-actions">
                    <button type="button" className="reservation-action secondary" onClick={() => setShowEverytimeConnect(false)} disabled={everytimeBusy}>
                      취소
                    </button>
                    <button type="button" className="reservation-action primary" onClick={() => parseEverytimeLink()} disabled={everytimeBusy}>
                      {everytimeBusy ? "파싱중..." : "파싱"}
                    </button>
                  </div>
                </div>
              ) : null}

              {everytimeStep === "choose" ? (
                <div className="everytime-field">
                  <div className="everytime-label">저장할 학기 선택</div>
                  <div className="everytime-debug">
                    {`via=${everytimeParseResult && everytimeParseResult.fetchedVia ? everytimeParseResult.fetchedVia : "-"}`} ·
                    {` terms=${everytimeParseResult && Array.isArray(everytimeParseResult.terms) ? everytimeParseResult.terms.length : 0}`}
                  </div>
                  <div className="everytime-terms">
                    {(everytimeParseResult && Array.isArray(everytimeParseResult.terms) ? everytimeParseResult.terms : []).map((t) => {
                      const label = t && t.label != null ? String(t.label) : "";
                      const url = t && t.url != null ? String(t.url) : "";
                      const isCurrent = Boolean(t && t.isCurrent);
                      return (
                        <label key={url || label} className="everytime-term">
                          <input
                            type="radio"
                            name="everytime-term"
                            value={url}
                            checked={everytimeSelectedTermUrl === url}
                            onChange={() => setEverytimeSelectedTermUrl(url)}
                            disabled={everytimeBusy}
                          />
                          <span className="everytime-term-label">{label || url}</span>
                          {isCurrent ? <span className="everytime-term-badge">현재</span> : null}
                        </label>
                      );
                    })}
                  </div>
                  {everytimeError ? <div className="everytime-error">{everytimeError}</div> : null}
                  <div className="everytime-actions">
                    <button
                      type="button"
                      className="reservation-action secondary"
                      onClick={() => {
                        setEverytimeStep("input");
                        setEverytimeError("");
                      }}
                      disabled={everytimeBusy}
                    >
                      뒤로
                    </button>
                    <button type="button" className="reservation-action primary" onClick={() => previewEverytimeSelectedTerm()} disabled={everytimeBusy}>
                      {everytimeBusy ? "불러오는중..." : "미리보기"}
                    </button>
                  </div>
                </div>
              ) : null}

              {everytimeStep === "preview" ? (
                <div className="everytime-field">
                  <div className="everytime-label">시간표 미리보기</div>
                  <div className="everytime-scale">
                    <div className="everytime-scale-top">
                      <div className="everytime-scale-label">시간 스케일(정확도 보정)</div>
                      <div className="everytime-scale-value">{everytimePxPerHour}px/시간</div>
                    </div>
                    <input
                      type="range"
                      min={55}
                      max={95}
                      step={1}
                      value={everytimePxPerHour}
                      onChange={(e) => setEverytimePxPerHour(Number(e.target.value))}
                      disabled={everytimeBusy}
                    />
                    <div className="everytime-scale-actions">
                      <button
                        type="button"
                        className="reservation-action secondary"
                        onClick={() => previewEverytimeSelectedTerm()}
                        disabled={everytimeBusy}
                      >
                        {everytimeBusy ? "계산중..." : "다시 계산"}
                      </button>
                    </div>
                  </div>
                  <div className="everytime-debug">
                    {`via=${everytimePreview && everytimePreview.fetchedVia ? everytimePreview.fetchedVia : "-"}`} ·
                    {` courses=${everytimePreview && Array.isArray(everytimePreview.courses) ? everytimePreview.courses.length : 0}`} ·
                    {` meetings=${everytimePreview && everytimePreview.meetingCount != null ? everytimePreview.meetingCount : 0}`}
                  </div>
                  <div className="everytime-preview">
                    <EverytimeTimetablePreview courses={everytimePreview && Array.isArray(everytimePreview.courses) ? everytimePreview.courses : []} />
                  </div>
                  {everytimeError ? <div className="everytime-error">{everytimeError}</div> : null}
                  <div className="everytime-actions">
                    <button
                      type="button"
                      className="reservation-action secondary"
                      onClick={() => {
                        setEverytimeStep("choose");
                        setEverytimeError("");
                      }}
                      disabled={everytimeBusy}
                    >
                      다시 선택
                    </button>
                    <button type="button" className="reservation-action primary" onClick={() => syncEverytimeSelectedTerm()} disabled={everytimeBusy}>
                      {everytimeBusy ? "저장중..." : "연동/저장"}
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}

      <div className="page">

        <div className="dashboard-two-col">
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

          <section className="panel">
            <div className="panel-head">
              <div>
                <h2>동반이용자 목록</h2>
                <p>예약 제출 시 자동으로 사용됩니다.</p>
              </div>
            </div>
            <div style={{ display: "grid", gap: 8, marginBottom: 10 }}>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr auto", gap: 8 }}>
                <input
                  className="reservation-input"
                  placeholder="이름"
                  value={newMemberName}
                  onChange={(e) => setNewMemberName(e.target.value)}
                  disabled={memberBusy}
                />
                <input
                  className="reservation-input"
                  placeholder="학번"
                  value={newMemberStudentId}
                  onChange={(e) => setNewMemberStudentId(e.target.value)}
                  disabled={memberBusy}
                />
                <button
                  type="button"
                  className="reservation-action secondary"
                  onClick={addMember}
                  disabled={memberBusy || !String(newMemberName || "").trim() || !String(newMemberStudentId || "").trim()}
                >
                  추가
                </button>
              </div>
            </div>
            {members.length ? (
              <div style={{ display: "grid", gap: 8 }}>
                {members.map((m, idx) => (
                  <div key={idx} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 12px", borderRadius: 14, background: "rgba(255,255,255,0.6)", border: "1px solid var(--line)" }}>
                    <div>
                      <strong>{m.name || "-"}</strong>
                      <div style={{ color: "var(--sub)", fontWeight: 700, fontSize: 12, marginTop: 2 }}>{m.studentId || "-"}</div>
                    </div>
                    <button
                      type="button"
                      className="reservation-action secondary"
                      onClick={() => deleteMember(m.studentId)}
                      disabled={memberBusy}
                      style={{ padding: "8px 10px" }}
                    >
                      삭제
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <div style={{ color: "var(--sub)" }}>저장된 팀원 정보가 없습니다.</div>
            )}
          </section>
        </div>

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

              <div className="reservation-section" style={{ marginTop: 14 }}>
                <div className="reservation-section-title">동반이용자</div>
                {members.length ? (
                  <div style={{ display: "grid", gap: 8 }}>
                    {members.map((m, idx) => (
                      <div key={idx} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 12px", borderRadius: 14, background: "rgba(255,255,255,0.6)", border: "1px solid var(--line)" }}>
                        <div>
                          <strong>{m.name || "-"}</strong>
                          <div style={{ color: "var(--sub)", fontWeight: 700, fontSize: 12, marginTop: 2 }}>{m.studentId || "-"}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div style={{ color: "var(--sub)" }}>저장된 팀원 정보가 없습니다.</div>
                )}
              </div>
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
      ) : null}
    </>
  );
}
