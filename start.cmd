@echo off
setlocal
set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not exist "%NODE_EXE%" set "NODE_EXE=%ProgramFiles(x86)%\nodejs\node.exe"
if not exist "%NODE_EXE%" (
  echo Node.js was not found. Please install it from https://nodejs.org/ and reopen your terminal.
  exit /b 1
)
if "%PORT%"=="" set "PORT=3000"
"%NODE_EXE%" server.js
