const path = require("path");
const {
  runTeamTodayScraper
} = require("./scraper/teamTodayScraper");

async function main() {

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
    headless: false
  });

  console.log("");
  console.log("========================================");
  console.log("최종 결과");
  console.log("========================================");
  console.log(`OUT_DIR        : ${result.outDir}`);
  console.log(`LIVE JSON      : ${result.liveJsonPath}`);
  console.log(`FINAL JSON     : ${result.finalJsonPath}`);
  console.log(`FINAL MD       : ${result.finalMdPath}`);
  console.log("");
  console.log("먼저 볼 파일:");
  console.log(`cat "${result.finalMdPath}"`);
  console.log("");
  console.log("JSON 확인:");
  console.log(`cat "${result.finalJsonPath}"`);
}

main().catch((err) => {
  console.error("\n[에러]");
  console.error(err && err.message ? err.message : err);
  process.exit(1);
});