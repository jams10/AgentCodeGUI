; Custom NSIS include for AgentCodeGUI (merged by electron-builder).
; Registers a "AgentCodeGUI로 열기" right-click entry on folders and on the
; folder background, launching the app with that directory. Per-user (HKCU) so the
; installer needs no admin rights. Saved as UTF-8 with BOM so the Korean label
; survives the Unicode makensis compile.

; Expand the install/uninstall details list so the full progress log scrolls live
; (instead of just a progress bar). Inserted at global script scope.
!macro customHeader
  ShowInstDetails show
  ShowUninstDetails show
!macroend

!macro customInstall
  ; Right-click ON a folder (selected directory is passed as %V)
  WriteRegStr HKCU "Software\Classes\Directory\shell\AgentCodeGUI" "" "AgentCodeGUI로 열기"
  WriteRegStr HKCU "Software\Classes\Directory\shell\AgentCodeGUI" "Icon" "$INSTDIR\AgentCodeGUI.exe"
  WriteRegStr HKCU "Software\Classes\Directory\shell\AgentCodeGUI\command" "" '"$INSTDIR\AgentCodeGUI.exe" "%V"'

  ; Right-click on the BACKGROUND inside a folder (current directory is %V)
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\AgentCodeGUI" "" "AgentCodeGUI로 열기"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\AgentCodeGUI" "Icon" "$INSTDIR\AgentCodeGUI.exe"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\AgentCodeGUI\command" "" '"$INSTDIR\AgentCodeGUI.exe" "%V"'
!macroend

!macro customUnInstall
  DeleteRegKey HKCU "Software\Classes\Directory\shell\AgentCodeGUI"
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\AgentCodeGUI"
!macroend
