' Runs several plans one after another, hidden: runall.vbs <plan> <plan> ...
Option Explicit
Dim sh, base, i
Set sh = CreateObject("WScript.Shell")
base = sh.ExpandEnvironmentStrings("%LOCALAPPDATA%\pk-test\")
For i = 0 To WScript.Arguments.Count - 1
  sh.Run """" & base & "node\node-v24.21.0-win-x64\node.exe"" """ & base & "runner\runner.mjs"" """ & base & "runner\plan-" & WScript.Arguments(i) & ".json""", 0, True
Next
