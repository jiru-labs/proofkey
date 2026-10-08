' Runs the typing-latency runner with no window at all: run.vbs <plan name>
Option Explicit
Dim sh, base, plan
Set sh = CreateObject("WScript.Shell")
base = sh.ExpandEnvironmentStrings("%LOCALAPPDATA%\pk-test\")
plan = WScript.Arguments(0)
sh.Run """" & base & "node\node-v24.21.0-win-x64\node.exe"" """ & base & "runner\runner.mjs"" """ & base & "runner\plan-" & plan & ".json""", 0, False
