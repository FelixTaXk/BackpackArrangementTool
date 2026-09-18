@echo off
setlocal
cd /d "%~dp0"

echo ============================================================
echo  BackpackArrangementTool - One-click publish to GitHub Pages
echo  Target: https://felixtaxk.github.io/BackpackArrangementTool/
echo ============================================================
echo.

:: 1) Make sure we are inside the git repo
git rev-parse --is-inside-work-tree >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Not a git repository. Run this bat in the project root.
  goto :done
)

:: 2) Show what will be published
echo [1/4] Changes to be published:
git status -s
echo.

:: 2.5) Stamp local asset URLs with their content hash.
::      GitHub Pages serves everything with Cache-Control: max-age=600, so a plain
::      reload can keep running the OLD js for ~10 min even after a successful deploy.
::      A changed file gets a new URL (?v=<hash>) -> browser/proxy must re-download it.
echo [2/4] Stamping asset versions in index.html (?v=content-hash)...
where node >nul 2>nul
if errorlevel 1 (
  echo        [WARN] Node.js not found in PATH - stamp skipped.
  echo               Site still deploys, but browsers may keep stale js for ~10 min.
) else (
  node "%~dp0scripts\stamp-assets.mjs"
  if errorlevel 1 echo        [WARN] stamp step reported a problem - keeping existing stamps.
)
echo.

:: 3) Stage everything (.gitignore already excludes .workbuddy/)
git add -A

:: 4) Commit only if there is something staged
git diff --cached --quiet
if errorlevel 1 (
  echo [3/4] Staged changes found, committing...
  git commit -q -m "deploy: auto-publish via publish-to-github.bat"
  if errorlevel 1 (
    echo [ERROR] Commit failed. Check git user.name / user.email config.
    goto :done
  )
  echo        Committed.
) else (
  echo [3/4] No new changes, skip commit.
)

:: 5) Push -> GitHub Pages auto-redeploys from the master branch
echo [4/4] Pushing to origin/master (triggers GitHub Pages rebuild)...
git push origin master
if errorlevel 1 (
  echo [ERROR] Push failed. Check: (1) internet connection; (2) GitHub credentials; (3) write access to the repo.
  goto :done
)

echo.
echo ============================================================
echo  DONE. GitHub Pages usually updates within ~1 minute:
echo  https://felixtaxk.github.io/BackpackArrangementTool/
echo ============================================================
:done
pause
