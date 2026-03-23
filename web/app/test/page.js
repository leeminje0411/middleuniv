"use client";

import { useState } from "react";

export default function EtaTestPage() {
  const [everytimeLink, setEverytimeLink] = useState("");
  const [parseResult, setParseResult] = useState(null);
  const [previewData, setPreviewData] = useState(null);
  const [pxPerHour, setPxPerHour] = useState(75);
  const [selectedTerm, setSelectedTerm] = useState("");
  const [debugLog, setDebugLog] = useState("");

  const parseEverytimeLink = async () => {
    try {
      console.log("Parsing link:", everytimeLink);
      setDebugLog(`Parsing link: ${everytimeLink}`);
      const response = await fetch("/api/everytime/parse", {
        method: "POST",
        headers: { 
          "Content-Type": "application/json",
          "x-portal-login-id": "dummy-id"
        },
        body: JSON.stringify({ url: everytimeLink }),
      });
      const data = await response.json();
      console.log("Parse result:", data);
      setDebugLog(`Parse result: ${JSON.stringify(data, null, 2)}`);
      setParseResult(data);
      if (data.terms && data.terms.length > 0) {
        setSelectedTerm(data.terms[0].url); // Automatically select the first term
      }
    } catch (error) {
      console.error("Error parsing link:", error);
      setDebugLog(`Error parsing link: ${error.message}`);
    }
  };

  const previewEverytimeSelectedTerm = async (termUrl) => {
    if (!termUrl) {
      console.error("No termUrl provided");
      setDebugLog("No termUrl provided");
      return;
    }
    try {
      console.log("Mapping term:", termUrl);
      setDebugLog(`Mapping term: ${termUrl}`);
      const requestPayload = {
        termLabel: parseResult.terms.find((term) => term.url === termUrl)?.label,
        courses: parseResult.courses,
      };
      console.log("Request Payload:", requestPayload);
      const response = await fetch("/api/everytime/map-term", {
        method: "POST",
        headers: { 
          "Content-Type": "application/json",
          "x-portal-login-id": "dummy-id"
        },
        body: JSON.stringify(requestPayload),
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error("Error Response:", errorText);
        setDebugLog(`Error Response: ${errorText}`);
        return;
      }

      const data = await response.json();
      console.log("Mapped Courses:", data.mappedCourses);
      setDebugLog(`Mapped Courses: ${JSON.stringify(data.mappedCourses, null, 2)}`);
      setPreviewData({ ...previewData, courses: data.mappedCourses });
    } catch (error) {
      console.error("Error mapping term:", error);
      setDebugLog(`Error mapping term: ${error.message}`);
    }
  };

  const syncEverytimeSelectedTerm = async () => {
    try {
      console.log("Syncing term:", selectedTerm);
      setDebugLog(`Syncing term: ${selectedTerm}`);
      const response = await fetch("/api/everytime/sync-term", {
        method: "POST",
        headers: { 
          "Content-Type": "application/json",
          "x-portal-login-id": "dummy-id"
        },
        body: JSON.stringify({
          termUrl: selectedTerm,
          courses: previewData.courses.filter((course) => course.mapped), // Only mapped courses
        }),
      });
      const result = await response.json();
      if (result.success) {
        alert("저장 성공!");
        setDebugLog("Sync successful!");
      } else {
        alert("저장 실패!");
        setDebugLog("Sync failed!");
      }
    } catch (error) {
      console.error("Error syncing term:", error);
      setDebugLog(`Error syncing term: ${error.message}`);
    }
  };

  return (
    <div>
      <h1>에타 연동 테스트 페이지</h1>
      <div>
        <input
          type="text"
          value={everytimeLink}
          onChange={(e) => setEverytimeLink(e.target.value)}
          placeholder="에타 링크를 입력하세요"
        />
        <button onClick={parseEverytimeLink}>파싱</button>
      </div>
      {parseResult && (
        <div>
          <h2>학기 선택</h2>
          <select onChange={(e) => setSelectedTerm(e.target.value)} value={selectedTerm}>
            {parseResult.terms.map((term) => (
              <option key={term.url} value={term.url}>
                {term.label}
              </option>
            ))}
          </select>
          <button onClick={() => previewEverytimeSelectedTerm(selectedTerm)}>미리보기</button>
        </div>
      )}
      {previewData && (
        <div>
          <h2>미리보기</h2>
          <div>
            <h3>매핑 성공 과목</h3>
            {previewData.courses
              .filter((course) => course.mapped)
              .map((course, index) => (
                <div key={index}>
                  <p>{course.course_name} - {course.instructor_name}</p>
                </div>
              ))}
          </div>
          <div>
            <h3>매핑 실패 과목</h3>
            {previewData.courses
              .filter((course) => !course.mapped)
              .map((course, index) => (
                <div key={index}>
                  <p>{course.course_name} - {course.instructor_name}</p>
                  <p>⚠️ 매핑 실패: 임시 시간 사용</p>
                </div>
              ))}
          </div>
          <h2>미리보기 시간표</h2>
          <div className="timetable">
            {previewData.courses.map((course, index) => (
              <div key={index} className="course-block">
                <h3>{course.course_name}</h3>
                <p>{course.instructor_name}</p>
                {course.meetings.map((meeting, idx) => (
                  <div
                    key={idx}
                    className="meeting-block"
                    style={{
                      gridColumn: meeting.day_of_week + 1, // 요일별 컬럼 (0=일요일, 1=월요일, ...)
                      gridRowStart: Math.floor(meeting.start_minute / 60) + 1, // 시작 시간
                      gridRowEnd: Math.floor(meeting.end_minute / 60) + 1, // 종료 시간
                    }}
                  >
                    <p>{`시작: ${Math.floor(meeting.start_minute / 60)}:00`}</p>
                    <p>{`종료: ${Math.floor(meeting.end_minute / 60)}:00`}</p>
                  </div>
                ))}
              </div>
            ))}
          </div>
          <button onClick={syncEverytimeSelectedTerm}>저장</button>
        </div>
      )}
      <div>
        <h2>디버깅 로그</h2>
        <pre>{debugLog}</pre>
      </div>
    </div>
  );
}