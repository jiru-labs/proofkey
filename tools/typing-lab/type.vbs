' Types test sentences into the window whose title contains WScript.Arguments(0),
' one key every 80 ms, 2 s pause between sentences. Re-activates the window
' before every word so keys never land in another app.
Option Explicit
Dim sh, title, sentences, s, i, ch, ok
Set sh = CreateObject("WScript.Shell")
title = WScript.Arguments(0)
sentences = Array( _
 "Ths is a sentnce with sevral erors that i wrote quikly. ", _
 "Yesterday we goed to the markt and buyed some aples. ", _
 "Their is a lot of things to do befor the meeting tomorow. ", _
 "She dont know were the documants are, and nether do I. ", _
 "The report have been sended to the cliant last weak. ", _
 "I recieved you're message and will anwser as soon as posible. ", _
 "Our team are working hardly to finnish the project on time. ", _
 "Please let me knew if their is anything else I can do. ")
For Each s In sentences
  For i = 1 To Len(s)
    ch = Mid(s, i, 1)
    If i = 1 Or ch = " " Then
      ok = sh.AppActivate(title)
      If Not ok Then WScript.Quit 2
    End If
    sh.SendKeys ch
    WScript.Sleep 80
  Next
  WScript.Sleep 2000
Next
WScript.Quit 0
