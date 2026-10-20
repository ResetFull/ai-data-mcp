Option Explicit

If WScript.Arguments.Count <> 2 Then
    WScript.Quit 2
End If

Dim shell, fileSystem, pluginRoot, nodePath, entryPoint, command, exitCode
Set shell = CreateObject("WScript.Shell")
Set fileSystem = CreateObject("Scripting.FileSystemObject")

pluginRoot = fileSystem.GetParentFolderName(fileSystem.GetParentFolderName(WScript.ScriptFullName))
nodePath = WScript.Arguments(0)
entryPoint = WScript.Arguments(1)
shell.CurrentDirectory = pluginRoot
command = QuoteArgument(nodePath) & " " & QuoteArgument(entryPoint) & " --transport=http"
exitCode = shell.Run(command, 0, True)
WScript.Quit exitCode

Function QuoteArgument(value)
    QuoteArgument = Chr(34) & Replace(value, Chr(34), Chr(34) & Chr(34)) & Chr(34)
End Function
