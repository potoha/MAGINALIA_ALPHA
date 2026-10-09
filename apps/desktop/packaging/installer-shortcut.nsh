!include "nsDialogs.nsh"
!include "LogicLib.nsh"

!ifndef BUILD_UNINSTALLER
Var MAGINALIA_DESKTOP_SHORTCUT_CHECKBOX
Var MAGINALIA_DESKTOP_SHORTCUT_STATE

!macro customPageAfterChangeDir
  !define MUI_PAGE_HEADER_TEXT "ショートカットを選ぶ"
  !define MUI_PAGE_HEADER_SUBTEXT "デスクトップにもアイコンを置くか選べます。"
  Page custom MAGINALIA_DesktopShortcutPageCreate MAGINALIA_DesktopShortcutPageLeave
  !undef MUI_PAGE_HEADER_TEXT
  !undef MUI_PAGE_HEADER_SUBTEXT
!macroend

Function MAGINALIA_DesktopShortcutPageCreate
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}
  ${NSD_CreateCheckbox} 0 0 100% 12u "デスクトップにもショートカットを作る"
  Pop $MAGINALIA_DESKTOP_SHORTCUT_CHECKBOX
  ${NSD_Uncheck} $MAGINALIA_DESKTOP_SHORTCUT_CHECKBOX
  nsDialogs::Show
FunctionEnd

Function MAGINALIA_DesktopShortcutPageLeave
  ${NSD_GetState} $MAGINALIA_DESKTOP_SHORTCUT_CHECKBOX $MAGINALIA_DESKTOP_SHORTCUT_STATE
FunctionEnd
!endif

!macro customInstall
  ${If} $MAGINALIA_DESKTOP_SHORTCUT_STATE == ${BST_CHECKED}
    IfFileExists "$DESKTOP\MAGINALIA desktop α1.lnk" MAGINALIA_DesktopShortcutConflict
    CreateShortCut "$DESKTOP\MAGINALIA desktop α1.lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
    Goto MAGINALIA_DesktopShortcutDone
    MAGINALIA_DesktopShortcutConflict:
      MessageBox MB_ICONEXCLAMATION|MB_OK "同じ名前のショートカットがあるため、デスクトップには追加しませんでした。"
    MAGINALIA_DesktopShortcutDone:
  ${EndIf}
!macroend
