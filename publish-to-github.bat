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
echo [1/3] Changes to be published:
git status -s
echo.

:: 3) Stage everything (.gitignore already excludes .workbuddy/)
git add -A

:: 4) Commit only if there is something staged
git diff --cached --quiet
if errorlevel 1 (
  echo [2/3] Staged changes found, committing...
  git commit -q -m "deploy: auto-publish via publish-to-github.bat"
  if errorlevel 1 (
    echo [ERROR] Commit failed. Check git user.name / user.email config.
    goto :done
  )
  echo        Committed.
) else (
  echo [2/3] No new changes, skip commit.
)

:: 5) Push -> GitHub Pages auto-redeploys from the master branch
echo [3/3] Pushing to origin/master (triggers GitHub Pages rebuild)...
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
